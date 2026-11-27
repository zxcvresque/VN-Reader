"""Saved Instant View photos and canonical aliases never require visitor-side fetches."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from telethon.errors import FloodWaitError

from server import telegram
from server.instant_view import BoundedImage, ImageTooLarge, InstantViewCache, InstantViewWorker, public_block, readable_blocks
from server.mirror import MirrorStore

PHOTO_ID = 9134567890123456789
PNG = b"\x89PNG\r\n\x1a\n" + b"saved raster bytes"
URL = "https://example.com/article/"
CANONICAL = URL.rstrip("/")


def page(*, body=True, photos=True):
    blocks = [{"_": "PageBlockTitle", "text": {"_": "TextPlain", "text": "Headline"}}]
    if photos:
        blocks.append({"_": "PageBlockPhoto", "photo_id": PHOTO_ID, "caption": {"text": {"_": "TextPlain", "text": "Photo caption"}}})
    if body:
        blocks.append({"_": "PageBlockParagraph", "text": {"_": "TextPlain", "text": "An article body with actual content."}})
    return SimpleNamespace(webpage=SimpleNamespace(hash=7, url=CANONICAL, title="Headline", type="article",
        cached_page=SimpleNamespace(part=False, blocks=[SimpleNamespace(to_dict=lambda value=value: value) for value in blocks],
            photos=[SimpleNamespace(id=PHOTO_ID, sizes=[SimpleNamespace(w=1200, h=800)])] if photos else [])))


class InstantViewMediaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "archive.sqlite3"
        self.store = MirrorStore(self.path)
        self.clock = 1000
        self.cache = InstantViewCache(self.store.db, now=lambda: self.clock)
        self.client = AsyncMock(return_value=page())
        self.client.download_media = AsyncMock(side_effect=lambda photo, file: file.write(PNG))
        self.worker = InstantViewWorker(self.client, self.cache)
        with self.store.db:
            self.cache.enqueue({"external_urls": [URL]})

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    async def test_worker_proactively_saves_bounded_raster_and_precision_safe_photo_ids(self):
        await self.worker.step()
        article = self.cache.read(URL)["article"]
        self.assertEqual(article["source"], "telegram")
        self.assertTrue(article["mediaComplete"])
        self.assertEqual(article["blocks"][1]["photo_id"], str(PHOTO_ID))
        photo = article["photos"][str(PHOTO_ID)]
        self.assertEqual((photo["width"], photo["height"]), (1200, 800))
        key = photo["url"].rsplit("/", 1)[-1]
        self.assertEqual(len(key), 64)
        saved = self.cache.media(key)
        self.assertEqual(saved[0].read_bytes(), PNG)
        self.assertEqual(saved[1], "image/png")
        self.assertEqual(self.cache.save_photo(PNG), key, "photo files are content-deduplicated")
        self.assertEqual(len(list(self.cache.media_directory.iterdir())), 1)
        self.client.download_media.assert_awaited_once()

    async def test_canonical_alias_survives_restart_and_pending_canonical_queue_row(self):
        await self.worker.step()
        with self.store.db:
            self.cache.enqueue({"external_urls": [CANONICAL]})
        self.assertEqual(self.cache.read(CANONICAL)["status"], "ready")
        self.assertEqual(self.cache.resolve_url(CANONICAL), URL)
        self.store.close()
        self.store = MirrorStore(self.path)
        self.assertEqual(self.store.instant_views.read(CANONICAL)["article"]["title"], "Headline")

    async def test_legacy_alias_migration_preserves_valid_article_and_queues_photo_upgrade(self):
        await self.worker.step()
        content = self.cache.read(URL)["article"]
        content.pop("mediaComplete"); content.pop("photos"); content.pop("source")
        with self.store.db:
            self.store.db.execute("UPDATE tg_iv_pages SET content=?,next_attempt=999999 WHERE url=?", (json.dumps(content), URL))
            self.store.db.execute("DELETE FROM tg_iv_aliases")
            self.store.db.execute("DELETE FROM tg_meta WHERE key IN ('iv_alias_version','iv_media_version')")
        cache = InstantViewCache(self.store.db, now=lambda: self.clock)
        self.assertEqual(cache.read(CANONICAL)["article"]["source"], "telegram")
        self.assertEqual(self.store.db.execute("SELECT next_attempt FROM tg_iv_pages WHERE url=?", (URL,)).fetchone()[0], 0)

    async def test_preview_or_title_photo_stub_is_not_claimed_as_a_readable_instant_view(self):
        self.client.return_value = page(body=False)
        await self.worker.step()
        self.assertEqual(self.cache.read(URL)["status"], "unavailable")
        self.assertFalse(readable_blocks([{"_": "PageBlockParagraph", "text": {"_": "TextEmpty"}}]))
        self.assertEqual(public_block({"photo_id": PHOTO_ID})["photo_id"], str(PHOTO_ID))
        self.client.download_media.assert_not_awaited()

    async def test_image_flood_wait_keeps_readable_text_and_retries_after_cooldown(self):
        self.client.download_media.side_effect = FloodWaitError(None, capture=19)
        await self.worker.step()
        self.assertEqual(self.worker.cooldown(), 20)
        self.assertEqual(self.cache.read(URL)["status"], "ready")
        self.assertFalse(self.cache.read(URL)["article"]["mediaComplete"])
        self.assertEqual(self.cache.history()["items"][0]["status"], "error")
        self.clock += 20
        self.client.download_media.side_effect = lambda photo, file: file.write(PNG)
        await self.worker.step()
        self.assertEqual(self.client.call_args.args[0].hash, 0, "photo retries need the full page metadata")
        self.assertTrue(self.cache.read(URL)["article"]["mediaComplete"])

    async def test_photo_timeout_keeps_article_readable_and_schedules_retry(self):
        self.client.download_media.side_effect = TimeoutError()
        await self.worker.step()
        self.assertEqual(self.cache.read(URL)["status"], "ready")
        self.assertEqual(self.worker.delay(), 300)
        self.assertFalse(self.cache.read(URL)["article"]["mediaComplete"])

    def test_storage_rejects_active_content_and_enforces_file_and_total_budgets(self):
        with BoundedImage(8) as image:
            with self.assertRaises(ImageTooLarge):
                image.write(b"x" * 9)
        for value in (b"<svg><script>bad()</script></svg>", b"<html>bad</html>"):
            with self.assertRaises(ValueError):
                self.cache.save_photo(value)
        self.cache.media_budget = len(PNG) - 1
        with self.assertRaises(ImageTooLarge):
            self.cache.save_photo(PNG)
        self.assertIsNone(self.cache.media("../archive.sqlite3"))

    async def test_public_image_route_only_serves_indexed_files_without_telegram_work(self):
        key = self.cache.save_photo(PNG)
        app = FastAPI(); app.include_router(telegram.router)
        with patch.object(telegram, "_store", self.store):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
                response = await api.get(f"/api/instant-view-media/{key}")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, PNG)
                self.assertEqual(response.headers["content-type"], "image/png")
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                self.assertIn("immutable", response.headers["cache-control"])
                self.assertEqual((await api.get("/api/instant-view-media/" + "f" * 64)).status_code, 404)
                self.assertEqual((await api.get("/api/instant-view-media/invalid")).status_code, 404)
        self.client.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
