"""Archive startup must recover without making durable text depend on Telegram."""
import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from server import telegram
from server.app import app
from server.mirror import MirrorStore


class TelegramConnection:
    """A controlled, network-free client shared across startup attempts."""
    def __init__(self):
        self.attempts = 0
        self.failures = 0
        self.block = False
        self.connected = False
        self.disconnections = 0
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.sessions = []
        self.failure_type = ConnectionError
        self.constructors = 0
        self.constructor_failures = 0
        self.lookups = 0
        self.lookup_failures = 0
        self.lookup_failure_type = ConnectionError

    def client(self, *args, **kwargs):
        connection = self
        connection.constructors += 1
        connection.sessions.append(args[0] if args else kwargs["session"])
        if connection.constructors <= connection.constructor_failures:
            raise OSError("simulated private constructor failure: do-not-publish")

        class Client:
            async def start(self, **kwargs):
                connection.attempts += 1
                connection.started.set()
                if connection.block:
                    try:
                        await asyncio.Event().wait()
                    except asyncio.CancelledError:
                        connection.cancelled.set()
                        raise
                if connection.attempts <= connection.failures:
                    raise connection.failure_type("simulated private diagnostic: do-not-publish")
                connection.connected = True
                return self

            async def get_me(self):
                return SimpleNamespace(id=123, bot=True)

            async def get_input_entity(self, destination):
                return "private-storage-peer"

            async def get_messages(self, peer, ids):
                connection.lookups += 1
                if connection.lookups <= connection.lookup_failures:
                    raise connection.lookup_failure_type("simulated invalid auth key")
                return SimpleNamespace(file=SimpleNamespace(
                    size=8, mime_type="image/jpeg", name=None, media=SimpleNamespace(id=999),
                ))

            def is_connected(self):
                return connection.connected

            async def disconnect(self):
                connection.connected = False
                connection.disconnections += 1

        return Client()


class ArchiveStartupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await telegram.stop_telegram()
        self.original_umask = os.umask(0o077)
        self.tmp = tempfile.TemporaryDirectory()
        self.database = str(Path(self.tmp.name) / "archive.sqlite3")
        self.source = {"chat_id": -10055, "chat_username": "example", "chat_title": "Example"}
        message = SimpleNamespace(
            id=10, message="Durable archive text", date=datetime.now(timezone.utc),
            edit_date=None, entities=[], media=None, file=None, grouped_id=None, reply_to=None,
        )
        store = MirrorStore(self.database)
        store.bind(self.source, -10099)
        store.prepare(message, self.source)
        store.complete([1010], [message], self.source)
        store.close()
        self.config = {
            "api_id": 123, "api_hash": "test-hash", "bot_token": "123:test-token",
            "destination": -10099, "database": self.database,
            "bot_session": str(Path(self.tmp.name) / "streamer"),
        }
        self.connection = TelegramConnection()
        self.patches = [
            patch.object(telegram, "configuration", return_value=self.config),
            patch("telethon.TelegramClient", side_effect=self.connection.client),
            patch.object(telegram, "notify", new_callable=AsyncMock),
            patch.object(telegram, "configure_topic", new_callable=AsyncMock),
            patch.object(telegram, "_CONNECT_TIMEOUT", 0.03),
            patch.object(telegram, "_RETRY_DELAY", 0.01),
        ]
        for mocked in self.patches:
            mocked.start()

    async def asyncTearDown(self):
        await telegram.stop_telegram()
        for mocked in reversed(self.patches):
            mocked.stop()
        os.umask(self.original_umask)
        self.tmp.cleanup()

    async def eventually(self, predicate):
        async def wait():
            while not predicate():
                await asyncio.sleep(0.002)
        await asyncio.wait_for(wait(), timeout=0.5)

    async def response(self, path):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.get(path)

    async def test_initial_connection_failure_keeps_durable_archive_available(self):
        self.connection.failures = 100
        await telegram.start_telegram()
        response = await self.response("/api/archive")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["messages"][0]["text"], "Durable archive text")
        media = await self.response("/api/media/10")
        self.assertEqual(media.status_code, 503)

    async def test_background_retry_recovers_without_another_startup(self):
        self.connection.failures = 1
        await telegram.start_telegram()
        self.assertFalse(telegram.archive_enabled())
        await self.eventually(telegram.archive_enabled)
        self.assertGreaterEqual(self.connection.attempts, 2)
        health = await self.response("/api/archive-health")
        self.assertEqual(health.status_code, 200)
        self.assertTrue(health.json()["archiveReady"])
        self.assertTrue(health.json()["mediaReady"])
        self.assertIsNone(health.json()["error"])

    async def test_duplicate_auth_key_gets_fresh_process_session_on_retry(self):
        from telethon.errors import AuthKeyDuplicatedError
        from telethon.sessions import MemorySession
        self.connection.failures = 1
        self.connection.failure_type = lambda ignored: AuthKeyDuplicatedError(None)
        await telegram.start_telegram()
        await self.eventually(telegram.archive_enabled)
        self.assertGreaterEqual(len(self.connection.sessions), 2)
        self.assertTrue(all(isinstance(session, MemorySession) for session in self.connection.sessions))
        self.assertIsNot(self.connection.sessions[0], self.connection.sessions[1])

    async def test_runtime_duplicate_auth_key_recovers_with_fresh_session(self):
        from telethon.errors import AuthKeyDuplicatedError
        from telethon.sessions import MemorySession
        await telegram.start_telegram()
        self.connection.lookup_failures = 1
        self.connection.lookup_failure_type = lambda ignored: AuthKeyDuplicatedError(None)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.head("/api/media/10")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-length"], "8")
        self.assertEqual(response.headers["etag"], '"tg-10-999-8"')
        self.assertEqual(self.connection.lookups, 2)
        self.assertEqual(len(self.connection.sessions), 2)
        self.assertTrue(all(isinstance(session, MemorySession) for session in self.connection.sessions))
        self.assertIsNot(self.connection.sessions[0], self.connection.sessions[1])
        self.assertTrue(telegram.archive_enabled())

    async def test_constructor_failure_is_retried_without_losing_archive(self):
        self.connection.constructor_failures = 1
        await telegram.start_telegram()
        self.assertFalse(telegram.archive_enabled())
        self.assertEqual((await self.response("/api/archive")).status_code, 200)
        await self.eventually(telegram.archive_enabled)
        self.assertEqual(self.connection.constructors, 2)
        self.assertEqual(self.connection.attempts, 1)

    async def test_invalid_configuration_sends_critical_notification(self):
        with patch.object(telegram, "configuration", side_effect=ValueError("private value: do-not-publish")), \
                patch.object(telegram, "notify", new_callable=AsyncMock) as notification:
            with self.assertRaises(ValueError):
                await telegram.start_telegram()
            notification.assert_awaited_once_with("Archive startup failed", "ValueError", severity="critical")
        self.assertEqual(self.connection.constructors, 0)
        health = await self.response("/api/archive-health")
        self.assertEqual(health.status_code, 503)
        self.assertEqual(health.json()["error"], "ValueError")
        self.assertNotIn("do-not-publish", health.text)

    async def test_hung_telegram_start_is_bounded_and_reports_degraded_readiness(self):
        self.connection.block = True
        before = time.monotonic()
        await asyncio.wait_for(telegram.start_telegram(), timeout=0.5)
        self.assertLess(time.monotonic() - before, 0.5)
        self.assertTrue(self.connection.cancelled.is_set())
        health = await self.response("/api/archive-health")
        self.assertEqual(health.status_code, 503)
        self.assertTrue(health.json()["archiveReady"])
        self.assertFalse(health.json()["mediaReady"])
        self.assertTrue(health.json()["archiveEnabled"])
        self.assertNotEqual(health.json()["status"], "ok")
        self.assertEqual((await self.response("/api/archive")).status_code, 200)

    async def test_failed_health_exposes_only_symbolic_error(self):
        self.connection.failures = 100
        await telegram.start_telegram()
        response = await self.response("/api/archive-health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"], "ConnectionError")
        self.assertNotIn("do-not-publish", response.text)
        self.assertNotIn(self.config["bot_token"], response.text)

    async def test_healthy_supervisor_keeps_one_live_session(self):
        await telegram.start_telegram()
        await asyncio.sleep(0.05)
        self.assertEqual(self.connection.attempts, 1)
        self.assertEqual(len(self.connection.sessions), 1)
        self.assertTrue(telegram.archive_enabled())

    async def test_health_does_not_report_ready_for_disconnected_client(self):
        await telegram.start_telegram()
        self.connection.connected = False
        health = await self.response("/api/archive-health")
        self.assertEqual(health.status_code, 503)
        self.assertTrue(health.json()["archiveReady"])
        self.assertFalse(health.json()["mediaReady"])

    async def test_shutdown_cancels_recovery_and_preserves_database(self):
        self.connection.failures = 100
        await telegram.start_telegram()
        await telegram.stop_telegram()
        attempts = self.connection.attempts
        await asyncio.sleep(0.05)
        self.assertEqual(self.connection.attempts, attempts)
        self.assertIsNone(telegram._store)
        self.assertIsNone(telegram._client)
        store = MirrorStore(self.database)
        try:
            self.assertEqual(store.archive()["messages"][0]["text"], "Durable archive text")
        finally:
            store.close()

    async def test_shutdown_cancels_inflight_retry(self):
        self.connection.failures = 1
        await telegram.start_telegram()
        self.connection.block = True
        await self.eventually(lambda: self.connection.attempts >= 2)
        await asyncio.wait_for(telegram.stop_telegram(), timeout=0.5)
        self.assertTrue(self.connection.cancelled.is_set())
        attempts = self.connection.attempts
        await asyncio.sleep(0.05)
        self.assertEqual(self.connection.attempts, attempts)
