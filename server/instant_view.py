"""Proactively populate a shared Instant View cache using the mirror's user client.

HTTP handlers only read this cache. Discovery and Telegram RPCs belong to the
single existing mirror process; no second Telegram user session is opened.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import ipaddress
import json
import logging
import math
import os
from pathlib import Path
import re
import time
import tempfile
from datetime import datetime
from urllib.parse import parse_qs, urlsplit, urlunsplit

log = logging.getLogger(__name__)
REFRESH_SECONDS = 30 * 86400
MAX_CONTENT_BYTES = 4 * 1024 * 1024
TELEGRAM_HOSTS = {"t.me", "telegram.me", "telegram.dog"}
SKIP_HOSTS = TELEGRAM_HOSTS | {
    "x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com",
    "youtube.com", "youtu.be", "facebook.com", "fb.watch", "instagram.com",
    "reddit.com", "linkedin.com", "whatsapp.com",
}
FILE_SUFFIXES = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
                 ".mp4", ".mp3", ".zip", ".doc", ".docx", ".xls", ".xlsx")


class ImageTooLarge(ValueError):
    pass


class BoundedImage(io.BytesIO):
    def __init__(self, maximum):
        super().__init__()
        self.maximum = maximum

    def write(self, value):
        if self.tell() + len(value) > self.maximum:
            raise ImageTooLarge("Instant View image exceeds the per-file limit")
        return super().write(value)


def raster_mime(value):
    if value.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if value.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if value.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(value) >= 12 and value.startswith(b"RIFF") and value[8:12] == b"WEBP":
        return "image/webp"
    return None


def public_block(value):
    """Turn TL dates into JSON values and omit unused executable/private fields."""
    if isinstance(value, datetime):
        return int(value.timestamp())
    if isinstance(value, dict):
        return {key: str(part) if key == "photo_id" else public_block(part) for key, part in value.items()
                if key not in {"html", "access_hash", "file_reference"}}
    if isinstance(value, list):
        return [public_block(part) for part in value]
    if isinstance(value, bytes):
        return None
    return value


def readable_blocks(blocks, depth=0):
    """A heading/author/cover or unsupported embed alone is not an article body."""
    if not isinstance(blocks, list) or depth > 40:
        return False

    def has_text(value, level=0):
        if level > 40:
            return False
        if isinstance(value, str):
            return bool(value.strip())
        if isinstance(value, dict):
            parts = value.get("texts")
            return has_text(value.get("text"), level + 1) or isinstance(parts, list) and any(has_text(part, level + 1) for part in parts)
        return False

    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("_")
        if kind in {"PageBlockParagraph", "PageBlockPreformatted", "PageBlockBlockquote", "PageBlockPullquote"} and has_text(block.get("text")):
            return True
        if kind in {"PageBlockList", "PageBlockOrderedList"}:
            for item in block.get("items", []):
                if has_text(item) or isinstance(item, dict) and readable_blocks(item.get("blocks"), depth + 1):
                    return True
        if kind == "PageBlockTable":
            for row in block.get("rows", []):
                if isinstance(row, dict) and any(isinstance(cell, dict) and has_text(cell.get("text")) for cell in row.get("cells", [])):
                    return True
        if kind in {"PageBlockDetails", "PageBlockEmbedPost"} and readable_blocks(block.get("blocks"), depth + 1):
            return True
        if kind in {"PageBlockCollage", "PageBlockSlideshow"} and readable_blocks(block.get("items"), depth + 1):
            return True
        if kind == "PageBlockCover" and readable_blocks([block.get("cover")], depth + 1):
            return True
    return False


def cached_document(value):
    if not value:
        return None
    try:
        article = json.loads(value)
    except (ValueError, TypeError):
        return None
    if not isinstance(article, dict) or not readable_blocks(article.get("blocks")):
        return None
    article.setdefault("source", "telegram")
    return article


def normalize_url(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        return None
    value = value.strip().rstrip(".,!?")
    # Drop punctuation enclosing a URL in prose without truncating balanced paths.
    while value.endswith(")") and value.count(")") > value.count("("):
        value = value[:-1]
    if not re.match(r"^[a-z][a-z0-9+.-]*:", value, re.I):
        value = "https://" + value
    try:
        parts = urlsplit(value)
        if parts.scheme.lower() not in {"http", "https"} or parts.username or parts.password:
            return None
        host = (parts.hostname or "").lower().encode("idna").decode("ascii")
        if not host or "." not in host or host.endswith((".local", ".internal", ".localhost")):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        port = parts.port
        if port not in (None, 80, 443):
            return None
        if host.removeprefix("www.") in TELEGRAM_HOSTS and parts.path.rstrip("/") == "/iv":
            target = parse_qs(parts.query).get("url", [None])[0]
            # Refuse recursive wrapper chains.
            if target and urlsplit(target).hostname not in TELEGRAM_HOSTS:
                return normalize_url(target)
            return None
        authority = host
        if port and (parts.scheme.lower(), port) not in {("http", 80), ("https", 443)}:
            authority += f":{port}"
        return urlunsplit((parts.scheme.lower(), authority, parts.path or "/", parts.query, ""))
    except (ValueError, UnicodeError):
        return None


def candidate_url(value):
    url = normalize_url(value)
    if not url:
        return None
    parts = urlsplit(url)
    if any(parts.hostname == host or parts.hostname.endswith("." + host) for host in SKIP_HOSTS):
        return None
    if parts.path.lower().endswith(FILE_SUFFIXES):
        return None
    return url


def record_urls(record):
    """Include hidden link targets and scheme-less URL entities using UTF-16 offsets."""
    candidates = list(record.get("external_urls") or [])
    candidates += [record.get("media_preview_url"), (record.get("media_preview") or {}).get("url")]
    for text, entities in [
        (record.get("text") or "", (record.get("raw") or {}).get("entities") or []),
        (record.get("quote_text") or "", record.get("quote_entities") or []),
    ]:
        candidates.extend(re.findall(r"https?://[^\s<>]+", text, re.I))
        encoded = text.encode("utf-16-le")
        for entity in entities:
            if not isinstance(entity, dict):
                continue
            if entity.get("_") == "MessageEntityTextUrl":
                candidates.append(entity.get("url"))
            elif entity.get("_") == "MessageEntityUrl":
                start, size = entity.get("offset", 0), entity.get("length", 0)
                if isinstance(start, int) and isinstance(size, int) and start >= 0 and size > 0:
                    candidates.append(encoded[start * 2:(start + size) * 2].decode("utf-16-le", errors="replace"))
    return sorted({url for value in candidates if (url := candidate_url(value))})


class InstantViewCache:
    def __init__(self, db, *, now=time.time):
        self.db, self.now = db, now
        database_path = db.execute("PRAGMA database_list").fetchone()[2]
        self.media_directory = Path(os.getenv("VN_IV_MEDIA_DIR") or str(Path(database_path).parent / "iv-media"))
        self.media_maximum = max(1, int(os.getenv("VN_IV_IMAGE_MAX_BYTES", str(8 * 1024 * 1024))))
        self.media_budget = max(1, int(os.getenv("VN_IV_MEDIA_BUDGET_BYTES", str(512 * 1024 * 1024))))
        db.executescript("""
            CREATE TABLE IF NOT EXISTS tg_iv_pages (
                url TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
                webpage_hash INTEGER NOT NULL DEFAULT 0, content TEXT,
                checked_at REAL, next_attempt REAL NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0, error TEXT
            );
            CREATE INDEX IF NOT EXISTS tg_iv_due ON tg_iv_pages(next_attempt, url);
            CREATE TABLE IF NOT EXISTS tg_iv_aliases (
                url TEXT PRIMARY KEY, target_url TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tg_iv_media (
                key TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tg_iv_checks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL,
                status TEXT NOT NULL, checked_at REAL NOT NULL,
                next_attempt REAL NOT NULL, attempts INTEGER NOT NULL,
                error TEXT, legacy INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS tg_iv_checks_time ON tg_iv_checks(checked_at DESC,id DESC);
            CREATE INDEX IF NOT EXISTS tg_iv_checks_status_time ON tg_iv_checks(status,checked_at DESC,id DESC);
        """)
        # The previous cache retained only each URL's latest result. Preserve
        # those known results once, without inventing its earlier check history.
        with db:
            db.execute("BEGIN IMMEDIATE")
            migrated = db.execute("INSERT OR IGNORE INTO tg_meta(key,value) VALUES('iv_history_version','1')").rowcount
            if migrated:
                db.execute("""INSERT INTO tg_iv_checks(url,status,checked_at,next_attempt,attempts,error,legacy)
                    SELECT url,CASE WHEN status='pending' THEN 'error' ELSE status END,
                        checked_at,next_attempt,attempts,error,1
                    FROM tg_iv_pages WHERE checked_at IS NOT NULL""")
                self.set_meta("iv_history_started_at", self.now())
            aliases_migrated = db.execute("INSERT OR IGNORE INTO tg_meta(key,value) VALUES('iv_alias_version','1')").rowcount
            if aliases_migrated:
                for row in db.execute("SELECT url,content FROM tg_iv_pages WHERE content IS NOT NULL").fetchall():
                    article = cached_document(row[1])
                    if article:
                        self.save_alias(row[0], article.get("url"))
            media_migrated = db.execute("INSERT OR IGNORE INTO tg_meta(key,value) VALUES('iv_media_version','1')").rowcount
            if media_migrated:
                # Text remains readable while existing saved pages gain photos.
                for row in db.execute("SELECT url,content FROM tg_iv_pages WHERE status='ready'").fetchall():
                    article = cached_document(row[1])
                    if article and "mediaComplete" not in article:
                        db.execute("UPDATE tg_iv_pages SET next_attempt=0 WHERE url=?", (row[0],))

    def enqueue(self, record):
        # Caller may be completing an archive transaction. Never commit it here.
        self.db.executemany("INSERT OR IGNORE INTO tg_iv_pages(url) VALUES(?)",
                            [(url,) for url in record_urls(record)])

    def discover(self):
        before = self.db.total_changes
        with self.db:
            for row in self.db.execute("SELECT record FROM tg_messages WHERE status='copied'").fetchall():
                self.enqueue(json.loads(row[0]))
        return self.db.total_changes - before

    def read(self, value):
        url = normalize_url(value)
        row = self.db.execute("SELECT status,content,checked_at FROM tg_iv_pages WHERE url=?", (url,)).fetchone()
        article = cached_document(row[1]) if row else None
        if article is None:
            alias = self.db.execute("""SELECT p.status,p.content,p.checked_at FROM tg_iv_aliases a
                JOIN tg_iv_pages p ON p.url=a.target_url WHERE a.url=?""", (url,)).fetchone()
            alias_article = cached_document(alias[1]) if alias else None
            if alias_article:
                row, article = alias, alias_article
        if not row:
            return None
        # A failed refresh retains the last successfully fetched article.
        return {"url": url, "status": "ready" if article else "unavailable" if row[0] == "ready" else row[0],
                "checkedAt": row[2], "source": "telegram" if article else None, "article": article}

    def save_alias(self, target_url, canonical_url):
        canonical = normalize_url(canonical_url)
        if canonical and canonical != target_url:
            self.db.execute("INSERT INTO tg_iv_aliases(url,target_url) VALUES(?,?) ON CONFLICT(url) DO UPDATE SET target_url=excluded.target_url",
                            (canonical, target_url))

    def resolve_url(self, value):
        url = normalize_url(value)
        row = self.db.execute("SELECT target_url FROM tg_iv_aliases WHERE url=?", (url,)).fetchone()
        return row[0] if row else url

    def media(self, key):
        if not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key):
            return None
        row = self.db.execute("SELECT mime,bytes FROM tg_iv_media WHERE key=?", (key,)).fetchone()
        path = self.media_directory / key
        if not row or path.is_symlink() or not path.is_file():
            return None
        return path, row[0]

    def save_photo(self, value):
        mime = raster_mime(value)
        if not mime or len(value) > self.media_maximum:
            raise ValueError("Instant View photo is not an allowed raster image")
        key = hashlib.sha256(value).hexdigest()
        existing = self.media(key)
        if existing:
            return key
        self.media_directory.mkdir(parents=True, exist_ok=True)
        used = sum(path.stat().st_size for path in self.media_directory.iterdir() if path.is_file())
        if used + len(value) > self.media_budget:
            raise ImageTooLarge("Instant View media budget reached")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.media_directory, prefix=".iv-", delete=False) as output:
                temporary = Path(output.name)
                output.write(value)
            temporary.replace(self.media_directory / key)
            with self.db:
                self.db.execute("INSERT OR REPLACE INTO tg_iv_media(key,mime,bytes,created_at) VALUES(?,?,?,?)",
                                (key, mime, len(value), self.now()))
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
        return key

    def stats(self):
        return dict(self.db.execute("SELECT status,count(*) FROM tg_iv_pages GROUP BY status"))

    def record_check(self, url, status, error=None):
        """Append inside the transaction that saves the corresponding page state."""
        self.db.execute("""INSERT INTO tg_iv_checks(url,status,checked_at,next_attempt,attempts,error)
            SELECT url,?,checked_at,next_attempt,attempts,? FROM tg_iv_pages WHERE url=?""",
            (status, error, url))

    def history(self, *, query="", status="all", page=1, page_size=20):
        if status not in {"all", "ready", "unavailable", "error"}:
            raise ValueError("Choose a valid history result filter")
        if not isinstance(query, str) or len(query) > 4096:
            raise ValueError("Search must be at most 4096 characters")
        if type(page) is not int or page < 1 or type(page_size) is not int or not 1 <= page_size <= 100:
            raise ValueError("Use a positive page number and a page size between 1 and 100")
        conditions, params = [], []
        if status != "all":
            conditions.append("status=?")
            params.append(status)
        if query.strip():
            # Also match the readable path labels used in the admin table,
            # e.g. "Chenab Rail Bridge" for /wiki/Chenab_Rail_Bridge.
            conditions.append("(url LIKE ? ESCAPE '\\' COLLATE NOCASE OR replace(replace(replace(url,'_',' '),'-',' '),'%20',' ') LIKE ? ESCAPE '\\' COLLATE NOCASE)")
            literal = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            params.extend(["%" + literal + "%"] * 2)
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        own_transaction = not self.db.in_transaction
        if own_transaction:
            self.db.execute("BEGIN")
        try:
            total = self.db.execute("SELECT count(*) FROM tg_iv_checks" + where, params).fetchone()[0]
            total_pages = max(1, math.ceil(total / page_size))
            page = min(page, total_pages)
            rows = self.db.execute("""SELECT id,url,status,checked_at AS checkedAt,
                next_attempt AS nextAttempt,attempts,error,legacy FROM tg_iv_checks""" + where +
                " ORDER BY checked_at DESC,id DESC LIMIT ? OFFSET ?", [*params, page_size, (page - 1) * page_size]).fetchall()
            return {"items": [dict(row) for row in rows], "page": page, "pageSize": page_size,
                    "total": total, "totalPages": total_pages,
                    "historyStartedAt": self.meta("iv_history_started_at") or None}
        finally:
            if own_transaction:
                self.db.rollback()

    def admin_status(self, *, enabled=True):
        now = self.now()
        counts = {key: 0 for key in ("pending", "ready", "unavailable", "error")}
        counts.update(self.stats())
        row = self.db.execute("SELECT count(*),coalesce(sum(length(CAST(content AS BLOB))),0),max(checked_at) FROM tg_iv_pages").fetchone()
        heartbeat = self.meta("iv_worker_heartbeat_at")
        cooldown = max(0, math.ceil(self.meta("iv_reader_retry_at") - now))
        paused = bool(self.meta("iv_paused"))
        online = heartbeat > 0 and now - heartbeat < 90
        due = self.db.execute("SELECT count(*) FROM tg_iv_pages WHERE next_attempt<=?", (now,)).fetchone()[0]
        state = "disabled" if not enabled else "paused" if paused else "cooldown" if cooldown else "waiting" if not online else "working" if due else "idle"
        recent = [dict(entry) for entry in self.db.execute(
            "SELECT url,status,checked_at AS checkedAt,next_attempt AS nextAttempt,attempts,error FROM tg_iv_pages WHERE checked_at IS NOT NULL ORDER BY checked_at DESC,url LIMIT 20")]
        return {"enabled": enabled, "paused": paused, "state": state, "workerOnline": online,
                "heartbeatAt": heartbeat or None, "retryAfter": cooldown, "counts": counts,
                "total": row[0], "contentBytes": row[1], "lastCheckedAt": row[2], "due": due,
                "intervalSeconds": self.meta("iv_interval_seconds") or 2,
                "refreshDays": (self.meta("iv_refresh_seconds") or REFRESH_SECONDS) / 86400,
                "recent": recent}

    def control(self, action):
        if action == "discover":
            return self.discover()
        if action not in {"pause", "resume", "retry-errors", "recheck-unavailable", "refresh-articles"}:
            raise ValueError("Unknown Instant View action")
        with self.db:
            if action in {"pause", "resume"}:
                self.set_meta("iv_paused", action == "pause")
            else:
                condition = {"retry-errors": "status='error'", "recheck-unavailable": "status='unavailable'",
                             "refresh-articles": "content IS NOT NULL"}[action]
                # The condition comes only from the allowlist above.
                self.db.execute(f"UPDATE tg_iv_pages SET next_attempt=0 WHERE {condition}")
        return None

    def retry_unavailable(self):
        with self.db:
            self.db.execute("UPDATE tg_iv_pages SET next_attempt=0 WHERE status IN ('unavailable','error')")

    def meta(self, name):
        row = self.db.execute("SELECT value FROM tg_meta WHERE key=?", (name,)).fetchone()
        return float(json.loads(row[0])) if row else 0

    def set_meta(self, name, value):
        self.db.execute("INSERT INTO tg_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (name, json.dumps(value)))


class InstantViewWorker:
    def __init__(self, client, cache, *, interval=2, refresh_seconds=REFRESH_SECONDS):
        self.client, self.cache = client, cache
        self.interval = max(1, interval)
        self.refresh_seconds = max(86400, refresh_seconds)
        with self.cache.db:
            self.cache.set_meta("iv_interval_seconds", self.interval)
            self.cache.set_meta("iv_refresh_seconds", self.refresh_seconds)

    def heartbeat(self):
        if self.cache.now() - self.cache.meta("iv_worker_heartbeat_at") >= 10:
            with self.cache.db:
                self.cache.set_meta("iv_worker_heartbeat_at", self.cache.now())

    def cooldown(self):
        return max(0, math.ceil(self.cache.meta("iv_reader_retry_at") - self.cache.now()))

    def delay(self):
        if self.cache.meta("iv_paused"):
            return None
        now = self.cache.now()
        row = self.cache.db.execute("SELECT min(next_attempt) FROM tg_iv_pages").fetchone()
        if row[0] is None:
            return None
        return max(0, row[0] - now, self.cache.meta("iv_next_request_at") - now,
                   self.cache.meta("iv_reader_retry_at") - now)

    async def fetch_photos(self, article, cached, webpage, previous=None):
        """Download referenced raster photos proactively through the same user client."""
        required = set()

        def collect(value):
            if isinstance(value, dict):
                if value.get("photo_id") not in (None, 0, "0"):
                    required.add(str(value["photo_id"]))
                for part in value.values():
                    collect(part)
            elif isinstance(value, list):
                for part in value:
                    collect(part)

        collect(article["blocks"])
        article["photos"], article["mediaComplete"] = {}, False
        complete = True
        sources = list(getattr(cached, "photos", None) or [])
        if getattr(webpage, "photo", None):
            sources.append(webpage.photo)
        seen = set()
        for photo in sources:
            photo_id = str(getattr(photo, "id", ""))
            if photo_id not in required or photo_id in seen:
                continue
            seen.add(photo_id)
            old = ((previous or {}).get("photos") or {}).get(photo_id)
            if isinstance(old, dict) and self.cache.media(str(old.get("url", "")).rsplit("/", 1)[-1]):
                article["photos"][photo_id] = old
                continue
            self.heartbeat()
            try:
                with BoundedImage(self.cache.media_maximum) as buffer:
                    await asyncio.wait_for(self.client.download_media(photo, file=buffer), timeout=30)
                    key = self.cache.save_photo(buffer.getvalue())
                saved = {"url": f"/api/instant-view-media/{key}"}
                sizes = [size for size in (getattr(photo, "sizes", None) or [])
                         if isinstance(getattr(size, "w", None), int) and isinstance(getattr(size, "h", None), int)]
                if sizes:
                    largest = max(sizes, key=lambda size: size.w * size.h)
                    if 0 < largest.w <= 30000 and 0 < largest.h <= 30000:
                        saved.update(width=largest.w, height=largest.h)
                article["photos"][photo_id] = saved
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if exc.__class__.__name__ == "FloodWaitError":
                    raise
                if not isinstance(exc, ValueError):
                    complete = False
                log.warning("Instant View image unavailable (%s)", exc.__class__.__name__)
        article["mediaComplete"] = complete

    async def step(self):
        """Attempt at most one due page, without sleeping or starting another client."""
        from telethon import functions
        self.heartbeat()
        delay = self.delay()
        if delay is None or delay > 0:
            return False
        db, now = self.cache.db, self.cache.now()
        row = db.execute("SELECT * FROM tg_iv_pages WHERE next_attempt<=? ORDER BY next_attempt,url LIMIT 1", (now,)).fetchone()
        if not row:
            return False
        url = row["url"]
        previous = cached_document(row["content"])
        new_article = None
        page_hash = row["webpage_hash"]
        try:
            result = await asyncio.wait_for(self.client(functions.messages.GetWebPageRequest(
                url=url, hash=row["webpage_hash"] if previous and previous.get("mediaComplete") else 0)), timeout=25)
            webpage = getattr(result, "webpage", result)
            kind = webpage.__class__.__name__
            cached = getattr(webpage, "cached_page", None)
            content, error = None, None
            page_hash = getattr(webpage, "hash", 0) or 0
            if kind == "WebPageNotModified" and previous:
                new_article, page_hash = previous, row["webpage_hash"]
                content = json.dumps(new_article, ensure_ascii=False, separators=(",", ":"))
            elif cached and not getattr(cached, "part", False) and getattr(cached, "blocks", None) and getattr(webpage, "type", None) in {None, "article"}:
                # Keep Telegram rich text and block structure. File references and
                # access hashes are deliberately excluded from this public document.
                article = {"source": "telegram", "title": getattr(webpage, "title", None), "siteName": getattr(webpage, "site_name", None),
                           "url": normalize_url(getattr(webpage, "url", None)) or url,
                           "rtl": bool(getattr(cached, "rtl", False)),
                           "blocks": [public_block(block.to_dict()) for block in cached.blocks]}
                if readable_blocks(article["blocks"]):
                    serialized = json.dumps(article, ensure_ascii=False, separators=(",", ":"))
                    if len(serialized.encode("utf-8")) > MAX_CONTENT_BYTES:
                        error = "ContentTooLarge"
                    else:
                        new_article = article
                        await self.fetch_photos(article, cached, webpage, previous)
                        content = json.dumps(article, ensure_ascii=False, separators=(",", ":"))
                        if not article["mediaComplete"]:
                            error = "InstantViewMediaPending"
                else:
                    error = "InstantViewBodyUnavailable"
            elif kind == "WebPagePending":
                raise TimeoutError()
            else:
                error = "PartialInstantView" if cached and getattr(cached, "part", False) else "InstantViewUnavailable"
            outcome = "ready" if content else "unavailable"
            # Do not replace a readable article with an empty refresh response.
            if content is None and previous:
                content, page_hash = json.dumps(previous, ensure_ascii=False, separators=(",", ":")), row["webpage_hash"]
            with db:
                db.execute("UPDATE tg_iv_pages SET status=?,content=?,webpage_hash=?,checked_at=?,next_attempt=?,attempts=attempts+1,error=? WHERE url=?",
                           ("ready" if content else "unavailable", content, page_hash, self.cache.now(),
                            self.cache.now() + (300 if new_article and not new_article.get("mediaComplete") else self.refresh_seconds), error, url))
                if content:
                    self.cache.save_alias(url, json.loads(content).get("url"))
                self.cache.record_check(url, outcome, error)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            name = exc.__class__.__name__
            if name == "FloodWaitError":
                retry_at = self.cache.now() + max(1, int(exc.seconds)) + 1
                with db:
                    self.cache.set_meta("iv_reader_retry_at", retry_at)
                    prepared = json.dumps(new_article, ensure_ascii=False, separators=(",", ":")) if new_article else row["content"] if previous else None
                    db.execute("UPDATE tg_iv_pages SET status=?,content=?,webpage_hash=?,next_attempt=?,checked_at=?,attempts=attempts+1,error='FloodWaitError' WHERE url=?",
                               ("ready" if prepared else "error", prepared, page_hash, retry_at, self.cache.now(), url))
                    if new_article:
                        self.cache.save_alias(url, new_article.get("url"))
                    self.cache.record_check(url, "error", "FloodWaitError")
                log.warning("Instant View paused for Telegram cooldown (%ss); queue retained", self.cooldown())
            else:
                # Permanent per-URL failures are negative-cached; network and auth
                # failures back off, without disturbing archive mappings/checkpoints.
                permanent = name in {"WebpageCurlFailedError", "WebpageMediaEmptyError", "WcConvertUrlInvalidError"}
                retry = self.refresh_seconds if permanent else min(3600, 60 * 2 ** min(row["attempts"], 6))
                with db:
                    db.execute("UPDATE tg_iv_pages SET status=?,checked_at=?,next_attempt=?,attempts=attempts+1,error=? WHERE url=?",
                               ("ready" if previous else "unavailable" if permanent else "error",
                                self.cache.now(), self.cache.now() + retry, name, url))
                    self.cache.record_check(url, "unavailable" if permanent else "error", name)
                log.warning("Instant View fetch deferred (%s)", name)
        finally:
            with db:
                self.cache.set_meta("iv_next_request_at", self.cache.now() + self.interval)
        return True
