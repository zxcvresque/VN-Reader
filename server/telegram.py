"""Public archive API and bounded HTTP media relay from the private Telegram group."""
from __future__ import annotations
import asyncio
import logging
import os
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import Response, StreamingResponse
from .mirror import MirrorStore, configuration
from .streaming import parse_range, media_headers, telegram_chunks, RangeNotSatisfiable

router = APIRouter()
log = logging.getLogger(__name__)
_client = None
_store = None
_destination = None
_slots = asyncio.Semaphore(8)


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
    try:
        await client.start(bot_token=config["bot_token"])
        if not (await client.get_me()).bot:
            raise RuntimeError("The streaming session must belong to the configured bot")
        destination = await client.get_input_entity(config["destination"])
        store = MirrorStore(config["database"])
        identity = store.meta("identity")
        if identity and identity["destination"] != str(config["destination"]):
            store.close()
            raise RuntimeError("Configured storage group differs from archive mapping")
        _client, _store, _destination = client, store, destination
    except Exception as exc:
        await client.disconnect()
        log.error("Telegram archive unavailable (%s). Check operator configuration.", exc.__class__.__name__)


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
            return await _client.get_messages(_destination, ids=row["destination_id"])
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
            finally:
                _slots.release()
        handed_off = True
        return StreamingResponse(body(), status_code=status, headers=headers, media_type=None)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Stored Telegram media lookup failed (%s)", exc.__class__.__name__)
        raise HTTPException(502, "Stored media is temporarily unavailable")
    finally:
        if not handed_off: _slots.release()
