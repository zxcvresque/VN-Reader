from types import SimpleNamespace
import unittest
from unittest.mock import patch
import httpx
from fastapi import FastAPI
from server import telegram

class MediaAPITests(unittest.IsolatedAsyncioTestCase):
    async def test_photo_native_id_head_range_and_missing_mapping(self):
        class PhotoFile:
            size=32
            mime_type='image/jpeg'
            name=None
            media=SimpleNamespace(id=9876)
            @property
            def id(self): raise AttributeError('Obsolete photo packing must not be used')
        class FakeClient:
            async def get_messages(self,peer,ids): return SimpleNamespace(file=PhotoFile(),media='photo')
            def iter_download(self,media,**kw):
                async def chunks(): yield bytes(range(kw['offset'],32))
                return chunks()
        store=SimpleNamespace(row=lambda id: {'status':'copied','destination_id':123} if id==7 else None)
        app=FastAPI();app.include_router(telegram.router)
        with patch.object(telegram,'_client',FakeClient()),patch.object(telegram,'_store',store),patch.object(telegram,'_destination','private'):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
                head=await client.head('/api/media/7')
                self.assertEqual(head.status_code,200)
                self.assertEqual(head.headers['etag'],'"tg-7-9876-32"')
                self.assertEqual(head.headers['content-length'],'32')
                self.assertEqual(head.content,b'')
                part=await client.get('/api/media/7',headers={'Range':'bytes=2-17'})
                self.assertEqual(part.status_code,206)
                self.assertEqual(part.content,bytes(range(2,18)))
                self.assertEqual(part.headers['content-range'],'bytes 2-17/32')
                self.assertEqual((await client.get('/api/media/7',headers={'Range':'bytes=32-'})).status_code,416)
                self.assertEqual((await client.get('/api/media/999')).status_code,404)
