"""Public archive API and bounded HTTP media relay from the private Telegram group."""
from __future__ import annotations
import asyncio
import logging
import os
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import Response, StreamingResponse
from .mirror import MirrorStore, configuration
from .notifications import notify, configure_topic
from .streaming import parse_range, media_headers, telegram_chunks, RangeNotSatisfiable

router = APIRouter()
log = logging.getLogger(__name__)
_client = None
_store = None
_destination = None
_slots = asyncio.Semaphore(8)
_reconnect_lock = asyncio.Lock()


def archive_enabled():
    return _store is not None and _client is not None


async def start_telegram():
    os.umask(0o077)
    global _client, _store, _destination
    config = configuration()
    if not config:
        return
    from pathlib import Path
    from telethon import TelegramClient
    Path(config["bot_session"]).parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(config["bot_session"], config["api_id"], config["api_hash"], flood_sleep_threshold=0)
    store = None
    try:
        await client.start(bot_token=config["bot_token"])
        if not (await client.get_me()).bot:
            raise RuntimeError("The streaming session must belong to the configured bot")
        destination = await client.get_input_entity(config["destination"])
        store = MirrorStore(config["database"])
        identity = store.meta("identity")
        if identity and identity["destination"] != str(config["destination"]):
            raise RuntimeError("Configured storage group differs from archive mapping")
        _client, _store, _destination = client, store, destination
        await configure_topic(store)
        asyncio.create_task(notify("Archive service started"))
    except Exception as exc:
        _client, _store, _destination = None, None, None
        if store: store.close()
        await client.disconnect()
        log.error("Telegram archive unavailable (%s). Check operator configuration.", exc.__class__.__name__)
        await notify("Archive startup failed", exc.__class__.__name__, severity="critical")


async def stop_telegram():
    global _client, _store, _destination
    if _client: await _client.disconnect()
    if _store: _store.close()
    _client, _store, _destination = None, None, None


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
    if not archive_enabled(): raise HTTPException(503, "Media service unavailable")
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
            try:
                return await asyncio.wait_for(_client.get_messages(_destination, ids=row["destination_id"]), timeout=20)
            except (ConnectionError, asyncio.TimeoutError):
                # Serialize reconnects so concurrent image requests do not tear down each other.
                async with _reconnect_lock:
                    if not _client.is_connected():
                        await asyncio.wait_for(_client.connect(), timeout=15)
                result = await asyncio.wait_for(_client.get_messages(_destination, ids=row["destination_id"]), timeout=20)
                asyncio.create_task(notify("Telegram media connection recovered"))
                return result
        message = await fetch()
        if not message or not message.file or message.file.size is None:
            raise HTTPException(404, "Stored media not found")
        size = message.file.size
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
                async for chunk in telegram_chunks(_client, message, start, end, request.is_disconnected, fetch):
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
