"""Telegram flood waits resume the same repair RPC without duplicating uploads."""
import asyncio
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock

from telethon import functions, types
from telethon.errors import FloodWaitError, MediaEmptyError
from telethon.tl.custom.file import File

from server.mirror import MirrorStore, TelegramWriter, repair_media


SOURCE={"chat_id":-100123,"chat_username":"VidurNeeti","chat_title":"VN"}
URL="https://example.com/original-article"


def photo():
    return types.Photo(id=123,access_hash=456,file_reference=b"reference",date=None,
                       sizes=[types.PhotoSize("x",800,600,4096)],dc_id=4)


def preview(source_id=40,empty=False):
    page=types.WebPageEmpty(id=123,url=URL) if empty else types.WebPage(
        id=123,url=URL,display_url=URL,hash=0,photo=photo())
    return types.Message(id=source_id,peer_id=types.PeerChannel(123),
                         message=f"Original passage {URL}",media=types.MessageMediaWebPage(page))


class SendingBot:
    def __init__(self,outcomes):self.outcomes=list(outcomes);self.requests=[];self.uploads=[]
    async def __call__(self,request):
        self.requests.append(request)
        outcome=self.outcomes.pop(0) if self.outcomes else None
        if outcome is not None:raise outcome
        return SimpleNamespace(updates=[types.UpdateMessageID(6000,request.random_id)])
    async def upload_file(self,buffer,file_name):
        self.uploads.append((buffer.read(),file_name))
        return types.InputFile(1,1,file_name,"hash")


class DownloadReader:
    def __init__(self):self.downloads=[]
    async def download_media(self,media,file):
        self.downloads.append(media);file.write(b"jpeg-bytes")


class PreviewRateLimitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.store=MirrorStore(Path(self.directory.name)/"mirror.sqlite")
        self.addCleanup(self.store.close);self.store.bind(SOURCE,-100999)
        self.store.prepare(preview(),SOURCE);self.store.complete([4117],[preview()],SOURCE)

    async def test_direct_send_waits_and_reuses_request_and_random_id(self):
        bot=SendingBot([FloodWaitError(None,capture=3),None]);waiter=AsyncMock()
        writer=TelegramWriter(bot,"saved-group",store=self.store)
        await writer.save_preview_file(40,File(photo()),flood_waiter=waiter)
        self.assertEqual(waiter.await_count,1)
        self.assertEqual(waiter.await_args.args[0],4)
        self.assertIs(bot.requests[0],bot.requests[1])
        self.assertEqual(bot.requests[0].random_id,bot.requests[1].random_id)
        self.assertEqual(self.store.media_destination(40),6000)
        self.assertEqual(bot.uploads,[])

    async def test_uploaded_send_waits_without_repeating_download_or_upload(self):
        bot=SendingBot([MediaEmptyError(None),FloodWaitError(None,capture=3),None])
        reader=DownloadReader();waiter=AsyncMock()
        writer=TelegramWriter(bot,"saved-group",store=self.store)
        await writer.save_preview_file(40,File(photo()),reader,flood_waiter=waiter)
        self.assertEqual(waiter.await_count,1)
        self.assertEqual(waiter.await_args.args[0],4)
        self.assertEqual(len(reader.downloads),1)
        self.assertEqual(len(bot.uploads),1)
        self.assertIsInstance(bot.requests[1].media,types.InputMediaUploadedPhoto)
        self.assertIs(bot.requests[1],bot.requests[2])
        self.assertEqual(bot.requests[0].random_id,bot.requests[1].random_id)
        self.assertEqual(self.store.media_destination(40),6000)

    async def test_download_and_upload_retries_reset_the_payload_buffer(self):
        class InterruptedBot(SendingBot):
            def __init__(self):super().__init__([MediaEmptyError(None),None]);self.upload_attempts=0
            async def upload_file(self,buffer,file_name):
                self.upload_attempts+=1
                if self.upload_attempts==1:
                    self.uploads.append((buffer.read(3),file_name))
                    raise FloodWaitError(None,capture=1)
                return await super().upload_file(buffer,file_name)
        class InterruptedReader(DownloadReader):
            async def download_media(self,media,file):
                self.downloads.append(media)
                if len(self.downloads)==1:
                    file.write(b"partial-")
                    raise FloodWaitError(None,capture=2)
                file.write(b"complete-jpeg")
        bot=InterruptedBot();reader=InterruptedReader();waiter=AsyncMock()
        writer=TelegramWriter(bot,"saved-group",store=self.store)
        await writer.save_preview_file(40,File(photo()),reader,flood_waiter=waiter)
        self.assertEqual(len(reader.downloads),2)
        self.assertEqual(bot.upload_attempts,2)
        self.assertEqual(bot.uploads[-1][0],b"complete-jpeg")
        self.assertEqual(sorted(call.args[0] for call in waiter.await_args_list),[2,3])
        self.assertEqual(self.store.media_destination(40),6000)

    async def test_normal_watch_without_wait_callback_propagates_flood_wait(self):
        bot=SendingBot([FloodWaitError(None,capture=3),None])
        writer=TelegramWriter(bot,"saved-group",store=self.store)
        with self.assertRaises(FloodWaitError):
            await writer.save_preview_file(40,File(photo()))
        self.assertEqual(len(bot.requests),1)
        self.assertEqual(self.store.media_destination(40),4117)

    async def test_repair_waits_for_batch_source_preview_and_send_preserving_healthy_rows(self):
        native=types.Message(id=7,peer_id=types.PeerChannel(123),message="Healthy",
                             media=types.MessageMediaPhoto(photo=photo()))
        self.store.prepare(native,SOURCE);self.store.complete([4100],[native],SOURCE)
        healthy=types.Message(id=4100,peer_id=types.PeerChannel(999),media=types.MessageMediaPhoto(photo=photo()))
        class BatchBot(SendingBot):
            def __init__(self):super().__init__([FloodWaitError(None,capture=4),None]);self.lookups=[]
            async def get_messages(self,peer,ids):
                self.lookups.append((peer,ids))
                if len(self.lookups)==1:raise FloodWaitError(None,capture=3)
                return [healthy if source_id==4100 else preview(4117,empty=True) for source_id in ids]
        class SourceReader:
            def __init__(self):self.lookups=[];self.requests=[]
            async def get_messages(self,peer,ids):
                self.lookups.append((peer,ids))
                if len(self.lookups)==1:raise FloodWaitError(None,capture=1)
                return preview(empty=True)
            async def __call__(self,request):
                self.requests.append(request)
                if len(self.requests)==1:raise FloodWaitError(None,capture=2)
                return SimpleNamespace(media=preview().media)
        bot=BatchBot();reader=SourceReader()
        progress=SimpleNamespace(wait=AsyncMock(),notice=Mock())
        writer=TelegramWriter(bot,"saved-group",store=self.store,reader=reader)
        counts=await repair_media(reader,writer,self.store,"public-source",progress)
        self.assertEqual(counts,{"checked":2,"healthy":1,"repaired":1,"unrecoverable":0,"failed":0})
        self.assertEqual(progress.wait.await_count,4)
        self.assertEqual(sorted(call.args[0] for call in progress.wait.await_args_list),[2,3,4,5])
        self.assertEqual(bot.lookups[0],bot.lookups[1])
        self.assertEqual(reader.lookups[0],reader.lookups[1])
        self.assertIs(reader.requests[0],reader.requests[1])
        self.assertIsInstance(reader.requests[0],functions.messages.GetWebPagePreviewRequest)
        self.assertEqual(reader.requests[0].message,URL)
        self.assertEqual(self.store.media_destination(7),4100)
        self.assertEqual(self.store.row(40)["destination_id"],4117)
        self.assertEqual(self.store.media_destination(40),6000)
        self.assertEqual(self.store.meta("checkpoint"),40)

    async def test_cancel_during_flood_wait_propagates_without_overwriting_mapping(self):
        bot=SendingBot([FloodWaitError(None,capture=3),None])
        waiter=AsyncMock(side_effect=asyncio.CancelledError())
        writer=TelegramWriter(bot,"saved-group",store=self.store)
        with self.assertRaises(asyncio.CancelledError):
            await writer.save_preview_file(40,File(photo()),flood_waiter=waiter)
        self.assertEqual(len(bot.requests),1)
        self.assertEqual(self.store.media_destination(40),4117)

    async def test_ordinary_error_is_not_retried_or_treated_as_rate_limit(self):
        bot=SendingBot([RuntimeError("ordinary failure"),None]);waiter=AsyncMock()
        writer=TelegramWriter(bot,"saved-group",store=self.store)
        with self.assertRaisesRegex(RuntimeError,"ordinary failure"):
            await writer.save_preview_file(40,File(photo()),flood_waiter=waiter)
        self.assertEqual(len(bot.requests),1)
        waiter.assert_not_awaited()
        self.assertEqual(self.store.media_destination(40),4117)


if __name__=="__main__":unittest.main()
