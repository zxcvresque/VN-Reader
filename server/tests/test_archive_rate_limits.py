"""Authorization cooldowns keep one in-process key and durable archive text."""
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
from telethon.errors import AuthKeyDuplicatedError, FloodWaitError

from server import telegram
from server.app import app
from server.mirror import MirrorStore
from server.tests.test_archive_startup import TelegramConnection


class ArchiveRateLimitTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await telegram.stop_telegram()
        self.umask=os.umask(0o077)
        self.directory=tempfile.TemporaryDirectory()
        database=str(Path(self.directory.name)/"archive.sqlite")
        source={"chat_id":-100123,"chat_username":"example","chat_title":"VN"}
        message=SimpleNamespace(id=10,message="Durable archive text",date=datetime.now(timezone.utc),
                                media=None,file=None,entities=[],reply_to=None)
        store=MirrorStore(database);store.bind(source,-100999)
        store.prepare(message,source);store.complete([1010],[message],source);store.close()
        self.config={"api_id":123,"api_hash":"test-hash","bot_token":"123:test-token", "destination":-100999,"database":database}
        self.connection=TelegramConnection();self.notification=AsyncMock()
        self.patches=[patch.object(telegram,"configuration",return_value=self.config),
                      patch("telethon.TelegramClient",side_effect=self.connection.client),
                      patch.object(telegram,"notify",self.notification),
                      patch.object(telegram,"configure_topic",AsyncMock())]
        for mocked in self.patches:mocked.start()
    async def asyncTearDown(self):
        await telegram.stop_telegram()
        for mocked in reversed(self.patches):mocked.stop()
        os.umask(self.umask);self.directory.cleanup()
    async def pause_supervisor(self):
        task=telegram._recovery_task
        if task:
            task.cancel()
            try:await task
            except asyncio.CancelledError:pass
            telegram._recovery_task=None
    async def request(self,path):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
            return await client.get(path)
    async def limited_start(self):
        self.connection.failures=1
        self.connection.failure_type=lambda ignored:FloodWaitError(None,capture=1778)
        await asyncio.wait_for(telegram.start_telegram(),timeout=0.5)
        await self.pause_supervisor()

    async def test_long_authorization_cooldown_is_bounded_keeps_text_and_suppresses_critical_alert(self):
        await self.limited_start()
        self.assertEqual(self.connection.attempts,1)
        self.assertEqual(self.connection.constructors,1)
        self.assertEqual(self.connection.disconnections,0)
        self.assertIsNotNone(telegram._pending_client)
        self.assertFalse(telegram.archive_enabled())
        archive=await self.request("/api/archive")
        self.assertEqual(archive.status_code,200)
        self.assertEqual(archive.json()["messages"][0]["text"],"Durable archive text")
        health=await self.request("/api/archive-health")
        self.assertEqual(health.status_code,503)
        self.assertGreaterEqual(health.json()["retryAfter"],1778)
        self.assertLessEqual(health.json()["retryAfter"],1779)
        self.assertTrue(health.json()["archiveReady"])
        self.assertEqual(health.json()["error"],"FloodWaitError:FLOOD")
        media=await self.request("/api/media/10")
        self.assertEqual(media.status_code,503)
        self.assertGreaterEqual(int(media.headers["retry-after"]),1778)
        self.assertFalse(any(call.kwargs.get("severity")=="critical" for call in self.notification.await_args_list))

    async def test_direct_recovery_does_no_rpc_before_deadline_and_reuses_same_session_after(self):
        await self.limited_start();pending=telegram._pending_client
        for _ in range(25):self.assertFalse(await telegram._connect_client())
        self.assertEqual(self.connection.attempts,1)
        self.assertEqual(self.connection.constructors,1)
        self.assertEqual(self.connection.disconnections,0)
        telegram._retry_not_before=time.monotonic()-1
        self.assertTrue(await telegram._connect_client())
        self.assertIs(telegram._client,pending)
        self.assertIsNone(telegram._pending_client)
        self.assertEqual(self.connection.constructors,1)
        self.assertEqual(self.connection.attempts,2)
        self.assertEqual(telegram.archive_status()["retryAfter"],0)

    async def test_supervisor_waits_whole_cooldown_instead_of_short_backoff(self):
        await self.limited_start();delays=[]
        async def sleep(seconds):
            delays.append(seconds);telegram._closing=True
        with patch.object(telegram.asyncio,"sleep",side_effect=sleep):
            await telegram._supervise()
        self.assertEqual(len(delays),1)
        self.assertGreaterEqual(delays[0],1778)
        self.assertEqual(self.connection.attempts,1)
        self.assertEqual(self.connection.constructors,1)

    async def test_shutdown_disconnects_pending_session_and_clears_cooldown(self):
        await self.limited_start()
        await telegram.stop_telegram()
        self.assertEqual(self.connection.disconnections,1)
        self.assertIsNone(telegram._pending_client)
        self.assertEqual(telegram._retry_remaining(),0)

    async def test_actionable_auth_failure_after_cooldown_discards_key_and_notifies(self):
        self.connection.failures=2
        failures=iter([FloodWaitError(None,capture=1778),AuthKeyDuplicatedError(None)])
        self.connection.failure_type=lambda ignored:next(failures)
        await telegram.start_telegram();await self.pause_supervisor()
        telegram._retry_not_before=time.monotonic()-1
        self.assertFalse(await telegram._connect_client())
        self.assertIsNone(telegram._pending_client)
        self.assertEqual(self.connection.disconnections,1)
        self.notification.assert_awaited_once_with("Archive connection failed","AuthKeyDuplicatedError:AUTH_KEY",severity="critical")
        self.assertTrue(await telegram._connect_client())
        self.assertEqual(self.connection.constructors,2)
        self.assertIsNot(self.connection.sessions[0],self.connection.sessions[1])

    async def test_session_factory_resets_only_invalid_authorization(self):
        from server.bot_sessions import create_bot_session
        self.connection.failures=1
        self.connection.failure_type=lambda ignored:AuthKeyDuplicatedError(None)
        with patch("server.bot_sessions.create_bot_session",wraps=create_bot_session) as sessions:
            await telegram.start_telegram();await self.pause_supervisor()
            self.assertTrue(await telegram._connect_client())
        self.assertEqual([call.args for call in sessions.call_args_list],[("api",),("api",)])
        self.assertEqual([call.kwargs["reset"] for call in sessions.call_args_list],[False,True])

    async def test_ordinary_connection_failure_does_not_reset_persisted_authorization(self):
        from server.bot_sessions import create_bot_session
        self.connection.failures=1
        with patch("server.bot_sessions.create_bot_session",wraps=create_bot_session) as sessions:
            await telegram.start_telegram();await self.pause_supervisor()
            self.assertTrue(await telegram._connect_client())
        self.assertEqual([call.kwargs["reset"] for call in sessions.call_args_list],[False,False])


if __name__=="__main__":unittest.main()
