"""Exercise real Telethon iterators against Telegram's file request constraints."""
from collections import defaultdict
import logging
from types import SimpleNamespace
import unittest

from telethon.client.downloads import DownloadMethods
from telethon.errors import FileReferenceExpiredError, LimitInvalidError
from telethon.tl.types import InputDocumentFileLocation

from server.streaming import CHUNK_SIZE, telegram_chunks


BLOCK_SIZE = 1024 * 1024


class ProtocolClient(DownloadMethods):
    """No network: keep Telethon's iterator, enforce the actual MTProto limits."""
    def __init__(self, payload, expire_at=None):
        self.payload = payload
        self.expire_at = expire_at
        self.expired = False
        self.requests = []
        self.session = SimpleNamespace(dc_id=1)
        self._sender = object()
        self._mb_entity_cache = SimpleNamespace(self_bot=True)
        self._log = defaultdict(lambda: logging.getLogger(__name__))

    async def _call(self, sender, request):
        offset, limit = request.offset, request.limit
        self.requests.append((offset, limit))
        if (offset % 4096 or limit % 4096 or BLOCK_SIZE % limit
                or offset // BLOCK_SIZE != (offset + limit - 1) // BLOCK_SIZE):
            raise LimitInvalidError(request)
        if offset == self.expire_at and not self.expired:
            self.expired = True
            raise FileReferenceExpiredError(request)
        return SimpleNamespace(bytes=self.payload[offset:offset + limit])


def stored_document(size):
    return SimpleNamespace(
        media=InputDocumentFileLocation(id=1, access_hash=2,
                                       file_reference=b"saved-group", thumb_size=""),
        file=SimpleNamespace(size=size),
    )


class StreamBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_telethon_unaligned_direct_range_reproduces_limit_error(self):
        client = ProtocolClient(b"x" * 2006917)
        iterator = client.iter_download(stored_document(2006917).media,
            offset=983040, request_size=CHUNK_SIZE, chunk_size=CHUNK_SIZE,
            file_size=2006917)
        try:
            with self.assertRaises(LimitInvalidError):
                await iterator.__anext__()
        finally:
            await iterator.close()

    async def test_full_arbitrary_and_boundary_ranges_return_exact_bytes(self):
        payload = bytes(range(251)) * 8500
        message = stored_document(len(payload))
        for start, end in [(0, len(payload) - 1), (983040, len(payload) - 1),
                (BLOCK_SIZE - 1, BLOCK_SIZE + 2), (BLOCK_SIZE, BLOCK_SIZE + 4096),
                (19, 41), (len(payload) - 17, len(payload) - 1)]:
            with self.subTest(start=start, end=end):
                client = ProtocolClient(payload)
                actual = b"".join([part async for part in telegram_chunks(
                    client, message, start, end)])
                self.assertEqual(actual, payload[start:end + 1])
                self.assertEqual(client.requests[0][0], start - start % CHUNK_SIZE)
                self.assertTrue(all(offset % CHUNK_SIZE == 0
                                    for offset, _ in client.requests))
                self.assertEqual(len(client.requests),
                    (end - start + start % CHUNK_SIZE) // CHUNK_SIZE + 1)

    async def test_reference_refresh_at_boundary_resumes_without_duplicate_bytes(self):
        payload = bytes(range(251)) * 8500
        message = stored_document(len(payload))
        client = ProtocolClient(payload, expire_at=BLOCK_SIZE)
        refreshed = []
        async def refresh():
            refreshed.append(True)
            return message
        start, end = BLOCK_SIZE - 65536, BLOCK_SIZE + 400000
        actual = b"".join([part async for part in telegram_chunks(
            client, message, start, end, refresh=refresh)])
        self.assertEqual(actual, payload[start:end + 1])
        self.assertEqual(refreshed, [True])
        self.assertEqual(client.requests, [(786432, CHUNK_SIZE),
            (BLOCK_SIZE, CHUNK_SIZE), (BLOCK_SIZE, CHUNK_SIZE),
            (BLOCK_SIZE + CHUNK_SIZE, CHUNK_SIZE)])

