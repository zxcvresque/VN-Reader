"""Instant View automation tests. All Telegram calls use fake clients."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from telethon.errors import FloodWaitError

from server import telegram
from server.instant_view import InstantViewCache, InstantViewWorker, normalize_url, record_urls
from server.mirror import MirrorStore

URL = "https://example.com/article"


def webpage(*, available=True, partial=False):
    paragraph = SimpleNamespace(to_dict=lambda: {"_": "PageBlockParagraph", "text": {"_": "TextPlain", "text": "Full article"}})
    return SimpleNamespace(webpage=SimpleNamespace(hash=123, title="Article", site_name="Example", url=URL,
        cached_page=SimpleNamespace(blocks=[paragraph], rtl=False, part=partial) if available else None))


class InstantViewTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "archive.sqlite3"
        self.store = MirrorStore(self.path)
        self.clock = 1000
        self.cache = InstantViewCache(self.store.db, now=lambda: self.clock)
        with self.store.db:
            self.cache.enqueue({"external_urls": [URL]})
        self.client = AsyncMock(return_value=webpage())
        self.worker = InstantViewWorker(self.client, self.cache)

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def test_normalization_and_filtering(self):
        self.assertEqual(normalize_url("HTTPS://Example.com:443/article#part"), URL)
        self.assertEqual(normalize_url("https://example.com/a_(b)."), "https://example.com/a_(b)")
        self.assertEqual(normalize_url("https://t.me/iv?url=https%3A%2F%2Fexample.com%2Farticle&rhash=abc"), URL)
        for value in ("javascript:alert(1)", "https://user:pass@example.com", "http://127.0.0.1/a", "http://foo.local/a", "http://localhost", "https://example.com:8000/a"):
            self.assertIsNone(normalize_url(value), value)
        text = "😀 example.com/article"
        record = {"text": text, "raw": {"entities": [
            {"_": "MessageEntityUrl", "offset": 3, "length": len("example.com/article")},
            {"_": "MessageEntityTextUrl", "offset": 0, "length": 2, "url": URL},
        ]}, "external_urls": [URL + "#other", "https://mobile.twitter.com/a/status/1", "https://youtu.be/test", "https://t.me/a/1", "https://example.com/test.pdf"], "quote_entities": [None]}
        self.assertEqual(record_urls(record), [URL])

    def test_discovery_is_durable_idempotent_and_ignores_uncopied_posts(self):
        with self.store.db:
            self.store.db.executemany("INSERT INTO tg_messages(source_id,random_id,record,status) VALUES(?,?,?,?)", [
                (1, 1, json.dumps({"external_urls": [URL, "https://example.org/new"]}), "copied"),
                (2, 2, json.dumps({"external_urls": ["https://example.org/unfinished"]}), "pending"),
            ])
        self.assertEqual(self.cache.discover(), 1)
        self.assertEqual(self.cache.discover(), 0)
        self.assertEqual(self.cache.stats(), {"pending": 2})

    async def test_ready_article_survives_restart_and_caches_without_client_calls(self):
        self.assertTrue(await self.worker.step())
        self.assertFalse(await self.worker.step())
        self.client.assert_awaited_once()
        request = self.client.call_args.args[0]
        self.assertEqual((request.url, request.hash), (URL, 0))
        self.store.close()
        self.store = MirrorStore(self.path)
        article = self.store.instant_views.read(URL + "#part")
        self.assertEqual(article["status"], "ready")
        self.assertEqual(article["article"]["blocks"][0]["text"]["text"], "Full article")
        self.assertIsNone(self.store.instant_views.read("https://example.org/visitor-url"))
        self.assertEqual(self.store.instant_views.stats(), {"ready": 1})

    async def test_negative_results_are_not_repeated_until_scheduled_refresh(self):
        self.client.return_value = webpage(available=False)
        await self.worker.step()
        self.clock += 86400
        self.assertFalse(await self.worker.step())
        self.client.assert_awaited_once()
        self.assertEqual(self.cache.read(URL)["status"], "unavailable")
        self.cache.retry_unavailable()
        self.assertTrue(await self.worker.step())

    async def test_refresh_reuses_hash_and_retains_article_when_not_modified(self):
        await self.worker.step()
        self.clock += 31 * 86400
        self.client.return_value = SimpleNamespace(webpage=type("WebPageNotModified", (), {})())
        await self.worker.step()
        self.assertEqual(self.client.call_args.args[0].hash, 123)
        self.assertEqual(self.cache.read(URL)["status"], "ready")

    async def test_failed_refresh_keeps_last_readable_article(self):
        await self.worker.step()
        self.clock += 31 * 86400
        self.client.side_effect = ConnectionError()
        await self.worker.step()
        self.assertEqual(self.cache.read(URL)["status"], "ready")
        self.assertEqual(self.worker.delay(), 120)

    async def test_partial_page_is_not_presented_as_complete(self):
        self.client.return_value = webpage(partial=True)
        await self.worker.step()
        self.assertEqual(self.cache.read(URL)["status"], "unavailable")

    async def test_real_telegram_dates_serialize_and_unused_embed_html_is_removed(self):
        from telethon.tl import types
        self.client.return_value = SimpleNamespace(webpage=SimpleNamespace(hash=7, cached_page=SimpleNamespace(part=False, rtl=False,
            blocks=[types.PageBlockAuthorDate(types.TextPlain("Author"), datetime(2026, 11, 27, tzinfo=timezone.utc)),
                    types.PageBlockEmbed(caption=types.PageCaption(types.TextEmpty(), types.TextEmpty()), html="<script>bad()</script>"),
                    types.PageBlockParagraph(types.TextPlain("The body of the article."))])) )
        await self.worker.step()
        article = self.cache.read(URL)["article"]
        self.assertEqual(article["blocks"][0]["published_date"], 1795737600)
        self.assertNotIn("html", article["blocks"][1])

    def test_newly_completed_posts_enqueue_links_in_same_transaction(self):
        source = {"chat_id": -100123, "chat_username": "source", "chat_title": "Source"}
        message = SimpleNamespace(id=5, message="https://example.org/new", media=None)
        self.store.prepare(message, source)
        self.store.complete([100], [message], source)
        self.assertEqual(self.cache.read("https://example.org/new")["status"], "pending")
        self.assertEqual(self.store.meta("checkpoint"), 5)

    async def test_flood_wait_is_persistent_and_retries_same_url_after_full_pause(self):
        self.client.side_effect = [FloodWaitError(None, capture=79), webpage()]
        await self.worker.step()
        self.assertEqual(self.worker.cooldown(), 80)
        self.assertEqual(InstantViewWorker(self.client, self.cache).cooldown(), 80)
        self.clock += 79
        self.assertFalse(await self.worker.step())
        self.clock += 1
        self.assertTrue(await self.worker.step())
        self.assertEqual(self.client.await_count, 2)
        self.assertEqual([call.args[0].url for call in self.client.await_args_list], [URL, URL])

    async def test_transient_failure_backs_off_without_advancing_archive_checkpoint(self):
        self.client.side_effect = TimeoutError()
        await self.worker.step()
        self.assertEqual(self.cache.read(URL)["status"], "error")
        self.assertEqual(self.worker.delay(), 60)
        self.assertIsNone(self.store.meta("checkpoint"))
        self.assertFalse(await self.worker.step())

    async def test_cancellation_leaves_pending_work_resumable(self):
        self.client.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.worker.step()
        self.assertEqual(self.cache.stats(), {"pending": 1})

    async def test_admin_pause_and_resume_persist_and_never_clear_flood_wait(self):
        self.cache.control("pause")
        self.assertFalse(await self.worker.step())
        self.assertTrue(self.cache.admin_status()["paused"])
        with self.store.db:
            self.cache.set_meta("iv_reader_retry_at", self.clock + 80)
        self.cache.control("resume")
        self.assertFalse(await self.worker.step())
        self.assertEqual(self.worker.cooldown(), 80)
        self.clock += 80
        self.assertTrue(await self.worker.step())
        self.cache.control("refresh-articles")
        self.assertEqual(self.cache.read(URL)["status"], "ready")
        self.assertEqual(self.cache.admin_status()["due"], 1)

    async def test_admin_api_requires_internal_bearer_and_validates_controls(self):
        app = FastAPI()
        app.include_router(telegram.router)
        with patch.object(telegram, "_store", self.store), patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test-only-internal-token"}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
                self.assertEqual((await api.get("/api/iv-stats")).status_code, 401)
                self.assertEqual((await api.post("/api/iv-control", json={"action": "pause"})).status_code, 401)
                headers = {"Authorization": "Bearer test-only-internal-token"}
                paused = await api.post("/api/iv-control", json={"action": "pause"}, headers=headers)
                self.assertTrue(paused.json()["paused"])
                self.assertEqual(paused.headers["cache-control"], "no-store")
                self.assertEqual((await api.post("/api/iv-control", json={"action": "delete-all"}, headers=headers)).status_code, 422)
                self.assertEqual((await api.post("/api/iv-control", json=[], headers=headers)).status_code, 422)
                status = await api.get("/api/iv-stats", headers=headers)
                self.assertEqual(status.json()["counts"]["pending"], 1)
                self.assertNotIn("test-only-internal-token", status.text)
        self.client.assert_not_awaited()

    async def test_api_reads_only_and_supports_conditional_requests(self):
        await self.worker.step()
        app = FastAPI()
        app.include_router(telegram.router)
        with patch.object(telegram, "_store", self.store):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
                response = await api.get("/api/instant-view", params={"url": URL})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], "ready")
                unchanged = await api.get("/api/instant-view", params={"url": URL}, headers={"If-None-Match": response.headers["etag"]})
                self.assertEqual(unchanged.status_code, 304)
                missing = await api.get("/api/instant-view", params={"url": "https://other.example/new"})
                self.assertEqual(missing.json(), {"status": "missing", "article": None})
                invalid = await api.get("/api/instant-view", params={"url": "http://127.0.0.1"})
                self.assertEqual(invalid.status_code, 422)
        self.client.assert_awaited_once()
        self.assertEqual(self.cache.stats(), {"ready": 1})


if __name__ == "__main__":
    unittest.main()
