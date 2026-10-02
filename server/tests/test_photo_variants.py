"""Regression coverage for Telegram photos whose biggest JPEG is not widest."""
import asyncio
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from telethon.tl.types import (
    InputPhotoFileLocation, Message, MessageMediaPhoto, PeerChannel, Photo,
    PhotoSize, PhotoSizeProgressive, PhotoCachedSize,
)

from server import telegram
from server.streaming import telegram_chunks


def photo_message(sizes, reference=b"original-reference"):
    photo = Photo(id=9876, access_hash=1234, file_reference=reference,
                  date=None, sizes=sizes, dc_id=4)
    return Message(id=4321, peer_id=PeerChannel(99),
                   media=MessageMediaPhoto(photo=photo))


class VariantClient:
    def __init__(self, message, payloads):
        self.message = message
        self.payloads = payloads
        self.requests = []

    async def get_messages(self, peer, ids):
        if peer != "private-group" or ids != 4321:
            raise AssertionError("Media must be retrieved from the mapped private copy")
        return self.message

    def iter_download(self, location, **kwargs):
        self.requests.append((location, kwargs))
        # Model Telethon's default photo selection too, so the old path actually
        # ends early instead of passing because a fake trusts Content-Length.
        variant = (location.thumb_size if isinstance(location, InputPhotoFileLocation)
                   else location.photo.sizes[-1].type)
        payload = self.payloads[variant]
        async def chunks():
            for start in range(kwargs["offset"], len(payload), 8192):
                yield payload[start:start + 8192]
        return chunks()


class PhotoVariantTests(unittest.IsolatedAsyncioTestCase):
    def relay(self, fake):
        patches = ExitStack()
        patches.enter_context(patch.object(telegram, "_client", fake))
        patches.enter_context(patch.object(telegram, "_destination", "private-group"))
        patches.enter_context(patch.object(telegram, "_slots", asyncio.Semaphore(8)))
        patches.enter_context(patch.object(telegram, "_store", SimpleNamespace(
            row=lambda source: {"status": "copied", "destination_id": 4321}
            if source == 43 else None)))
        self.addCleanup(patches.close)
        app = FastAPI()
        app.include_router(telegram.router)
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def test_get_head_and_ranges_use_one_complete_photo_representation(self):
        message = photo_message([
            PhotoSize(type="x", w=800, h=600, size=74815),
            PhotoSize(type="y", w=1280, h=720, size=61067),
        ])
        self.assertEqual(message.file.size, 74815)  # Real Telethon metadata mismatch.
        payload = bytes(index % 251 for index in range(61067))
        fake = VariantClient(message, {"x": b"x" * 74815, "y": payload})
        async with self.relay(fake) as client:
            head = await client.head("/api/media/43")
            self.assertEqual(head.status_code, 200)
            self.assertEqual(head.headers["content-length"], "61067")
            self.assertEqual(head.content, b"")
            self.assertEqual(fake.requests, [])

            full = await client.get("/api/media/43")
            self.assertEqual(full.status_code, 200)
            self.assertEqual(full.content, payload)
            self.assertEqual(len(full.content), int(full.headers["content-length"]))
            self.assertEqual(full.headers["etag"], head.headers["etag"])

            ranged = await client.get("/api/media/43", headers={
                "Range": "bytes=60000-", "If-Range": head.headers["etag"]})
            self.assertEqual(ranged.status_code, 206)
            self.assertEqual(ranged.headers["content-range"], "bytes 60000-61066/61067")
            self.assertEqual(ranged.content, payload[60000:])
            self.assertEqual(int(ranged.headers["content-length"]), len(ranged.content))

            stale = await client.get("/api/media/43", headers={
                "Range": "bytes=60000-", "If-Range": '"old-photo"'})
            self.assertEqual(stale.status_code, 200)
            self.assertEqual(stale.content, payload)
            missing = await client.get("/api/media/43", headers={"Range": "bytes=61067-"})
            self.assertEqual(missing.status_code, 416)
            self.assertEqual(missing.headers["content-range"], "bytes */61067")

        for location, options in fake.requests:
            self.assertIsInstance(location, InputPhotoFileLocation)
            self.assertEqual((location.id, location.access_hash, location.thumb_size),
                             (9876, 1234, "y"))
            self.assertEqual(options["file_size"], 61067)
            self.assertEqual(options["dc_id"], 4)

    async def test_progressive_photo_streams_final_scan_byte_count(self):
        message = photo_message([
            PhotoSize(type="x", w=800, h=600, size=74815),
            PhotoSizeProgressive(type="y", w=1280, h=720, sizes=[1024, 20480, 61067]),
        ])
        fake = VariantClient(message, {"x": b"x" * 74815, "y": b"y" * 61067})
        async with self.relay(fake) as client:
            response = await client.get("/api/media/43", headers={"Range": "bytes=-67"})
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.headers["content-range"], "bytes 61000-61066/61067")
            self.assertEqual(response.headers["content-length"], "67")
            self.assertEqual(response.content, b"y" * 67)
        self.assertEqual(fake.requests[0][1]["file_size"], 61067)
        self.assertEqual(fake.requests[0][0].thumb_size, "y")

    async def test_expired_reference_refreshes_same_variant_and_resumes_exact_offset(self):
        original = photo_message([
            PhotoSize(type="x", w=800, h=600, size=9),
            PhotoSize(type="y", w=1280, h=720, size=8),
        ])
        refreshed = photo_message(list(reversed(original.photo.sizes)), reference=b"fresh-reference")
        class FileReferenceExpiredError(Exception):
            pass
        class RefreshClient:
            def __init__(self):
                self.requests = []
            def iter_download(self, location, **kwargs):
                self.requests.append((location, kwargs))
                async def chunks():
                    if len(self.requests) == 1:
                        yield b"abcd"
                        raise FileReferenceExpiredError()
                    yield b"efgh"
                return chunks()
        fake = RefreshClient()
        async def refresh():
            return refreshed
        result = b"".join([part async for part in telegram_chunks(
            fake, original, 0, 7, refresh=refresh)])
        self.assertEqual(result, b"abcdefgh")
        self.assertEqual([options["offset"] for _, options in fake.requests], [0, 4])
        self.assertEqual([location.thumb_size for location, _ in fake.requests], ["y", "y"])
        self.assertEqual([location.file_reference for location, _ in fake.requests],
                         [b"original-reference", b"fresh-reference"])
        self.assertTrue(all(options["file_size"] == 8 for _, options in fake.requests))

    async def test_cached_photo_uses_embedded_bytes_and_exact_range(self):
        payload=b"cached-jpeg-bytes"
        message=photo_message([PhotoCachedSize(type="y",w=320,h=240,bytes=payload)])
        fake=VariantClient(message,{})
        async with self.relay(fake) as client:
            response=await client.get("/api/media/43",headers={"Range":"bytes=2-7"})
            self.assertEqual(response.status_code,206)
            self.assertEqual(response.content,payload[2:8])
            self.assertEqual(response.headers["content-length"],"6")
            self.assertEqual(response.headers["cache-control"],"no-store")
        self.assertEqual(fake.requests,[])
