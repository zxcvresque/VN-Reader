"""Full checks history preserves attempts and exposes bounded, read-only queries."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from telethon.errors import FloodWaitError

from server import telegram
from server.instant_view import InstantViewCache, InstantViewWorker
from server.mirror import MirrorStore
from server.tests.test_instant_view import webpage

URL = "https://example.com/article"


class InstantViewHistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "archive.sqlite3"
        self.store = MirrorStore(self.path)
        self.clock = 1000
        self.cache = InstantViewCache(self.store.db, now=lambda: self.clock)
        with self.store.db:
            self.cache.enqueue({"external_urls": [URL]})
        self.client = AsyncMock(return_value=webpage())
        self.worker = InstantViewWorker(self.client, self.cache)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def add_check(self, url, status="ready", checked_at=None):
        with self.store.db:
            self.store.db.execute("INSERT INTO tg_iv_checks(url,status,checked_at,next_attempt,attempts) VALUES(?,?,?,?,?)",
                (url, status, checked_at or self.clock, self.clock + 60, 1))

    async def test_every_attempt_is_preserved_across_retries_and_restart(self):
        self.client.side_effect = [FloodWaitError(None, capture=19), webpage()]
        await self.worker.step()
        self.assertEqual(self.cache.history()["items"][0]["error"], "FloodWaitError")
        self.clock += 20
        await self.worker.step()
        self.clock += 31 * 86400
        self.client.side_effect = ConnectionError()
        await self.worker.step()
        history = self.cache.history()
        self.assertEqual(history["total"], 3)
        self.assertEqual([row["status"] for row in history["items"]], ["error", "ready", "error"])
        self.assertEqual([row["attempts"] for row in history["items"]], [3, 2, 1])
        self.assertEqual(self.cache.read(URL)["status"], "ready", "failed refresh must retain the readable article")
        self.store.close()
        self.store = MirrorStore(self.path)
        self.assertEqual(self.store.instant_views.history()["total"], 3)

    async def test_page_state_and_history_are_saved_in_one_transaction(self):
        self.store.db.execute("""CREATE TRIGGER reject_iv_history BEFORE INSERT ON tg_iv_checks
            BEGIN SELECT RAISE(ABORT,'test rejection'); END""")
        self.store.db.commit()
        with self.assertRaises(Exception):
            await self.worker.step()
        self.assertEqual(self.cache.history()["total"], 0)
        page = self.store.db.execute("SELECT checked_at,attempts,status FROM tg_iv_pages WHERE url=?", (URL,)).fetchone()
        self.assertEqual(tuple(page), (None, 0, "pending"))

    def test_pagination_is_stable_with_equal_timestamps_and_clamps_out_of_range(self):
        for index in range(45):
            self.add_check(f"https://example.com/{index}")
        first, second, third = [self.cache.history(page=page, page_size=20) for page in (1, 2, 3)]
        self.assertEqual([len(value["items"]) for value in (first, second, third)], [20, 20, 5])
        ids = [row["id"] for value in (first, second, third) for row in value["items"]]
        self.assertEqual(ids, list(range(45, 0, -1)))
        self.assertEqual((first["total"], first["totalPages"]), (45, 3))
        self.assertEqual(self.cache.history(page=1000000)["page"], 3)

    def test_search_is_case_insensitive_literal_and_can_combine_with_result_filter(self):
        self.add_check("https://example.com/India_Ahead?discount=50%", "ready")
        self.add_check("https://example.com/india-ahead", "unavailable")
        self.add_check("https://example.com/other", "error")
        self.assertEqual(self.cache.history(query="INDIA")["total"], 2)
        self.assertEqual(self.cache.history(query="India Ahead")["total"], 2)
        self.assertEqual(self.cache.history(query="_")["total"], 1)
        self.assertEqual(self.cache.history(query="%")["total"], 1)
        self.assertEqual(self.cache.history(query="india", status="unavailable")["total"], 1)
        empty = self.cache.history(query="missing", page=99)
        self.assertEqual((empty["items"], empty["page"], empty["total"], empty["totalPages"]), ([], 1, 0, 1))

    def test_invalid_filters_and_unbounded_pages_are_rejected(self):
        for options in ({"status": "pending"}, {"page": 0}, {"page_size": 0}, {"page_size": 101},
                        {"page_size": True}, {"query": "x" * 4097}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.cache.history(**options)

    def test_legacy_migration_imports_only_known_latest_result_once(self):
        with self.store.db:
            self.store.db.execute("DELETE FROM tg_meta WHERE key='iv_history_version'")
            self.store.db.execute("UPDATE tg_iv_pages SET checked_at=123,status='unavailable',attempts=4,error='InstantViewUnavailable' WHERE url=?", (URL,))
        cache = InstantViewCache(self.store.db, now=lambda: self.clock)
        item = cache.history()["items"][0]
        self.assertEqual((item["url"], item["checkedAt"], item["attempts"], item["legacy"]), (URL, 123, 4, 1))
        self.assertEqual(cache.history()["total"], 1, "earlier attempts were not retained and cannot be reconstructed")
        self.assertEqual(InstantViewCache(self.store.db).history()["total"], 1)

    async def test_history_api_requires_bearer_validates_parameters_and_never_fetches(self):
        self.add_check(URL)
        app = FastAPI()
        app.include_router(telegram.router)
        with patch.object(telegram, "_store", self.store), patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test-internal-token"}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
                self.assertEqual((await api.get("/api/iv-history")).status_code, 401)
                headers = {"Authorization": "Bearer test-internal-token"}
                for parameters in ({"status": "pending"}, {"page": 0}, {"page": "bad"}, {"pageSize": 101}):
                    response = await api.get("/api/iv-history", headers=headers, params=parameters)
                    self.assertEqual(response.status_code, 422)
                response = await api.get("/api/iv-history", headers=headers, params={"query": "EXAMPLE", "status": "ready", "pageSize": 10})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["cache-control"], "no-store")
                self.assertEqual((response.json()["total"], response.json()["pageSize"]), (1, 10))
        self.client.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
