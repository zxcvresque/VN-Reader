"""Public archive API and bounded HTTP media relay from the private Telegram group."""
from __future__ import annotations
import asyncio
import logging
import math
import os
import re
import time
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import Response, StreamingResponse
from .mirror import MirrorStore, configuration, error_label
from .notifications import notify, configure_topic, FIELD_SCHEMA
from .streaming import parse_range, media_headers, telegram_chunks, RangeNotSatisfiable, media_file_info
from .media_lookup import MediaLookupCache
try:
    from . import r2_store as _r2  # optional — degrade gracefully if boto absent
    from .r2_media import r2_headers, r2_range_headers, r2_stream
except Exception:  # pragma: no cover
    _r2 = None  # type: ignore
    r2_headers = r2_range_headers = r2_stream = None  # type: ignore

router = APIRouter()
log = logging.getLogger(__name__)
_client = None
_store = None
_destination = None
_slots = asyncio.Semaphore(8)
_reconnect_lock = asyncio.Lock()
_media_lookups = MediaLookupCache()


_config = None
_recovery_task = None
_last_error = None
_closing = False
_pending_client = None
_retry_not_before = 0.0
_reset_session = False
_CONNECT_TIMEOUT = 20
_RETRY_DELAY = 5
_media_retry_not_before = 0.0


def _media_retry_remaining():
    return max(0, math.ceil(_media_retry_not_before - time.monotonic()))


def _record_media_flood(exc, source_id, stage):
    """Share Telegram's cooldown across requests without resetting authorization."""
    global _media_retry_not_before
    seconds = max(1, int(exc.seconds)) + 1
    _media_retry_not_before = max(_media_retry_not_before, time.monotonic() + seconds)
    seconds = _media_retry_remaining()
    rpc = getattr(exc, "request", None)
    rpc_name = rpc.__class__.__name__ if rpc is not None else None
    if rpc_name and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", rpc_name):
        rpc_name = None
    fields = {"post": f"#{source_id}", "stage": stage, "retryAfter": f"{seconds}s", "error": "FloodWaitError"}
    if rpc_name:
        fields["route"] = rpc_name
    log.warning("Telegram media rate limited at %s for post #%s; request=%s; retry after %ss", stage, source_id, rpc_name or "unknown", seconds)
    asyncio.create_task(notify("Media rate limited", "Telegram requested a pause. Media can be retried after the cooldown.", fields=fields))
    return _media_retry_remaining()


def archive_enabled():
    return (_store is not None and _client is not None and _destination is not None
            and getattr(_client, "is_connected", lambda: True)())


def archive_status():
    archive_ready = _store is not None and bool(_store.meta("source"))
    media_ready = bool(archive_enabled())
    return {"status": "ok" if archive_ready and media_ready else "degraded" if archive_ready else "unavailable",
            "archiveEnabled": _store is not None, "archiveReady": archive_ready,
            "mediaReady": media_ready, "error": _last_error,
            "retryAfter": _retry_remaining()}


def _retry_remaining():
    return max(0, math.ceil(_retry_not_before - time.monotonic()))


async def _disconnect(client):
    if client is not None:
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except Exception:
            log.warning("Telegram client cleanup did not complete")


async def _connect_client():
    global _client, _destination, _last_error, _pending_client, _retry_not_before, _reset_session
    async with _reconnect_lock:
        if _closing or not _config or archive_enabled():
            return bool(archive_enabled())
        # Telegram's cooldown applies to authorization too. Calls from media
        # recovery must not start another login before the supervisor's deadline.
        if _retry_remaining():
            return False
        client = _pending_client
        try:
            from telethon import TelegramClient
            from .bot_sessions import create_bot_session
            # Persistent keys are isolated by API/writer role and explicitly
            # enabled only on the production host. Local defaults stay in memory.
            if client is None:
                await _disconnect(_client)
                _client, _destination = None, None
                client = TelegramClient(create_bot_session("api",reset=_reset_session), _config["api_id"], _config["api_hash"],
                                        flood_sleep_threshold=0, connection_retries=2,
                                        request_retries=2, retry_delay=1, timeout=10)
                _reset_session = False
            async def initialize():
                await client.start(bot_token=_config["bot_token"])
                me = await client.get_me()
                if not me or not me.bot:
                    raise RuntimeError("The streaming session must belong to a bot")
                return await client.get_input_entity(_config["destination"])
            destination = await asyncio.wait_for(initialize(), timeout=_CONNECT_TIMEOUT)
        except asyncio.CancelledError:
            _pending_client = None
            _retry_not_before = 0.0
            await _disconnect(client)
            raise
        except Exception as exc:
            if exc.__class__.__name__ == "FloodWaitError":
                # Keep this process's auth key and any completed authorization.
                # Creating fresh MemorySessions on every retry makes a bot login
                # flood wait worse; a routine cooldown is not a critical failure.
                seconds = max(1, int(exc.seconds)) + 1
                _pending_client = client
                _retry_not_before = time.monotonic() + seconds
                _last_error = error_label(exc)
                log.warning("Telegram media connection rate limited; retrying the same session in %ss", seconds)
                return False
            _pending_client = None
            _retry_not_before = 0.0
            if exc.__class__.__name__ in {"AuthKeyDuplicatedError", "AuthKeyUnregisteredError", "SessionRevokedError", "SessionExpiredError"}:
                _reset_session = True
            await _disconnect(client)
            _last_error = error_label(exc)
            log.error("Telegram media unavailable (%s); automatic recovery will retry", _last_error)
            await notify("Archive connection failed", _last_error, severity="critical")
            return False
        recovered = _last_error is not None
        _pending_client = None
        _retry_not_before = 0.0
        _client, _destination, _last_error = client, destination, None
        log.info("Telegram media connection ready")
        asyncio.create_task(notify("Archive connection recovered" if recovered else "Archive service started"))
        return True


async def _supervise():
    delay = _RETRY_DELAY
    while not _closing:
        await asyncio.sleep(max(delay, _retry_remaining()))
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
    global _client, _store, _destination, _config, _recovery_task, _closing, _pending_client, _retry_not_before, _reset_session, _media_retry_not_before
    _closing = True
    if _recovery_task is not None:
        _recovery_task.cancel()
        try:
            await _recovery_task
        except asyncio.CancelledError:
            pass
        _recovery_task = None
    await _media_lookups.clear()
    await _disconnect(_client)
    if _pending_client is not _client:
        await _disconnect(_pending_client)
    if _store:
        _store.close()
    _client, _store, _destination, _config = None, None, None, None
    _pending_client, _retry_not_before = None, 0.0
    _reset_session = False
    _media_retry_not_before = 0.0


@router.get("/api/r2-stats")
async def r2_stats(request: Request):
    """Admin-only R2 storage probe.

    Auth: either ``Authorization: Bearer <TELEGRAM_BOT_TOKEN>`` (operator/VPS) or
    a valid admin Better Auth session forwarded by the Node account service.
    The account service proxies this endpoint through /api/admin/r2-stats so the
    browser never calls it directly; direct callers must present the bearer token.
    """
    import secrets as _sec
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    auth = request.headers.get("authorization", "")
    internal_caller = request.headers.get("x-vn-internal", "")
    bearer_ok = bool(token and _sec.compare_digest(auth, f"Bearer {token}"))
    # Allow the account service to proxy admin requests via an internal header
    if not bearer_ok and internal_caller != "account-service":
        raise HTTPException(401, "Admin session required")
    if _r2 is None:
        return {"enabled": False, "reason": "r2_store not available"}
    cfg = _r2.load_r2_config()
    if not cfg.enabled:
        return {"enabled": False, "reason": "R2 not configured — set R2_* in server/.env"}
    out: dict = {"enabled": True, "freeTierBytes": _r2.FREE_TIER_BYTES, "autoSwitchPct": _r2.AUTO_SWITCH_PCT, "accounts": []}
    for label, acct in (("primary", cfg.primary), ("secondary", cfg.secondary)):
        if not acct:
            out["accounts"].append({"label": label, "configured": False})
            continue
        try:
            stats = await asyncio.to_thread(_r2.bucket_stats, acct)
            out["accounts"].append({"label": label, "configured": True, **stats.to_dict(), "publicBase": acct.public_base or f"https://{acct.bucket}.r2.dev"})
        except Exception as exc:
            out["accounts"].append({"label": label, "configured": True, "error": f"{exc.__class__.__name__}: {str(exc)[:120]}"})
    # Per-DB R2 row counts (no R2 API needed)
    if _store is not None:
        try:
            cnt, b = _store.r2_counts()  # type: ignore[attr-defined]
            out["localR2Rows"] = {"objects": cnt, "bytes": b}
        except Exception:
            pass
    return out


@router.get("/api/archive")
async def archive(request: Request):
    if not _store:
        raise HTTPException(503, "The hosted archive is not configured yet")
    with _store.archive_snapshot() as revision:
        if revision is None:
            raise HTTPException(503, "The archive is waiting for its first import")
        # The body includes a generated export timestamp; weak validation tracks
        # the durable archive content rather than promising byte identity forever.
        etag = f'W/"vn-archive-v1-{revision}"'
        headers = {"ETag": etag, "Cache-Control": "public, no-cache"}
        validators = request.headers.get("if-none-match", "").split(",")
        if any(value.strip() == "*" or value.strip().removeprefix("W/") == etag.removeprefix("W/") for value in validators):
            return Response(status_code=304, headers=headers)
        return Response(_store.archive_json(revision), media_type="application/json", headers=headers)


@router.api_route("/api/media/{source_id}", methods=["GET", "HEAD"])
async def media(source_id: int, request: Request):
    if source_id <= 0: raise HTTPException(404, "Media not found")
    if _store is None:
        raise HTTPException(503, "Media connection is recovering", headers={"Retry-After": str(_retry_remaining() or 5)})
    # ── R2 fast-path: serve durable bytes without touching Telegram ──
    if _r2 is not None:
        try:
            r2row = _store.r2_row(source_id)  # type: ignore[attr-defined]
        except Exception:
            r2row = None
        if r2row and r2row["r2_key"] and r2row["r2_bucket"]:
            cfg = _r2.load_r2_config()
            # Locate the account that holds this key
            acct = None
            for a in cfg.active_accounts:
                if a.bucket == r2row["r2_bucket"]:
                    acct = a
                    break
            if acct and _r2 is not None:
                try:
                    # Use stored byte count / etag when available; otherwise HEAD the object
                    r2_size = int(r2row["bytes"]) if r2row["bytes"] else None
                    r2_etag_val = r2row["etag"]
                    if r2_size is None:
                        meta = await asyncio.to_thread(_r2.head_object, acct, r2row["r2_key"])
                        if meta is None:
                            raise FileNotFoundError("R2 key missing")
                        r2_size = int(meta.get("ContentLength", 0))
                    # Parse Range for R2
                    r2_etag_hdr = f'"{r2_etag_val}"' if r2_etag_val else None
                    range_header = request.headers.get("range")
                    if request.headers.get("if-range") and r2_etag_hdr and request.headers["if-range"] != r2_etag_hdr:
                        range_header = None
                    try:
                        start, end, partial = parse_range(range_header, r2_size)
                    except RangeNotSatisfiable:
                        return Response(status_code=416, headers={"Content-Range": f"bytes */{r2_size}", "Accept-Ranges": "bytes"})
                    # Content-Type / filename from archive record
                    try:
                        rec = __import__("json").loads(r2row and _store.row(source_id) and _store.row(source_id)["record"] or "{}")
                    except Exception:
                        rec = {}
                    mime = (rec.get("media_raw") or {}).get("mime_type")
                    fname = (rec.get("media_raw") or {}).get("name") or r2row["r2_key"].rsplit("/", 1)[-1]
                    if partial:
                        headers = r2_range_headers(r2_size, start, end, mime, fname, r2_etag=r2_etag_hdr)  # type: ignore
                        status = 206
                    else:
                        headers = r2_headers(r2_size, mime, fname, r2_etag=r2_etag_hdr)  # type: ignore
                        headers["ETag"] = r2_etag_hdr or headers.get("ETag", "")
                        status = 200
                    if r2_etag_hdr:
                        headers["ETag"] = r2_etag_hdr
                    if request.method == "HEAD":
                        return Response(status_code=status, headers=headers)
                    async def r2_body():
                        async for chunk in r2_stream(acct, r2row["r2_key"], start, end):  # type: ignore
                            if await request.is_disconnected():
                                return
                            yield chunk
                    return StreamingResponse(r2_body(), status_code=status, headers=headers, media_type=None)
                except FileNotFoundError:
                    log.warning("R2 key %s missing for post #%s — falling back to Telegram", r2row["r2_key"], source_id)
                except Exception as exc:
                    log.warning("R2 media failed for post #%s (%s) — falling back to Telegram", source_id, exc.__class__.__name__)
                    # Fall through to Telegram path
                    pass
    if _client is None or _destination is None:
        raise HTTPException(503, "Media connection is recovering", headers={"Retry-After": str(_retry_remaining() or 5)})
    row = _store.row(source_id)
    if not row or row["status"] != "copied" or not row["destination_id"]:
        raise HTTPException(404, "Media not found")
    def check_cooldown():
        seconds = _media_retry_remaining()
        if seconds:
            raise HTTPException(503, "Telegram media is rate limited; retry after the cooldown", headers={"Retry-After": str(seconds), "X-Media-Status": "rate-limited", "Cache-Control": "no-store"})
    check_cooldown()
    # No arbitrary peer/file requests; the private group and mapping stay server-side.
    try:
        await asyncio.wait_for(_slots.acquire(), timeout=5)
    except asyncio.TimeoutError:
        raise HTTPException(503, "Media service busy", headers={"Retry-After": "5"})
    handed_off = False
    try:
        async def fetch(force=False):
            global _client, _destination, _last_error, _reset_session
            check_cooldown()
            client, destination = _client, _destination
            # Preview images are saved as real attachments separately from the
            # original post, whose ID must remain stable for replies/quotes.
            media_destination = getattr(_store, "media_destination", None)
            destination_id = media_destination(source_id) if media_destination else row["destination_id"]
            async def lookup(current_client, current_destination):
                async def load():
                    try:
                        return await asyncio.wait_for(current_client.get_messages(current_destination, ids=destination_id), timeout=20)
                    except Exception as exc:
                        if exc.__class__.__name__ == "FloodWaitError":
                            _record_media_flood(exc, source_id, "Lookup")
                            check_cooldown()
                        raise
                return await _media_lookups.get(current_client, current_destination, destination_id, load, force=force)
            try:
                return await lookup(client, destination)
            except Exception as exc:
                invalid_auth = exc.__class__.__name__ in {"AuthKeyDuplicatedError", "AuthKeyUnregisteredError", "SessionRevokedError", "SessionExpiredError"}
                if invalid_auth:
                    # Only invalidate the client that failed, never a newer recovered one.
                    async with _reconnect_lock:
                        if _client is client:
                            await _disconnect(client)
                            _client, _destination = None, None
                            _last_error = error_label(exc)
                            _reset_session = True
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
                result = await lookup(_client, _destination)
                asyncio.create_task(notify("Telegram media connection recovered"))
                return result
        message = await fetch()
        if not message or not message.file or message.file.size is None:
            from telethon.tl.types import MessageMediaWebPage
            if message and isinstance(getattr(message, "media", None), MessageMediaWebPage):
                # A Telegram link preview can disappear while the saved text
                # remains. Distinguish this from a broken attached photo/video.
                raise HTTPException(410, "Telegram no longer provides media for this link preview",
                                    headers={"X-Media-Status": "link-preview-unavailable", "Cache-Control": "no-store"})
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
            async def flood_wait(exc):
                seconds = _record_media_flood(exc, source_id, "Download")
                # Short pauses resume this HTTP range. Long pauses end the stream;
                # later requests receive 503 + Retry-After before contacting Telegram.
                if seconds > 5:
                    return False
                while _media_retry_remaining():
                    if await request.is_disconnected():
                        return False
                    if _media_retry_remaining() > 5:
                        return False
                    await asyncio.sleep(_media_retry_remaining())
                return True
            try:
                async def refresh():
                    # An expired file reference or broken sender needs a fresh
                    # Telegram lookup, even while ordinary requests use metadata.
                    return await fetch(force=True)
                async for chunk in telegram_chunks(_client, message, start, end, request.is_disconnected, refresh, get_client=lambda: _client, flood_wait=flood_wait):
                    yield chunk
            except Exception as exc:
                if exc.__class__.__name__ != "FloodWaitError" and not (isinstance(exc, HTTPException) and exc.headers and exc.headers.get("X-Media-Status") == "rate-limited"):
                    asyncio.create_task(notify("Media stream failed", "The media stream stopped before delivery completed.", severity="critical", fields={"post": f"#{source_id}", "stage": "Download", "error": exc.__class__.__name__}))
                raise
            finally:
                _slots.release()
        handed_off = True
        return StreamingResponse(body(), status_code=status, headers=headers, media_type=None)
    except HTTPException:
        raise
    except Exception as exc:
        if exc.__class__.__name__ == "FloodWaitError":
            _record_media_flood(exc, source_id, "Lookup")
            check_cooldown()
        log.warning("Stored Telegram media lookup failed (%s)", exc.__class__.__name__)
        asyncio.create_task(notify("Media delivery failed", "The stored media could not be retrieved.", severity="critical", fields={"post": f"#{source_id}", "stage": "Lookup", "error": exc.__class__.__name__}))
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
        if len(raw) > 8192: raise HTTPException(413, "Event too large")
    import json
    try: data=json.loads(raw)
    except ValueError: raise HTTPException(422,"Invalid event")
    if not isinstance(data,dict) or not isinstance(data.get("event"), str) or data.get("event") not in {"Account created","Email verified","Reader signed in","Reader login rejected","OTP email delivery failed","Account request failed","Account service started","Account service startup failed","Account service fatal"}:
        raise HTTPException(422,"Unsupported event")
    severity = data.get("severity", "routine")
    if not isinstance(severity, str) or severity not in {"routine", "critical"} or (severity == "critical" and data["event"] not in {"OTP email delivery failed", "Account request failed", "Account service startup failed", "Account service fatal"}):
        raise HTTPException(422, "Unsupported event severity")
    if not isinstance(data.get("detail", ""), str) or len(data.get("detail", "")) > 200:
        raise HTTPException(422, "Invalid event detail")
    fields = data.get("fields", {})
    if not isinstance(fields, dict) or any(key not in FIELD_SCHEMA or not isinstance(value, str) or len(value) > FIELD_SCHEMA[key]["limit"] for key, value in fields.items()):
        raise HTTPException(422, "Invalid event fields")
    options = {"fields": fields} if fields else {}
    asyncio.create_task(notify(data["event"], data.get("detail", ""), cooldown=0 if data["event"] in {"Account created", "Email verified", "Reader signed in"} else 300, severity=severity, **options))
    return {"ok":True}
