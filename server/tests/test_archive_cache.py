"""Archive revalidation avoids rebuilding unchanged data and observes edits."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx

from server import telegram
from server.app import app
from server.mirror import MirrorStore


SOURCE = {"chat_id": -10055, "chat_username": "example", "chat_title": "Example"}


def message(source_id=10, text="Original text"):
    return SimpleNamespace(id=source_id, message=text, date=datetime(2026, 1, 1, tzinfo=timezone.utc))


class ArchiveCacheTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "archive.sqlite3"
        self.store = MirrorStore(self.path)
        self.addCleanup(self.store.close)
        self.store.bind(SOURCE, -10099)
        self.store.prepare(message(), SOURCE)
        self.store.complete([100], [message()], SOURCE)
        self.store_patch = patch.object(telegram, "_store", self.store)
        self.store_patch.start()
        self.addCleanup(self.store_patch.stop)

    async def get(self, etag=None):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.get("/api/archive", headers={"If-None-Match": etag} if etag else {})

    async def test_unchanged_archive_returns_empty_304_without_reading_messages(self):
        first = await self.get()
        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.headers["etag"].startswith('W/"vn-archive-v1-'))
        self.assertEqual(first.headers["cache-control"], "public, no-cache")
        with patch.object(self.store, "archive", side_effect=AssertionError("full archive read")), \
                patch.object(self.store, "archive_json", side_effect=AssertionError("serialization")):
            second = await self.get(first.headers["etag"])
        self.assertEqual(second.status_code, 304)
        self.assertEqual(second.content, b"")
        self.assertEqual(second.headers["etag"], first.headers["etag"])
        self.assertEqual(second.headers["cache-control"], first.headers["cache-control"])

    async def test_multiple_and_strong_validators_use_weak_get_comparison(self):
        etag = (await self.get()).headers["etag"]
        self.assertEqual((await self.get(f'"other", {etag.removeprefix("W/")}')).status_code, 304)
        self.assertEqual((await self.get("*")).status_code, 304)
        self.assertEqual((await self.get('W/"different"')).status_code, 200)

    async def test_serialized_payload_is_reused_for_other_readers(self):
        with patch.object(self.store, "archive", wraps=self.store.archive) as build:
            first = await self.get()
            second = await self.get()
        self.assertEqual(build.call_count, 1)
        self.assertEqual(first.content, second.content)
        self.assertEqual(second.json()["messages"][0]["text"], "Original text")
        self.assertEqual(second.headers["content-type"], "application/json")

    async def test_edit_changes_etag_without_advancing_checkpoint(self):
        first = await self.get()
        checkpoint = self.store.meta("checkpoint")
        self.store.complete([100], [message(text="Edited text ✓")], SOURCE, advance=False)
        second = await self.get(first.headers["etag"])
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(first.headers["etag"], second.headers["etag"])
        self.assertEqual(second.json()["messages"][0]["text"], "Edited text ✓")
        self.assertEqual(self.store.meta("checkpoint"), checkpoint)

    async def test_source_metadata_changes_invalidate_archive(self):
        first = await self.get()
        self.store.set_meta("source", dict(SOURCE, chat_title="Renamed"))
        second = await self.get(first.headers["etag"])
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(first.headers["etag"], second.headers["etag"])
        self.assertEqual(second.json()["manifest"]["source"]["chat_title"], "Renamed")
        self.store.set_meta("source", dict(SOURCE, chat_title="Renamed"))
        self.assertEqual((await self.get(second.headers["etag"])).status_code, 304)

    async def test_new_copy_then_deletion_each_invalidate_archive(self):
        first = await self.get()
        self.store.prepare(message(11), SOURCE)
        self.store.complete([101], [message(11)], SOURCE)
        second = await self.get(first.headers["etag"])
        self.assertEqual(second.status_code, 200)
        self.assertEqual(len(second.json()["messages"]), 2)
        with self.store.db:
            self.store.db.execute("DELETE FROM tg_messages WHERE source_id=10")
        third = await self.get(second.headers["etag"])
        self.assertEqual(third.status_code, 200)
        self.assertEqual([post["message_id"] for post in third.json()["messages"]], [11])

    async def test_removing_copied_status_invalidates_archive(self):
        first = await self.get()
        with self.store.db:
            self.store.db.execute("UPDATE tg_messages SET status='skipped' WHERE source_id=10")
        second = await self.get(first.headers["etag"])
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["messages"], [])

    async def test_pending_rows_operational_metadata_and_identical_copy_do_not_invalidate(self):
        first = await self.get()
        self.store.prepare(message(11), SOURCE)
        self.store.fail([message(11)], RuntimeError("private detail"))
        self.store.set_meta("checkpoint", 11)
        self.store.set_meta("notification_topic", 5)
        self.store.complete([100], [message()], SOURCE, advance=False)
        self.assertEqual((await self.get(first.headers["etag"])).status_code, 304)

    async def test_preview_preservation_record_update_invalidates_without_checkpoint_change(self):
        first = await self.get()
        body = json.loads(self.store.row(10)["record"])
        body.update(media_present=True, media_path="/api/media/10", media_origin="link-preview",
                    media_preview={"title": "Preserved article", "url": "https://example.com/article"})
        with self.store.db:
            self.store.db.execute("UPDATE tg_messages SET record=? WHERE source_id=10", (json.dumps(body),))
        second = await self.get(first.headers["etag"])
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["messages"][0]["media_preview"]["title"], "Preserved article")
        self.assertEqual(second.json()["manifest"]["counts"]["media_downloaded"], 1)
        self.assertEqual(self.store.meta("checkpoint"), 10)

    async def test_concurrent_writer_commit_does_not_mismatch_body_and_validator(self):
        baseline = await self.get()
        self.store._archive_payload_cache = None
        writer = MirrorStore(self.path)
        self.addCleanup(writer.close)
        original_archive = self.store.archive

        def concurrent_edit():
            writer.complete([100], [message(text="Concurrent edit")], SOURCE, advance=False)
            return original_archive()

        with patch.object(self.store, "archive", side_effect=concurrent_edit):
            response = await self.get()
        self.assertEqual(response.headers["etag"], baseline.headers["etag"])
        self.assertEqual(response.json()["messages"][0]["text"], "Original text")
        fresh = await self.get(response.headers["etag"])
        self.assertEqual(fresh.status_code, 200)
        self.assertEqual(fresh.json()["messages"][0]["text"], "Concurrent edit")

    async def test_validator_survives_reopening_database(self):
        first = await self.get()
        reopened = MirrorStore(self.path)
        self.addCleanup(reopened.close)
        with patch.object(telegram, "_store", reopened):
            self.assertEqual((await self.get(first.headers["etag"])).status_code, 304)

    async def test_absent_store_and_source_remain_unavailable(self):
        with patch.object(telegram, "_store", None):
            self.assertEqual((await self.get("*")).status_code, 503)
        with self.store.db:
            self.store.db.execute("DELETE FROM tg_meta WHERE key='source'")
        self.assertEqual((await self.get("*")).status_code, 503)


class LegacyArchiveRevisionTests(unittest.TestCase):
    def test_existing_database_gets_durable_revision_tracking(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.sqlite3"
            with sqlite3.connect(path) as db:
                db.executescript("""
                    CREATE TABLE tg_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                    CREATE TABLE tg_messages(source_id INTEGER PRIMARY KEY,destination_id INTEGER,random_id INTEGER NOT NULL,
                        record TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT);
                """)
                db.execute("INSERT INTO tg_meta VALUES('source',?)", (json.dumps(SOURCE),))
                db.execute("INSERT INTO tg_messages VALUES(10,100,1,?,'copied',NULL)",
                           (json.dumps({"message_id": 10, "text": "Legacy", "media_present": False}),))
            store = MirrorStore(path)
            try:
                with store.archive_snapshot() as initial:
                    self.assertEqual(json.loads(store.archive_json(initial))["messages"][0]["text"], "Legacy")
                with store.db:
                    store.db.execute("UPDATE tg_messages SET record=? WHERE source_id=10",
                                     (json.dumps({"message_id": 10, "text": "Changed", "media_present": False}),))
                with store.archive_snapshot() as changed:
                    self.assertNotEqual(initial, changed)
                    self.assertEqual(json.loads(store.archive_json(changed))["messages"][0]["text"], "Changed")
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
