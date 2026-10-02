"""Bounded Telegram -> HTTP streaming; no file is downloaded to disk."""
from __future__ import annotations
import inspect
import asyncio
import re
from urllib.parse import quote

CHUNK_SIZE = 256 * 1024

class RangeNotSatisfiable(ValueError):
    pass


def parse_range(header, size):
    """Return an inclusive single range; reject multipart/malformed/empty ranges."""
    if size < 0:
        raise ValueError("Unknown file size")
    if not header:
        return 0, size - 1, False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not match or size == 0 or not any(match.groups()):
        raise RangeNotSatisfiable()
    left, right = match.groups()
    if left:
        start = int(left)
        end = min(int(right), size - 1) if right else size - 1
        if start >= size or end < start:
            raise RangeNotSatisfiable()
    else:
        suffix = int(right)
        if suffix <= 0:
            raise RangeNotSatisfiable()
        start, end = max(0, size - suffix), size - 1
    return start, end, True


def media_headers(size, start, end, partial, mime, name):
    # Only inert formats render in the site origin. Documents are downloads.
    mime = (mime or "application/octet-stream").lower()
    if not re.fullmatch(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+", mime):
        mime = "application/octet-stream"
    inline = mime.startswith(("audio/", "video/")) or mime in {
        "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"}
    if mime in {"text/html", "image/svg+xml", "application/xhtml+xml"}:
        mime = "application/octet-stream"
    name = (name or "media").replace("\r", "").replace("\n", "").replace("/", "_").replace("\\", "_")[:180]
    headers = {
        "Accept-Ranges": "bytes", "Content-Length": str(max(0, end - start + 1)),
        "Content-Type": mime, "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "no-store",
        "Content-Disposition": ("inline" if inline else "attachment") + "; filename*=UTF-8''" + quote(name, safe=""),
    }
    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return headers


def media_file_info(message):
    """Choose one photo representation for both HTTP lengths and downloaded bytes."""
    from telethon.tl import types
    media = getattr(message.file, "media", None)
    if isinstance(media, types.Photo):
        variants = [size for size in media.sizes if isinstance(size, (types.PhotoSize, types.PhotoSizeProgressive, types.PhotoCachedSize))]
        if not variants:
            raise ValueError("Photo has no downloadable representation")
        # Largest dimensions need not have the heaviest JPEG. File.size takes
        # max(bytes), while Telethon's implicit download selects the last variant.
        chosen = max(variants, key=lambda size: (size.w * size.h, size.w, size.h))
        if isinstance(chosen, types.PhotoCachedSize):
            return chosen.bytes, None, len(chosen.bytes)
        size = max(chosen.sizes) if isinstance(chosen, types.PhotoSizeProgressive) else chosen.size
        location = types.InputPhotoFileLocation(id=media.id, access_hash=media.access_hash,
                                                file_reference=media.file_reference, thumb_size=chosen.type)
        return location, media.dc_id, size
    return getattr(message, "media", None), None, message.file.size


async def telegram_chunks(client, message, start, end, disconnected=None, refresh=None, *, get_client=None):
    """Yield bounded exact bytes, release sender on disconnect and refresh stale references."""
    position, refresh_count, connection_retries = start, 0, 0
    while position <= end:
        location, dc_id, file_size = media_file_info(message)
        if isinstance(location, bytes):
            if not disconnected or not await disconnected():
                yield location[position:end + 1]
            return
        # Telegram requires each getFile request to stay inside a single 1 MiB
        # block. Telethon can use its direct iterator for a merely 4 KiB-aligned
        # range offset, whose 256 KiB request may cross that boundary. Align the
        # physical download ourselves, then trim the HTTP range prefix locally.
        download_offset = position - position % CHUNK_SIZE
        prefix = position - download_offset
        download_options = {"offset": download_offset, "request_size": CHUNK_SIZE,
                            "chunk_size": CHUNK_SIZE, "file_size": file_size,
                            "limit": (end - download_offset) // CHUNK_SIZE + 1}
        if dc_id is not None:
            download_options["dc_id"] = dc_id
        iterator = client.iter_download(location, **download_options)
        try:
            async for chunk in iterator:
                if disconnected and await disconnected():
                    return
                data = bytes(chunk)
                if prefix:
                    skipped = min(prefix, len(data))
                    prefix -= skipped
                    data = data[skipped:]
                    if not data:
                        continue
                data = data[:end - position + 1]
                if not data:
                    break
                position += len(data)
                yield data
                if position > end:
                    return
            if position <= end:
                raise IOError("Telegram media ended before the requested range")
        except Exception as exc:
            stale_reference = exc.__class__.__name__ in {"FileReferenceExpiredError", "FilerefUpgradeNeededError"}
            connection_failure = isinstance(exc, (ConnectionError, asyncio.TimeoutError)) or exc.__class__.__name__ in {"AuthKeyDuplicatedError", "AuthKeyUnregisteredError", "SessionRevokedError", "SessionExpiredError"}
            if not refresh or not (stale_reference or connection_failure):
                raise
            if stale_reference:
                if refresh_count >= 2: raise
                refresh_count += 1
            else:
                if connection_retries >= 2: raise
                connection_retries += 1
            # Resume from the last byte emitted, rather than duplicating a partial download.
            # The relay's refresh callback also repairs a disconnected main sender.
            message = await refresh()
            if not message or not message.media:
                raise IOError("Stored media no longer available") from exc
            if get_client is not None:
                client = get_client()
                if client is None:
                    raise ConnectionError("Telegram connection is recovering") from exc
        finally:
            close = getattr(iterator, "close", None) or getattr(iterator, "aclose", None)
            if close:
                result = close()
                if inspect.isawaitable(result):
                    await result
