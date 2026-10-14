"""Message lookup coalescing reduces RPCs without retaining media downloads."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from starlette.requests import Request
from telethon import functions, types
from telethon.errors import FloodWaitError

from server import telegram
from server.media_lookup import MediaLookupCache


def message(media="photo"):
    return SimpleNamespace(media=media, file=SimpleNamespace(size=8, mime_type="image/jpeg", name=None,
                                                           media=SimpleNamespace(id=99)))


class MediaLookupCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 10.0
        self.cache = MediaLookupCache(ttl=2, max_entries=2, clock=lambda: self.now)
        self.client = object()

    async def asyncTearDown(self):
        await self.cache.clear()

    async def get(self, loader, source_id=10, *, force=False, client=None, destination="private"):
        return await self.cache.get(client or self.client, destination, source_id, loader, force=force)

    async def test_ttl_expires_after_load_and_hits_do_not_extend_it(self):
        original, changed = message(), message("changed")
        loader = AsyncMock(side_effect=[original, changed])
        self.assertIs(await self.get(loader), original)
        self.now += 1
        self.assertIs(await self.get(loader), original)
        self.now += 1
        self.assertIs(await self.get(loader), changed)
        self.assertEqual(loader.await_count, 2)

    async def test_capacity_evicts_least_recently_used_metadata(self):
        loader = AsyncMock(side_effect=lambda: message())
        await self.get(loader, 1)
        await self.get(loader, 2)
        await self.get(loader, 1)
        await self.get(loader, 3)
        self.assertEqual(len(self.cache._entries), 2)
        await self.get(loader, 1)
        self.assertEqual(loader.await_count, 3)
        await self.get(loader, 2)
        self.assertEqual(loader.await_count, 4)
        self.assertEqual(len(self.cache._entries), 2)

    async def test_simultaneous_lookups_share_one_loader(self):
        started, release = asyncio.Event(), asyncio.Event()
        result = message()
        async def load():
            started.set()
            await release.wait()
            return result
        loader = AsyncMock(side_effect=load)
        first = asyncio.create_task(self.get(loader))
        await started.wait()
        second = asyncio.create_task(self.get(loader))
        await asyncio.sleep(0)
        release.set()
        self.assertEqual(await asyncio.gather(first, second), [result, result])
        loader.assert_awaited_once()

    async def test_cancelled_caller_does_not_cancel_shared_loader(self):
        started, release = asyncio.Event(), asyncio.Event()
        result = message()
        async def load():
            started.set()
            await release.wait()
            return result
        loader = AsyncMock(side_effect=load)
        first = asyncio.create_task(self.get(loader))
        await started.wait()
        second = asyncio.create_task(self.get(loader))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        self.assertIs(await second, result)
        loader.assert_awaited_once()

    async def test_failure_and_absent_media_are_not_cached(self):
        loader = AsyncMock(side_effect=[ValueError("failure"), None, SimpleNamespace(file=None), message()])
        with self.assertRaises(ValueError):
            await self.get(loader)
        self.assertIsNone(await self.get(loader))
        self.assertIsNone((await self.get(loader)).file)
        self.assertIsNotNone((await self.get(loader)).file)
        self.assertEqual(loader.await_count, 4)

    async def test_forced_refresh_replaces_still_valid_metadata(self):
        first, second = message(), message("fresh-reference")
        loader = AsyncMock(side_effect=[first, second])
        self.assertIs(await self.get(loader), first)
        self.assertIs(await self.get(loader, force=True), second)
        self.assertIs(await self.get(loader), second)
        self.assertEqual(loader.await_count, 2)

    async def test_client_peer_access_hash_and_saved_message_ids_are_separate(self):
        loader = AsyncMock(side_effect=lambda: message())
        first_client, replacement = SimpleNamespace(), SimpleNamespace()
        peer = types.InputPeerChannel(123, 456)
        original = await self.get(loader, client=first_client, destination=peer)
        self.assertIs(await self.get(loader, client=first_client, destination=types.InputPeerChannel(123, 456)), original)
        await self.get(loader, client=replacement, destination=peer)
        await self.get(loader, client=replacement, destination=types.InputPeerChannel(123, 789))
        await self.get(loader, client=replacement, destination=types.InputPeerChannel(124, 789))
        await self.get(loader, 11, client=replacement, destination=types.InputPeerChannel(124, 789))
        self.assertEqual(loader.await_count, 5)

    async def test_shutdown_cancels_loaders_and_clears_bounded_entries(self):
        await self.get(AsyncMock(return_value=message()), 1)
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def load():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        caller = asyncio.create_task(self.get(load, 2))
        await started.wait()
        await self.cache.clear()
        with self.assertRaises(asyncio.CancelledError):
            await caller
        self.assertTrue(cancelled.is_set())
        self.assertEqual(len(self.cache._entries), 0)
        self.assertEqual(len(self.cache._pending), 0)
        self.assertIsNotNone(await self.get(AsyncMock(return_value=message()), 1))


class MediaLookupIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.cache = MediaLookupCache()
        self.cache_patch = patch.object(telegram, "_media_lookups", self.cache)
        self.cache_patch.start()
        self.app = FastAPI()
        self.app.include_router(telegram.router)
        self.store = SimpleNamespace(row=lambda sid: {"status": "copied", "destination_id": 123})

    async def asyncTearDown(self):
        await self.cache.clear()
        self.cache_patch.stop()

    async def test_head_and_image_ranges_share_metadata_but_download_own_bytes(self):
        class Client:
            get_messages = AsyncMock(return_value=message())
            downloads = 0
            def iter_download(self, media, **options):
                self.downloads += 1
                async def chunks():
                    yield b"abcdefgh"
                return chunks()
        fake = Client()
        with patch.object(telegram, "_client", fake), patch.object(telegram, "_store", self.store), \
                patch.object(telegram, "_destination", "private"), patch.object(telegram, "_media_retry_not_before", 0):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
                self.assertEqual((await client.head("/api/media/10")).status_code, 200)
                first = await client.get("/api/media/10", headers={"Range": "bytes=1-3"})
                second = await client.get("/api/media/10", headers={"Range": "bytes=4-7"})
                self.assertEqual(first.content, b"bcd")
                self.assertEqual(second.content, b"efgh")
        fake.get_messages.assert_awaited_once_with("private", ids=123)
        self.assertEqual(fake.downloads, 2)

    async def test_saved_preview_destination_change_does_not_reuse_old_message(self):
        saved_id = [200]
        store = SimpleNamespace(row=self.store.row, media_destination=lambda sid: saved_id[0])
        fake = SimpleNamespace(get_messages=AsyncMock(return_value=message()))
        with patch.object(telegram, "_client", fake), patch.object(telegram, "_store", store), \
                patch.object(telegram, "_destination", "private"), patch.object(telegram, "_media_retry_not_before", 0):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
                self.assertEqual((await client.head("/api/media/10")).status_code, 200)
                saved_id[0] = 201
                self.assertEqual((await client.head("/api/media/10")).status_code, 200)
        self.assertEqual([call.kwargs["ids"] for call in fake.get_messages.await_args_list], [200, 201])

    async def test_expired_reference_forces_fresh_lookup_and_preserves_stream_position(self):
        class FileReferenceExpiredError(Exception):
            pass
        class Client:
            get_messages = AsyncMock(side_effect=[message("old"), message("fresh")])
            def iter_download(self, media, **options):
                async def chunks():
                    if media == "old":
                        yield b"abcd"
                        raise FileReferenceExpiredError()
                    yield b"abcdefgh"
                return chunks()
        fake = Client()
        request = Request({"type": "http", "method": "GET", "headers": []})
        slots = asyncio.Semaphore(1)
        with patch.object(telegram, "_client", fake), patch.object(telegram, "_store", self.store), \
                patch.object(telegram, "_destination", "private"), patch.object(telegram, "_media_retry_not_before", 0), \
                patch.object(telegram, "_slots", slots), patch.object(request, "is_disconnected", AsyncMock(return_value=False)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test") as client:
                self.assertEqual((await client.head("/api/media/10")).status_code, 200)
            response = await telegram.media(10, request)
            self.assertEqual(b"".join([part async for part in response.body_iterator]), b"abcdefgh")
            self.assertEqual(slots._value, 1)
        self.assertEqual(fake.get_messages.await_count, 2)

    async def test_shutdown_clears_integration_cache(self):
        await self.cache.get(object(), "peer", 1, AsyncMock(return_value=message()))
        with patch.object(telegram, "_client", None), patch.object(telegram, "_store", None), \
                patch.object(telegram, "_pending_client", None), patch.object(telegram, "_recovery_task", None):
            await telegram.stop_telegram()
        self.assertEqual(len(self.cache._entries), 0)

    async def test_flood_diagnostics_include_only_request_class_name(self):
        rpc = functions.messages.GetMessagesRequest([types.InputMessageID(987654321)])
        notification = AsyncMock()
        with patch.object(telegram, "notify", notification), patch.object(telegram, "_media_retry_not_before", 0), \
                self.assertLogs(telegram.log, level="WARNING") as logs:
            telegram._record_media_flood(FloodWaitError(rpc, capture=7), 10, "Lookup")
            await asyncio.sleep(0)
        fields = notification.await_args.kwargs["fields"]
        self.assertEqual(fields["route"], "GetMessagesRequest")
        self.assertEqual(fields["stage"], "Lookup")
        self.assertIn("GetMessagesRequest", logs.output[0])
        self.assertNotIn("987654321", str(notification.await_args) + str(logs.output))
        self.assertNotEqual(notification.await_args.kwargs.get("severity"), "critical")


if __name__ == "__main__":
    unittest.main()
