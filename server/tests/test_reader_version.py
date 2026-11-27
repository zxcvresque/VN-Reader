import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import httpx
from fastapi import FastAPI

from server import telegram
from server.mirror import MirrorStore
from server.reader_version import ReaderFetchError, ReaderVersionCache, ReaderVersionWorker, document, router

URL = "https://example.org/news"
CONTENT = "# News report\n\n" + "The original article contains a detailed account with context and references. " * 5


class ReaderVersionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = MirrorStore(Path(self.directory.name) / "archive.sqlite3")
        self.clock = 1000
        self.cache = ReaderVersionCache(self.store.db, now=lambda: self.clock)
        self.store.reader_versions = self.cache
        with self.store.db:
            self.store.db.execute("INSERT INTO tg_iv_pages(url,status) VALUES(?,'unavailable')", (URL,))
        self.fetch = Mock(return_value={"title": "News report", "content": CONTENT})
        self.worker = ReaderVersionWorker(self.cache, fetcher=self.fetch)

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    async def test_only_prechecked_unavailable_urls_are_fetched(self):
        with self.store.db:
            self.store.db.executemany("INSERT INTO tg_iv_pages(url,status) VALUES(?,?)",
                [("https://example.org/ready", "ready"), ("https://example.org/pending", "pending")])
        self.assertTrue(await self.worker.step())
        self.fetch.assert_called_once_with(URL)
        self.assertEqual(self.cache.read(URL)["status"], "ready")
        self.assertEqual(self.cache.read("https://example.org/unlisted")["status"], "missing")
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM tg_reader_versions").fetchone()[0], 1)

    async def test_spacing_and_rate_limit_persist_across_restarts(self):
        self.fetch.side_effect = ReaderFetchError("RateLimited", 75)
        await self.worker.step()
        self.assertEqual(self.worker.delay(), 75)
        other = ReaderVersionWorker(self.cache, fetcher=self.fetch)
        self.clock += 74
        self.assertFalse(await other.step())
        self.clock += 1
        self.fetch.side_effect = None
        self.assertTrue(await other.step())
        self.assertEqual(self.cache.read(URL)["source"], "reader")
        self.assertGreaterEqual(self.worker.meta("reader_next_request_at"), self.clock + 4)

    async def test_success_is_shared_and_not_repeated_for_thirty_days(self):
        await self.worker.step()
        self.clock += 86400
        self.assertFalse(await self.worker.step())
        self.fetch.assert_called_once()
        reopened = ReaderVersionCache(self.store.db, now=lambda: self.clock)
        self.assertEqual(reopened.read(URL)["article"]["title"], "News report")

    async def test_existing_pause_control_also_pauses_reader_fills(self):
        self.store.instant_views.control("pause")
        self.assertFalse(await self.worker.step())
        self.fetch.assert_not_called()
        self.store.instant_views.control("resume")
        self.assertTrue(await self.worker.step())

    async def test_bad_content_is_negative_cached_and_failed_refresh_retains_success(self):
        await self.worker.step()
        self.clock += 31 * 86400
        self.fetch.side_effect = ConnectionError()
        await self.worker.step()
        self.assertEqual(self.cache.read(URL)["status"], "ready")
        self.assertEqual(self.cache.read(URL)["article"]["title"], "News report")
        with self.assertRaises(ReaderFetchError):
            document({"content": "Access denied"}, URL)

    def test_markdown_is_converted_to_safe_native_blocks(self):
        article = document({"title": "Title", "content": CONTENT + "\n\n## Section\n\n**Bold** and [unsafe](javascript:alert)\n\n- First\n- Second\n\n<script>alert(1)</script>"}, URL)
        self.assertEqual(article["source"], "reader")
        kinds = {block["_"] for block in article["blocks"]}
        self.assertTrue({"PageBlockTitle", "PageBlockParagraph", "PageBlockList", "PageBlockHeader"} <= kinds)
        self.assertNotIn('"url": "javascript:', json.dumps(article))

    def test_challenge_or_heading_only_content_is_not_saved_as_article(self):
        for content in ["# Access denied\n\n" + "Verify your browser to continue. " * 8,
                        "# " + "A heading without a body " * 8]:
            with self.assertRaises(ReaderFetchError):
                document({"content": content}, URL)

    async def test_reader_refresh_stops_when_telegram_iv_becomes_available(self):
        await self.worker.step()
        self.clock += 31 * 86400
        with self.store.db:
            self.store.db.execute("UPDATE tg_iv_pages SET status='ready',content='{}' WHERE url=?", (URL,))
        self.assertIsNone(self.worker.delay())
        self.assertFalse(await self.worker.step())
        self.fetch.assert_called_once()

    async def test_read_endpoint_never_discovers_or_fetches_and_rejects_post(self):
        app = FastAPI()
        app.include_router(router)
        with patch.object(telegram, "_store", self.store):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://reader") as api:
                missing = await api.get("/api/reader-version", params={"url": URL})
                self.assertEqual(missing.json()["status"], "missing")
                self.assertEqual(self.store.db.execute("SELECT count(*) FROM tg_reader_versions").fetchone()[0], 0)
                self.assertEqual((await api.post("/api/reader-version", json={"url": URL})).status_code, 405)
                self.assertEqual((await api.get("/api/reader-version", params={"url": "http://127.0.0.1"})).status_code, 422)
                await self.worker.step()
                ready = await api.get("/api/reader-version", params={"url": URL})
                self.assertEqual(ready.json()["source"], "reader")
                self.assertEqual(ready.headers["cache-control"], "public, max-age=3600")
        self.fetch.assert_called_once()

    async def test_cancel_preserves_spacing_and_pending_work(self):
        self.fetch.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.worker.step()
        self.assertEqual(self.cache.read(URL)["status"], "pending")
        self.assertEqual(self.worker.meta("reader_next_request_at"), 1004)


if __name__ == "__main__":
    unittest.main()
