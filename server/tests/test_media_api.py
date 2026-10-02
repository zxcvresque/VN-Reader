from types import SimpleNamespace
import unittest
from unittest.mock import patch, AsyncMock
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

    async def test_disconnected_client_reconnects_and_retries_media_lookup(self):
        class FakeClient:
            connected=False
            reconnects=0
            async def get_messages(self,peer,ids):
                if not self.connected: raise ConnectionError("Cannot send requests while disconnected")
                return SimpleNamespace(file=SimpleNamespace(size=8,mime_type="image/jpeg",name=None,media=SimpleNamespace(id=99)))
            def is_connected(self): return self.connected
            async def connect(self): self.connected=True;self.reconnects+=1
        fake=FakeClient()
        store=SimpleNamespace(row=lambda id: {"status":"copied","destination_id":123})
        app=FastAPI();app.include_router(telegram.router)
        with patch.object(telegram,"_client",fake),patch.object(telegram,"_store",store),patch.object(telegram,"_destination","private"):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
                response=await client.head("/api/media/7")
                self.assertEqual(response.status_code,200)
                self.assertEqual(fake.reconnects,1)

    async def test_operator_events_require_internal_authentication(self):
        import asyncio
        app=FastAPI();app.include_router(telegram.router)
        with patch.dict("os.environ",{"TELEGRAM_BOT_TOKEN":"test-secret"}),patch.object(telegram,"notify",new_callable=AsyncMock) as notification:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
                self.assertEqual((await client.post("/internal/events",json={"event":"Account created"})).status_code,403)
                headers={"Authorization":"Bearer test-secret"}
                self.assertEqual((await client.post("/internal/events",headers=headers,json={"event":"arbitrary"})).status_code,422)
                self.assertEqual((await client.post("/internal/events",headers=headers,json={"event":"Account created","detail":"A new reader signed up."})).status_code,200)
                await asyncio.sleep(0)
                notification.assert_awaited_once_with("Account created","A new reader signed up.",cooldown=0,severity="routine")

    async def test_concurrent_disconnected_lookups_share_one_reconnect(self):
        import asyncio
        class FakeClient:
            connected = False
            reconnects = 0
            async def get_messages(self, peer, ids):
                if not self.connected: raise ConnectionError("disconnected")
                return SimpleNamespace(file=SimpleNamespace(size=8,mime_type="image/jpeg",name=None,media=SimpleNamespace(id=99)))
            def is_connected(self): return self.connected
            async def connect(self):
                self.reconnects += 1
                await asyncio.sleep(.01)
                self.connected = True
        fake = FakeClient()
        app = FastAPI(); app.include_router(telegram.router)
        store = SimpleNamespace(row=lambda id: {"status":"copied","destination_id":123})
        with patch.object(telegram,"_client",fake), patch.object(telegram,"_store",store), patch.object(telegram,"_destination","private"), patch.object(telegram,"_reconnect_lock",asyncio.Lock()), patch.object(telegram,"_slots",asyncio.Semaphore(8)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
                responses = await asyncio.gather(*(client.head(f"/api/media/{id}") for id in range(1,9)))
                self.assertTrue(all(r.status_code == 200 for r in responses))
                self.assertEqual(fake.reconnects,1)

    async def test_reconnect_failure_returns_502_and_releases_slot(self):
        import asyncio
        fake = SimpleNamespace(get_messages=AsyncMock(side_effect=ConnectionError()),is_connected=lambda:False,connect=AsyncMock(side_effect=ConnectionError()))
        app = FastAPI(); app.include_router(telegram.router)
        slots = asyncio.Semaphore(1)
        store = SimpleNamespace(row=lambda id: {"status":"copied","destination_id":123})
        with patch.object(telegram,"_client",fake), patch.object(telegram,"_store",store), patch.object(telegram,"_destination","private"), patch.object(telegram,"_slots",slots), patch.object(telegram,"notify",AsyncMock()):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
                self.assertEqual((await client.head("/api/media/7")).status_code,502)
                self.assertFalse(slots.locked())

    async def test_stream_connection_failure_resumes_without_duplicate_bytes(self):
        from server.streaming import telegram_chunks
        class FakeClient:
            offsets = []
            def iter_download(self, media, **kwargs):
                offset = kwargs["offset"]
                self.offsets.append(offset)
                async def chunks():
                    if len(self.offsets) == 1:
                        yield b"abcd"
                        raise ConnectionError("disconnected mid-download")
                    yield b"abcdefgh"[offset:]
                return chunks()
        fake = FakeClient()
        message = SimpleNamespace(media="photo",file=SimpleNamespace(size=8))
        refresh = AsyncMock(return_value=message)
        data = b"".join([part async for part in telegram_chunks(fake,message,0,7,refresh=refresh)])
        self.assertEqual(data,b"abcdefgh")
        self.assertEqual(fake.offsets,[0,0])
        refresh.assert_awaited_once()

    async def test_internal_events_only_allow_critical_failure_types(self):
        import asyncio
        app = FastAPI(); app.include_router(telegram.router)
        headers = {"Authorization":"Bearer test-secret"}
        with patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN":"test-secret"}), patch.object(telegram,"notify",AsyncMock()) as notification:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://test") as client:
                for payload in [{"event":[]}, {"event":"OTP email delivery failed","severity":[]}, {"event":"Account created","severity":"critical"}, {"event":"OTP email delivery failed","severity":"unknown"}, {"event":"OTP email delivery failed","detail":"x"*201}]:
                    self.assertEqual((await client.post("/internal/events",headers=headers,json=payload)).status_code,422)
                response = await client.post("/internal/events",headers=headers,json={"event":"Account service startup failed","detail":"Error","severity":"critical"})
                self.assertEqual(response.status_code,200)
                await asyncio.sleep(0)
                notification.assert_awaited_once_with("Account service startup failed","Error",cooldown=300,severity="critical")

    async def test_invalid_stream_auth_resumes_with_the_replacement_client(self):
        from server.streaming import telegram_chunks
        class AuthKeyDuplicatedError(Exception): pass
        class Client:
            def __init__(self, broken): self.broken=broken;self.offsets=[]
            def iter_download(self, media, **kwargs):
                self.offsets.append(kwargs["offset"])
                async def chunks():
                    if self.broken:
                        yield b"abcd"
                        raise AuthKeyDuplicatedError()
                    yield b"abcdefgh"[kwargs["offset"]:]
                return chunks()
        old, new = Client(True), Client(False)
        current = [old]
        message = SimpleNamespace(media="photo", file=SimpleNamespace(size=8))
        async def refresh():
            current[0] = new
            return message
        data = b"".join([part async for part in telegram_chunks(old,message,0,7,refresh=refresh,get_client=lambda:current[0])])
        self.assertEqual(data,b"abcdefgh")
        self.assertEqual(old.offsets,[0])
        self.assertEqual(new.offsets,[0])
