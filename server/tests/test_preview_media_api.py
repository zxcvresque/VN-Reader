"""Saved preview attachments and expired previews use distinct delivery paths."""
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from telethon.tl.types import MessageMediaWebPage, WebPageEmpty

from server import telegram


class PreviewMediaAPITests(IsolatedAsyncioTestCase):
    async def request(self, store, fake, method='HEAD'):
        app = FastAPI()
        app.include_router(telegram.router)
        with patch.object(telegram, '_client', fake), patch.object(telegram, '_store', store), patch.object(telegram, '_destination', 'private'):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                return await client.request(method, '/api/media/4336')

    async def test_uses_dedicated_saved_attachment_without_changing_post_mapping(self):
        seen = []
        class Client:
            async def get_messages(self, peer, ids):
                seen.append((peer, ids))
                return SimpleNamespace(file=SimpleNamespace(size=100, mime_type='image/jpeg', name=None, media=SimpleNamespace(id=99)))
        row = {'status': 'copied', 'destination_id': 4117}
        store = SimpleNamespace(row=lambda sid: row, media_destination=lambda sid: 5001)
        response = await self.request(store, Client())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['content-length'], '100')
        self.assertEqual(seen, [('private', 5001)])
        self.assertEqual(row['destination_id'], 4117)

    async def test_expired_webpage_returns_explicit_noncacheable_410_for_get_and_head(self):
        class Client:
            async def get_messages(self, peer, ids):
                return SimpleNamespace(file=None, media=MessageMediaWebPage(webpage=WebPageEmpty(id=4, url='https://example.org/article')))
        store = SimpleNamespace(row=lambda sid: {'status': 'copied', 'destination_id': 4117})
        for method in ['GET', 'HEAD']:
            response = await self.request(store, Client(), method)
            self.assertEqual(response.status_code, 410)
            self.assertEqual(response.headers['x-media-status'], 'link-preview-unavailable')
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertNotIn('example.org', response.text)

    async def test_missing_attachment_keeps_404_and_is_not_misclassified_as_preview(self):
        class Client:
            async def get_messages(self, peer, ids):
                return None
        store = SimpleNamespace(row=lambda sid: {'status': 'copied', 'destination_id': 4117})
        response = await self.request(store, Client())
        self.assertEqual(response.status_code, 404)
        self.assertNotIn('x-media-status', response.headers)
