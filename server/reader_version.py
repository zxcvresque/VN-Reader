"""Prepare alternative reader documents in the background; public routes only read.

The free extraction service is intentionally paced at 15 requests/minute and
receives only public article URLs already checked by the Telegram IV worker.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from fastapi import APIRouter, HTTPException, Request as WebRequest
from starlette.responses import JSONResponse

from .instant_view import normalize_url, readable_blocks

log = logging.getLogger(__name__)
MAX_BYTES = 2 * 1024 * 1024
REFRESH_SECONDS = 30 * 86400
INTERVAL_SECONDS = 4
router = APIRouter()


class ReaderFetchError(Exception):
    def __init__(self, code, retry_after=0):
        self.code, self.retry_after = code, retry_after
        super().__init__(code)


def extract_reader(url):
    """A fixed HTTPS upstream; no user-controlled host, headers, key or redirects."""
    request = Request("https://r.jina.ai/" + url, headers={
        "Accept": "application/json", "X-Return-Format": "markdown",
        "X-Timeout": "20", "DNT": "1", "User-Agent": "VNReader/1.0",
    })
    try:
        with urlopen(request, timeout=25) as response:
            if response.geturl().split("/", 3)[:3] != ["https:", "", "r.jina.ai"]:
                raise ReaderFetchError("UnexpectedRedirect")
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ReaderFetchError("ContentTooLarge")
            value = json.loads(raw)
    except HTTPError as exc:
        retry = exc.headers.get("Retry-After", "60")
        seconds = int(retry) if retry.isdigit() else 60
        raise ReaderFetchError("RateLimited" if exc.code == 429 else "UpstreamUnavailable",
                               max(60, min(seconds, 86400)) if exc.code == 429 else 0) from None
    data = value.get("data") if isinstance(value, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("content"), str):
        raise ReaderFetchError("NoReadableContent")
    return data


def rich_text(text, base):
    """A small safe Markdown subset represented as native rich-text objects."""
    parts, cursor = [], 0
    pattern = r"!?\[([^\]\n]*)\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`"
    for match in re.finditer(pattern, text):
        if match.start() > cursor:
            parts.append({"_": "TextPlain", "text": text[cursor:match.start()]})
        if match.group(1) is not None:
            url = normalize_url(urljoin(base, match.group(2)))
            label = match.group(1) or "View image on original page"
            part = {"_": "TextPlain", "text": label}
            if url:
                part = {"_": "TextUrl", "text": part, "url": url}
        elif match.group(3):
            part = {"_": "TextBold", "text": {"_": "TextPlain", "text": match.group(3)}}
        else:
            part = {"_": "TextFixed", "text": {"_": "TextPlain", "text": match.group(4)}}
        parts.append(part)
        cursor = match.end()
    if cursor < len(text):
        parts.append({"_": "TextPlain", "text": text[cursor:]})
    return parts[0] if len(parts) == 1 else {"_": "TextConcat", "texts": parts}


def document(data, url):
    content = data["content"].strip()
    # An error/empty response must never become a cached readable article.
    lead = re.sub(r"^[#>\s]+", "", content)
    if len(content) < 100 or re.match(r"^(error|access denied|just a moment|verify you are human|403 forbidden)\b", lead, re.I):
        raise ReaderFetchError("NoReadableContent")
    blocks, paragraph, code, list_items = [], [], None, []
    def flush():
        if paragraph:
            blocks.append({"_": "PageBlockParagraph", "text": rich_text(" ".join(paragraph), url)})
            paragraph.clear()
        if list_items:
            blocks.append({"_": "PageBlockList", "items": list(list_items)})
            list_items.clear()
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("```"):
            flush()
            if code is None:
                code = []
            else:
                blocks.append({"_": "PageBlockPreformatted", "text": {"_": "TextPlain", "text": "\n".join(code)}})
                code = None
            continue
        if code is not None:
            code.append(line)
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        item = re.match(r"^(?:[-*+] |\d+[.)] )(.+)$", line)
        if heading:
            flush()
            kind = "PageBlockTitle" if len(heading[1]) == 1 else "PageBlockHeader" if len(heading[1]) == 2 else "PageBlockSubheader"
            blocks.append({"_": kind, "text": rich_text(heading[2], url)})
        elif not line:
            flush()
        elif item:
            if paragraph:
                flush()
            list_items.append({"_": "PageListItemText", "text": rich_text(item[1], url)})
        elif line.startswith("> "):
            flush()
            blocks.append({"_": "PageBlockBlockquote", "text": rich_text(line[2:], url)})
        elif re.fullmatch(r"[-*_]{3,}", line):
            flush()
            blocks.append({"_": "PageBlockDivider"})
        else:
            if list_items:
                flush()
            paragraph.append(line)
    flush()
    if code:
        blocks.append({"_": "PageBlockPreformatted", "text": {"_": "TextPlain", "text": "\n".join(code)}})
    if not readable_blocks(blocks):
        raise ReaderFetchError("NoReadableContent")
    return {"title": str(data.get("title") or "Reader version")[:500], "siteName": None,
            "url": url, "rtl": False, "source": "reader", "blocks": blocks}


class ReaderVersionCache:
    def __init__(self, db, *, now=time.time):
        self.db, self.now = db, now
        db.executescript("""
            CREATE TABLE IF NOT EXISTS tg_reader_versions(
                url TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'pending',content TEXT,
                checked_at REAL,next_attempt REAL NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,error TEXT
            );
            CREATE INDEX IF NOT EXISTS tg_reader_due ON tg_reader_versions(next_attempt,url);
        """)

    def discover(self):
        # Only URLs already checked by our IV process are sent to the extractor.
        with self.db:
            self.db.execute("""INSERT OR IGNORE INTO tg_reader_versions(url)
                SELECT url FROM tg_iv_pages WHERE status='unavailable' AND content IS NULL""")

    def read(self, value):
        url = normalize_url(value)
        row = self.db.execute("SELECT status,content,checked_at FROM tg_reader_versions WHERE url=?", (url,)).fetchone()
        if not row:
            # Telegram's canonical URL aliases can point back to an unavailable
            # original record; exact canonical matches are safe to reuse.
            table = self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tg_iv_aliases'").fetchone()
            if table:
                alias = self.db.execute("SELECT target_url FROM tg_iv_aliases WHERE url=?", (url,)).fetchone()
                if alias:
                    row = self.db.execute("SELECT status,content,checked_at FROM tg_reader_versions WHERE url=?", (alias[0],)).fetchone()
        return {"status": "ready" if row and row[1] else row[0] if row else "missing",
                "source": "reader", "checkedAt": row[2] if row else None,
                "article": json.loads(row[1]) if row and row[1] else None}

    def stats(self):
        counts = {key: 0 for key in ("pending", "ready", "unavailable", "error")}
        counts.update(dict(self.db.execute("SELECT status,count(*) FROM tg_reader_versions GROUP BY status")))
        return counts


class ReaderVersionWorker:
    def __init__(self, cache, *, fetcher=extract_reader):
        self.cache, self.fetcher = cache, fetcher
        self.pending_discovery = True
        self.last_discovery = 0

    def meta(self, key):
        row = self.cache.db.execute("SELECT value FROM tg_meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else 0

    def set_meta(self, key, value):
        self.cache.db.execute("INSERT INTO tg_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))

    def delay(self):
        if self.meta("iv_paused"):
            return None
        row = self.cache.db.execute("SELECT min(r.next_attempt) FROM tg_reader_versions r JOIN tg_iv_pages p ON p.url=r.url WHERE p.status='unavailable' AND p.content IS NULL").fetchone()
        if row[0] is None:
            return None
        return max(0, row[0] - self.cache.now(), self.meta("reader_next_request_at") - self.cache.now())

    async def step(self):
        now, db = self.cache.now(), self.cache.db
        if self.pending_discovery or now - self.last_discovery >= 15:
            self.cache.discover()
            self.pending_discovery, self.last_discovery = False, now
        delay = self.delay()
        if delay is None or delay > 0:
            return False
        row = db.execute("""SELECT r.* FROM tg_reader_versions r JOIN tg_iv_pages p ON p.url=r.url
            WHERE r.next_attempt<=? AND p.status='unavailable' AND p.content IS NULL
            ORDER BY r.next_attempt,r.url LIMIT 1""", (now,)).fetchone()
        if not row:
            return False
        # Reserve spacing before network I/O so restart/cancel also respects it.
        with db:
            self.set_meta("reader_next_request_at", now + INTERVAL_SECONDS)
        try:
            data = await asyncio.wait_for(asyncio.to_thread(self.fetcher, row["url"]), timeout=30)
            content = json.dumps(document(data, row["url"]), ensure_ascii=False, separators=(",", ":"))
            with db:
                db.execute("UPDATE tg_reader_versions SET status='ready',content=?,checked_at=?,next_attempt=?,attempts=attempts+1,error=NULL WHERE url=?",
                           (content, self.cache.now(), self.cache.now() + REFRESH_SECONDS, row["url"]))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            code = exc.code if isinstance(exc, ReaderFetchError) else exc.__class__.__name__
            interval = exc.retry_after if isinstance(exc, ReaderFetchError) and exc.retry_after else min(3600, 60 * 2 ** min(row["attempts"], 6))
            if code in {"NoReadableContent", "ContentTooLarge"}:
                interval = REFRESH_SECONDS
            with db:
                db.execute("UPDATE tg_reader_versions SET status=?,checked_at=?,next_attempt=?,attempts=attempts+1,error=? WHERE url=?",
                           ("ready" if row["content"] else "unavailable" if interval == REFRESH_SECONDS else "error",
                            self.cache.now(), self.cache.now() + interval, code, row["url"]))
                if code == "RateLimited":
                    self.set_meta("reader_next_request_at", self.cache.now() + interval)
            log.warning("Reader version deferred (%s)", code)
        finally:
            with db:
                self.set_meta("reader_next_request_at", max(self.meta("reader_next_request_at"), self.cache.now() + INTERVAL_SECONDS))
        return True


@router.get("/api/reader-version")
async def reader_version(url: str, request: WebRequest):
    from . import telegram
    if not normalize_url(url):
        raise HTTPException(422, "A valid public article address is required")
    if not telegram._store:
        raise HTTPException(503, "The archive is not configured yet")
    saved = telegram._store.reader_versions.read(url)
    return JSONResponse(saved, headers={"Cache-Control": "public, max-age=3600" if saved["article"] else "public, max-age=60"})
