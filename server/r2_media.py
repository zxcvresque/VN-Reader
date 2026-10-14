"""R2 media serving helpers — used by telegram.py to serve from R2 (with Telegram fallback)."""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import re
import time
from urllib.parse import quote

log = logging.getLogger(__name__)

# Allowed inline MIME; everything else is forced to attachment (same as streaming.media_headers).
_INLINE = {
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
}
_INLINE_PREFIX = ("audio/", "video/")


def r2_headers(size: int, mime: str | None, name: str | None, *, r2_etag: str | None = None) -> dict:
    mime = (mime or mimetypes.guess_type(name or "")[0] or "application/octet-stream").lower()
    if not re.fullmatch(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+", mime):
        mime = "application/octet-stream"
    inline = mime.startswith(_INLINE_PREFIX) or mime in _INLINE
    if mime in {"text/html", "image/svg+xml", "application/xhtml+xml"}:
        mime = "application/octet-stream"
        inline = False
    safe_name = (name or "media").replace("\r", "").replace("\n", "").replace("/", "_").replace("\\", "_")[:180]
    headers: dict[str, str] = {
        "Content-Length": str(size),
        "Content-Type": mime,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Disposition": ("inline" if inline else "attachment") + "; filename*=UTF-8''" + quote(safe_name, safe=""),
        "Accept-Ranges": "bytes",
        "X-Media-Source": "r2",
    }
    if r2_etag:
        headers["ETag"] = r2_etag
    return headers


def r2_range_headers(size: int, start: int, end: int, mime: str | None, name: str | None, *, r2_etag: str | None = None) -> dict:
    h = r2_headers(end - start + 1, mime, name, r2_etag=r2_etag)  # placeholder
    h["Content-Length"] = str(max(0, end - start + 1))
    h["Content-Range"] = f"bytes {start}-{end}/{size}"
    h["Cache-Control"] = "public, max-age=31536000, immutable"
    return h


def r2_redirect_url(account, key: str) -> str | None:
    """Public URL for edge-cacheable redirect (primary bucket only).

    Only call for keys already indexed in tg_r2_media (authenticated objects);
    never for arbitrary user-supplied keys — prevents enumeration. Bucket itself
    is private (no public ACL/list); this URL is edge-cached via the custom
    domain but the bucket is not publicly listable.
    """
    if not account.public_base:
        return None
    return f"{account.public_base}/{key}"


async def r2_stream(account, key: str, start: int, end: int, chunk_size: int = 256 * 1024):
    """Yield bytes for [start, end] inclusive via R2 GetObject Range. Counts as Class B."""
    import boto3  # noqa: F401  # ensure installed

    def _endpoint(a):
        return f"https://{a.account_id}.r2.cloudflarestorage.com"

    try:
        import boto3 as _boto
        client = _boto.client(
            "s3",
            endpoint_url=_endpoint(account),
            aws_access_key_id=account.access_key,
            aws_secret_access_key=account.secret_key,
            region_name="auto",
        )
    except Exception as exc:
        raise RuntimeError(f"R2 client error: {exc}") from exc

    def _fetch():
        resp = client.get_object(Bucket=account.bucket, Key=key, Range=f"bytes={start}-{end}")
        return resp["Body"].read()

    data: bytes = await asyncio.to_thread(_fetch)
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]
