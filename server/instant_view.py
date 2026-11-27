"""Proactively populate a shared Instant View cache using the mirror's user client.

HTTP handlers only read this cache. Discovery and Telegram RPCs belong to the
single existing mirror process; no second Telegram user session is opened.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import math
import re
import time
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


def public_block(value):
    """Turn TL dates into JSON values and omit unused executable/private fields."""
    if isinstance(value, datetime):
        return int(value.timestamp())
    if isinstance(value, dict):
        return {key: public_block(part) for key, part in value.items()
                if key not in {"html", "access_hash", "file_reference"}}
    if isinstance(value, list):
        return [public_block(part) for part in value]
    if isinstance(value, bytes):
        return None
    return value


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
        db.executescript("""
            CREATE TABLE IF NOT EXISTS tg_iv_pages (
                url TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
                webpage_hash INTEGER NOT NULL DEFAULT 0, content TEXT,
                checked_at REAL, next_attempt REAL NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0, error TEXT
            );
            CREATE INDEX IF NOT EXISTS tg_iv_due ON tg_iv_pages(next_attempt, url);
        """)

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
        if not row:
            return None
        # A failed refresh retains the last successfully fetched article.
        return {"url": url, "status": "ready" if row[1] else row[0],
                "checkedAt": row[2], "article": json.loads(row[1]) if row[1] else None}

    def stats(self):
        return dict(self.db.execute("SELECT status,count(*) FROM tg_iv_pages GROUP BY status"))

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
        try:
            result = await asyncio.wait_for(self.client(functions.messages.GetWebPageRequest(
                url=url, hash=row["webpage_hash"] if row["content"] else 0)), timeout=25)
            webpage = getattr(result, "webpage", result)
            kind = webpage.__class__.__name__
            cached = getattr(webpage, "cached_page", None)
            content, error = None, None
            page_hash = getattr(webpage, "hash", 0) or 0
            if kind == "WebPageNotModified" and row["content"]:
                content, page_hash = row["content"], row["webpage_hash"]
            elif cached and not getattr(cached, "part", False) and getattr(cached, "blocks", None):
                # Keep Telegram rich text and block structure. File references and
                # access hashes are deliberately excluded from this public document.
                article = {"title": getattr(webpage, "title", None), "siteName": getattr(webpage, "site_name", None),
                           "url": normalize_url(getattr(webpage, "url", None)) or url,
                           "rtl": bool(getattr(cached, "rtl", False)),
                           "blocks": [public_block(block.to_dict()) for block in cached.blocks]}
                content = json.dumps(article, ensure_ascii=False, separators=(",", ":"))
                if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
                    content, error = None, "ContentTooLarge"
            elif kind == "WebPagePending":
                raise TimeoutError()
            else:
                error = "PartialInstantView" if cached and getattr(cached, "part", False) else "InstantViewUnavailable"
            # Do not replace a readable article with an empty refresh response.
            if content is None and row["content"]:
                content, page_hash = row["content"], row["webpage_hash"]
            with db:
                db.execute("UPDATE tg_iv_pages SET status=?,content=?,webpage_hash=?,checked_at=?,next_attempt=?,attempts=attempts+1,error=? WHERE url=?",
                           ("ready" if content else "unavailable", content, page_hash, self.cache.now(),
                            self.cache.now() + self.refresh_seconds, error, url))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            name = exc.__class__.__name__
            if name == "FloodWaitError":
                retry_at = self.cache.now() + max(1, int(exc.seconds)) + 1
                with db:
                    self.cache.set_meta("iv_reader_retry_at", retry_at)
                    db.execute("UPDATE tg_iv_pages SET next_attempt=?,error='FloodWaitError' WHERE url=?", (retry_at, url))
                log.warning("Instant View paused for Telegram cooldown (%ss); queue retained", self.cooldown())
            else:
                # Permanent per-URL failures are negative-cached; network and auth
                # failures back off, without disturbing archive mappings/checkpoints.
                permanent = name in {"WebpageCurlFailedError", "WebpageMediaEmptyError", "WcConvertUrlInvalidError"}
                retry = self.refresh_seconds if permanent else min(3600, 60 * 2 ** min(row["attempts"], 6))
                with db:
                    db.execute("UPDATE tg_iv_pages SET status=?,checked_at=?,next_attempt=?,attempts=attempts+1,error=? WHERE url=?",
                               ("ready" if row["content"] else "unavailable" if permanent else "error",
                                self.cache.now(), self.cache.now() + retry, name, url))
                log.warning("Instant View fetch deferred (%s)", name)
        finally:
            with db:
                self.cache.set_meta("iv_next_request_at", self.cache.now() + self.interval)
        return True
