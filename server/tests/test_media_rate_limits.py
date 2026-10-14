"""Media FloodWaits share a deadline, release slots and never send critical alerts."""
import asyncio
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from starlette.requests import Request
from telethon.errors import FloodWaitError

from server import telegram
from server.streaming import telegram_chunks


def message():
    return SimpleNamespace(media="photo", file=SimpleNamespace(size=8, mime_type="image/jpeg", name=None, media=SimpleNamespace(id=99)))


class MediaRateLimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_lookup_returns_retry_after_and_blocks_other_posts_until_deadline(self):
        fake = SimpleNamespace(get_messages=AsyncMock(side_effect=[FloodWaitError(None, capture=37), message()]))
        store = SimpleNamespace(row=lambda sid: {"status": "copied", "destination_id": sid + 100})
        app = FastAPI(); app.include_router(telegram.router)
        slots = asyncio.Semaphore(1)
        notification = AsyncMock()
        with patch.object(telegram, "_client", fake), patch.object(telegram, "_store", store), patch.object(telegram, "_destination", "private"), patch.object(telegram, "_slots", slots), patch.object(telegram, "_media_retry_not_before", 0), patch.object(telegram, "notify", notification):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                response = await client.head("/api/media/1600")
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.headers["retry-after"], "38")
                self.assertEqual(response.headers["x-media-status"], "rate-limited")
                self.assertEqual(slots._value, 1)
                self.assertEqual((await client.get("/api/media/1601")).status_code, 503)
                fake.get_messages.assert_awaited_once()
                telegram._media_retry_not_before = time.monotonic() - 1
                self.assertEqual((await client.head("/api/media/1601")).status_code, 200)
                self.assertEqual(fake.get_messages.await_count, 2)
                self.assertIs(telegram._client, fake)
                await asyncio.sleep(0)
        notification.assert_awaited_once()
        self.assertEqual(notification.await_args.args[0], "Media rate limited")
        self.assertEqual(notification.await_args.kwargs["fields"], {"post": "#1600", "stage": "Lookup", "retryAfter": "38s", "error": "FloodWaitError"})
        self.assertNotEqual(notification.await_args.kwargs.get("severity"), "critical")

    async def test_short_download_cooldown_resumes_exact_range_and_is_bounded(self):
        class Client:
            offsets = []
            def iter_download(self, media, **kwargs):
                self.offsets.append(kwargs["offset"])
                attempt = len(self.offsets)
                async def chunks():
                    if attempt == 1:
                        yield b"abcd"
                        raise FloodWaitError(None, capture=1)
                    yield b"abcdefgh"[kwargs["offset"]:]
                return chunks()
        fake = Client(); wait = AsyncMock(return_value=True)
        data = b"".join([part async for part in telegram_chunks(fake, message(), 1, 6, flood_wait=wait)])
        self.assertEqual(data, b"bcdefg")
        self.assertEqual(fake.offsets, [0, 0])
        wait.assert_awaited_once()

        class AlwaysLimited:
            def iter_download(self, media, **kwargs):
                async def chunks():
                    raise FloodWaitError(None, capture=1)
                    yield b""
                return chunks()
        wait = AsyncMock(return_value=True)
        with self.assertRaises(FloodWaitError):
            _ = [part async for part in telegram_chunks(AlwaysLimited(), message(), 0, 7, flood_wait=wait)]
        self.assertEqual(wait.await_count, 3)

    async def test_long_stream_cooldown_releases_slot_and_is_routine(self):
        class Client:
            get_messages = AsyncMock(return_value=message())
            def iter_download(self, media, **kwargs):
                async def chunks():
                    yield b"abcd"
                    raise FloodWaitError(None, capture=37)
                return chunks()
        store = SimpleNamespace(row=lambda sid: {"status": "copied", "destination_id": 123})
        slots = asyncio.Semaphore(1); notification = AsyncMock()
        request = Request({"type": "http", "method": "GET", "headers": []})
        with patch.object(telegram, "_client", Client()), patch.object(telegram, "_store", store), patch.object(telegram, "_destination", "private"), patch.object(telegram, "_slots", slots), patch.object(telegram, "_media_retry_not_before", 0), patch.object(telegram, "notify", notification):
            # A direct iterator keeps the already-sent HTTP status out of this assertion.
            with patch.object(request, "is_disconnected", AsyncMock(return_value=False)):
                response = await telegram.media(1600, request)
                self.assertEqual(await anext(response.body_iterator), b"abcd")
                with self.assertRaises(FloodWaitError):
                    await anext(response.body_iterator)
            await asyncio.sleep(0)
            self.assertGreaterEqual(telegram._media_retry_remaining(), 37)
            self.assertEqual(slots._value, 1)
        notification.assert_awaited_once()
        self.assertEqual(notification.await_args.args[0], "Media rate limited")
        self.assertEqual(notification.await_args.kwargs["fields"]["stage"], "Download")
        self.assertNotEqual(notification.await_args.kwargs.get("severity"), "critical")

    async def test_genuine_lookup_failure_still_alerts_owner(self):
        fake = SimpleNamespace(get_messages=AsyncMock(side_effect=ValueError("unsafe error detail")))
        store = SimpleNamespace(row=lambda sid: {"status": "copied", "destination_id": 123})
        app = FastAPI(); app.include_router(telegram.router)
        notification = AsyncMock()
        with patch.object(telegram, "_client", fake), patch.object(telegram, "_store", store), patch.object(telegram, "_destination", "private"), patch.object(telegram, "_media_retry_not_before", 0), patch.object(telegram, "notify", notification):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                self.assertEqual((await client.head("/api/media/1600")).status_code, 502)
                await asyncio.sleep(0)
        self.assertEqual(notification.await_args.kwargs["severity"], "critical")
        self.assertEqual(notification.await_args.kwargs["fields"]["error"], "ValueError")
        self.assertNotIn("unsafe", str(notification.await_args))

    async def test_flood_after_connection_retry_still_returns_routine_cooldown(self):
        fake = SimpleNamespace(get_messages=AsyncMock(side_effect=[ConnectionError(), FloodWaitError(None, capture=37)]), is_connected=lambda: True)
        store = SimpleNamespace(row=lambda sid: {"status": "copied", "destination_id": 123})
        app = FastAPI(); app.include_router(telegram.router)
        notification = AsyncMock()
        with patch.object(telegram, "_client", fake), patch.object(telegram, "_store", store), patch.object(telegram, "_destination", "private"), patch.object(telegram, "_media_retry_not_before", 0), patch.object(telegram, "notify", notification):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                self.assertEqual((await client.head("/api/media/1600")).status_code, 503)
                await asyncio.sleep(0)
        self.assertEqual(fake.get_messages.await_count, 2)
        notification.assert_awaited_once()
        self.assertEqual(notification.await_args.args[0], "Media rate limited")

    async def test_http_stream_waits_briefly_and_resumes_without_new_lookup(self):
        class Client:
            get_messages = AsyncMock(return_value=message())
            downloads = 0
            def iter_download(self, media, **kwargs):
                self.downloads += 1
                attempt = self.downloads
                async def chunks():
                    if attempt == 1:
                        yield b"abcd"
                        raise FloodWaitError(None, capture=1)
                    yield b"abcdefgh"
                return chunks()
        fake = Client(); notification = AsyncMock(); slots = asyncio.Semaphore(1)
        store = SimpleNamespace(row=lambda sid: {"status": "copied", "destination_id": 123})
        request = Request({"type": "http", "method": "GET", "headers": []})
        real_sleep = asyncio.sleep
        async def finish_cooldown(seconds):
            self.assertLessEqual(seconds, 5)
            telegram._media_retry_not_before = time.monotonic() - 1
            await real_sleep(0)
        with patch.object(telegram, "_client", fake), patch.object(telegram, "_store", store), patch.object(telegram, "_destination", "private"), patch.object(telegram, "_slots", slots), patch.object(telegram, "_media_retry_not_before", 0), patch.object(telegram, "notify", notification), patch.object(request, "is_disconnected", AsyncMock(return_value=False)), patch.object(telegram.asyncio, "sleep", side_effect=finish_cooldown) as sleep:
            response = await telegram.media(1600, request)
            data = b"".join([part async for part in response.body_iterator])
            self.assertEqual(data, b"abcdefgh")
            sleep.assert_awaited_once()
            self.assertEqual(fake.downloads, 2)
            fake.get_messages.assert_awaited_once()
            self.assertEqual(slots._value, 1)
        notification.assert_awaited_once()
        self.assertEqual(notification.await_args.args[0], "Media rate limited")
