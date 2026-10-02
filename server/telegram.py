"""Public archive API and bounded HTTP media relay from the private Telegram group."""
from __future__ import annotations
import asyncio
import logging
import os
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import Response, StreamingResponse
from .mirror import MirrorStore, configuration, error_label
from .notifications import notify, configure_topic
from .streaming import parse_range, media_headers, telegram_chunks, RangeNotSatisfiable, media_file_info

router = APIRouter()
log = logging.getLogger(__name__)
_client = None
_store = None
_destination = None
_slots = asyncio.Semaphore(8)
_reconnect_lock = asyncio.Lock()


_config = None
_recovery_task = None
_last_error = None
_closing = False
_CONNECT_TIMEOUT = 20
_RETRY_DELAY = 5


def archive_enabled():
    return (_store is not None and _client is not None and _destination is not None
            and getattr(_client, "is_connected", lambda: True)())


def archive_status():
    archive_ready = _store is not None and bool(_store.meta("source"))
    media_ready = bool(archive_enabled())
    return {"status": "ok" if archive_ready and media_ready else "degraded" if archive_ready else "unavailable",
            "archiveEnabled": _store is not None, "archiveReady": archive_ready,
            "mediaReady": media_ready, "error": _last_error}


async def _disconnect(client):
    if client is not None:
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except Exception:
            log.warning("Telegram client cleanup did not complete")


async def _connect_client():
    global _client, _destination, _last_error
    async with _reconnect_lock:
        if _closing or not _config or archive_enabled():
            return bool(archive_enabled())
        client = None
        try:
            from telethon import TelegramClient
            from telethon.sessions import MemorySession
            # Never reuse a disk auth key copied between local and VPS instances.
            await _disconnect(_client)
            _client, _destination = None, None
            client = TelegramClient(MemorySession(), _config["api_id"], _config["api_hash"],
                                    flood_sleep_threshold=0, connection_retries=2,
                                    request_retries=2, retry_delay=1, timeout=10)
            async def initialize():
                await client.start(bot_token=_config["bot_token"])
                me = await client.get_me()
                if not me or not me.bot:
                    raise RuntimeError("The streaming session must belong to a bot")
                return await client.get_input_entity(_config["destination"])
            destination = await asyncio.wait_for(initialize(), timeout=_CONNECT_TIMEOUT)
        except asyncio.CancelledError:
            await _disconnect(client)
            raise
        except Exception as exc:
            await _disconnect(client)
            _last_error = error_label(exc)
            log.error("Telegram media unavailable (%s); automatic recovery will retry", _last_error)
            await notify("Archive connection failed", _last_error, severity="critical")
            return False
        recovered = _last_error is not None
        _client, _destination, _last_error = client, destination, None
        log.info("Telegram media connection ready")
        asyncio.create_task(notify("Archive connection recovered" if recovered else "Archive service started"))
        return True


async def _supervise():
    delay = _RETRY_DELAY
    while not _closing:
        await asyncio.sleep(delay)
        if archive_enabled():
            delay = _RETRY_DELAY
            continue
        try:
            ready = await _connect_client()
        except Exception as exc:
            log.error("Telegram recovery failed (%s); retrying", error_label(exc))
            await notify("Archive recovery failed", error_label(exc), severity="critical")
            ready = False
        delay = _RETRY_DELAY if ready else min(60, delay * 2)


async def start_telegram():
    os.umask(0o077)
    global _store, _config, _recovery_task, _last_error, _closing
    _closing = False
    try:
        _config = configuration()
    except Exception as exc:
        _last_error = error_label(exc)
        await notify("Archive startup failed", _last_error, severity="critical")
        raise
    if not _config:
        _last_error = "MissingTelegramConfiguration"
        log.error("Telegram archive configuration is incomplete")
        await notify("Archive startup failed", _last_error, severity="critical")
        return
    # The durable archive does not depend on a live Telegram connection.
    try:
        store = MirrorStore(_config["database"])
        identity = store.meta("identity")
        if identity and identity["destination"] != str(_config["destination"]):
            store.close()
            raise RuntimeError("Configured storage group differs from archive mapping")
        _store = store
        await configure_topic(store)
    except Exception as exc:
        _last_error = error_label(exc)
        log.error("Archive database startup failed (%s)", _last_error)
        await notify("Archive startup failed", _last_error, severity="critical")
        raise
    await _connect_client()
    _recovery_task = asyncio.create_task(_supervise())


async def stop_telegram():
    global _client, _store, _destination, _config, _recovery_task, _closing
    _closing = True
    if _recovery_task is not None:
        _recovery_task.cancel()
        try:
            await _recovery_task
        except asyncio.CancelledError:
            pass
        _recovery_task = None
    await _disconnect(_client)
    if _store:
        _store.close()
    _client, _store, _destination, _config = None, None, None, None


@router.get("/api/archive")
async def archive():
    if not _store:
        raise HTTPException(503, "The hosted archive is not configured yet")
    data = _store.archive()
    if data is None:
        raise HTTPException(503, "The archive is waiting for its first import")
    return data


@router.api_route("/api/media/{source_id}", methods=["GET", "HEAD"])
async def media(source_id: int, request: Request):
    if source_id <= 0: raise HTTPException(404, "Media not found")
    if _store is None or _client is None or _destination is None:
        raise HTTPException(503, "Media connection is recovering", headers={"Retry-After": "5"})
    row = _store.row(source_id)
    if not row or row["status"] != "copied" or not row["destination_id"]:
        raise HTTPException(404, "Media not found")
    # No arbitrary peer/file requests; the private group and mapping stay server-side.
    try:
        await asyncio.wait_for(_slots.acquire(), timeout=5)
    except asyncio.TimeoutError:
        raise HTTPException(503, "Media service busy", headers={"Retry-After": "5"})
    handed_off = False
    try:
        async def fetch():
            global _client, _destination, _last_error
            client, destination = _client, _destination
            try:
                return await asyncio.wait_for(client.get_messages(destination, ids=row["destination_id"]), timeout=20)
            except Exception as exc:
                invalid_auth = exc.__class__.__name__ in {"AuthKeyDuplicatedError", "AuthKeyUnregisteredError", "SessionRevokedError", "SessionExpiredError"}
                if invalid_auth:
                    # Only invalidate the client that failed, never a newer recovered one.
                    async with _reconnect_lock:
                        if _client is client:
                            await _disconnect(client)
                            _client, _destination = None, None
                            _last_error = error_label(exc)
                    if not await _connect_client():
                        raise ConnectionError("Telegram authorization is recovering") from exc
                elif isinstance(exc, (ConnectionError, asyncio.TimeoutError)):
                    async with _reconnect_lock:
                        if _client is client and not client.is_connected():
                            await asyncio.wait_for(client.connect(), timeout=15)
                else:
                    raise
                if _client is None:
                    raise ConnectionError("Telegram connection is recovering")
                result = await asyncio.wait_for(_client.get_messages(_destination, ids=row["destination_id"]), timeout=20)
                asyncio.create_task(notify("Telegram media connection recovered"))
                return result
        message = await fetch()
        if not message or not message.file or message.file.size is None:
            raise HTTPException(404, "Stored media not found")
        _, _, size = media_file_info(message)
        # If-Range mismatch falls back to the whole representation.
        # File.id uses an obsolete Bot API packing helper that fails on modern photo sizes.
        # The native Photo/Document ID is stable and works for both representations.
        native_id = getattr(message.file.media, "id", row["destination_id"])
        etag = f'"tg-{source_id}-{native_id}-{size}"'
        range_header = request.headers.get("range")
        if request.headers.get("if-range") and request.headers["if-range"] != etag:
            range_header = None
        try:
            start, end, partial = parse_range(range_header, size)
        except RangeNotSatisfiable:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"})
        headers = media_headers(size, start, end, partial, message.file.mime_type, message.file.name)
        headers["ETag"] = etag
        status = 206 if partial else 200
        if request.method == "HEAD": return Response(status_code=status, headers=headers)
        async def body():
            try:
                async for chunk in telegram_chunks(_client, message, start, end, request.is_disconnected, fetch, get_client=lambda: _client):
                    yield chunk
            except Exception as exc:
                asyncio.create_task(notify("Media stream failed", f"Post #{source_id} · {exc.__class__.__name__}", severity="critical"))
                raise
            finally:
                _slots.release()
        handed_off = True
        return StreamingResponse(body(), status_code=status, headers=headers, media_type=None)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Stored Telegram media lookup failed (%s)", exc.__class__.__name__)
        asyncio.create_task(notify("Media delivery failed", f"Post #{source_id} · {exc.__class__.__name__}", severity="critical"))
        raise HTTPException(502, "Stored media is temporarily unavailable")
    finally:
        if not handed_off: _slots.release()

@router.post("/internal/events")
async def operator_event(request: Request):
    import secrets
    token=os.getenv("TELEGRAM_BOT_TOKEN","")
    if not token or not secrets.compare_digest(request.headers.get("authorization",""),f"Bearer {token}"):
        raise HTTPException(403,"Forbidden")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 2048: raise HTTPException(413, "Event too large")
    import json
    try: data=json.loads(raw)
    except ValueError: raise HTTPException(422,"Invalid event")
    if not isinstance(data,dict) or not isinstance(data.get("event"), str) or data.get("event") not in {"Account created","Email verified","OTP email delivery failed","Account request failed","Account service started","Account service startup failed","Account service fatal"}:
        raise HTTPException(422,"Unsupported event")
    severity = data.get("severity", "routine")
    if not isinstance(severity, str) or severity not in {"routine", "critical"} or (severity == "critical" and data["event"] not in {"OTP email delivery failed", "Account request failed", "Account service startup failed", "Account service fatal"}):
        raise HTTPException(422, "Unsupported event severity")
    if not isinstance(data.get("detail", ""), str) or len(data.get("detail", "")) > 200:
        raise HTTPException(422, "Invalid event detail")
    asyncio.create_task(notify(data["event"], data.get("detail", ""), cooldown=0 if data["event"] in {"Account created", "Email verified"} else 300, severity=severity))
    return {"ok":True}
