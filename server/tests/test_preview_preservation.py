"""Preview attachments survive Telegram discarding regenerated WebPage data."""
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest

from telethon import functions, types

from server.mirror import Mirror, MirrorStore, TelegramWriter, public_preview_urls, record, repair_media

SOURCE={"chat_id":-100123,"chat_username":"VidurNeeti","chat_title":"VN"}
URL="https://startupstorymedia.com/article"


def photo():
    return types.Photo(id=123,access_hash=456,file_reference=b"reference",date=None,
                       sizes=[types.PhotoSize("x",800,600,49516)],dc_id=4)


def preview(source_id=4336,empty=False):
    page=types.WebPageEmpty(id=123,url=URL) if empty else types.WebPage(
        id=123,url=URL,display_url=URL,hash=0,photo=photo())
    return types.Message(id=source_id,peer_id=types.PeerChannel(123),
                         message=f"Original passage {URL}",media=types.MessageMediaWebPage(page))


class Bot:
    def __init__(self,source,saved=None,fail=False):
        self.source=source;self.saved=saved or {};self.requests=[];self.fail=fail
    async def get_messages(self,peer,ids):
        if isinstance(ids,list):return [self.saved.get(i) for i in ids]
        return self.source
    async def __call__(self,request):
        self.requests.append(request)
        if self.fail and isinstance(request,functions.messages.SendMediaRequest):raise RuntimeError("simulated failure")
        if isinstance(request,functions.messages.ForwardMessagesRequest):
            updates=[types.UpdateMessageID(4117+i,rid) for i,rid in enumerate(request.random_id)]
        else:updates=[types.UpdateMessageID(6000,request.random_id)]
        return SimpleNamespace(updates=updates)


class Reader:
    def __init__(self,source,regenerated=None):self.source=source;self.regenerated=regenerated;self.requests=[]
    async def get_messages(self,peer,ids):return self.source
    async def __call__(self,request):
        self.requests.append(request)
        return self.regenerated


class PreviewPreservationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.store=MirrorStore(Path(self.directory.name)/"mirror.sqlite")
        self.addCleanup(self.store.close);self.store.bind(SOURCE,-100999)
    def complete(self,message,destination=4117):
        self.store.prepare(message,SOURCE);self.store.complete([destination],[message],SOURCE)

    async def test_native_forward_preserves_attachment_once_without_changing_reply_mapping(self):
        message=preview();bot=Bot(message)
        writer=TelegramWriter(bot,"saved-group",topic_id=10,source_peer="source",store=self.store)
        mirror=Mirror(None,writer,self.store,SOURCE,"source")
        await mirror.copy_batch([message]);await mirror.copy_batch([message])
        attachments=[r for r in bot.requests if isinstance(r,functions.messages.SendMediaRequest)]
        self.assertEqual(len(attachments),1)
        self.assertIsInstance(attachments[0].media,types.InputMediaPhoto)
        self.assertEqual(attachments[0].reply_to.reply_to_msg_id,4117)
        self.assertEqual(self.store.row(4336)["destination_id"],4117)
        self.assertEqual(self.store.media_destination(4336),6000)
        self.assertEqual(self.store.meta("checkpoint"),4336)
        self.assertEqual(record(message,SOURCE)["media_origin"],"link-preview")

    async def test_saved_preview_metadata_and_attachment_survive_empty_webpage_refresh(self):
        message=preview();message.media.webpage.title="Original article title"
        message.media.webpage.description="Original article summary"
        self.complete(message);self.store.save_media_destination(4336,6000)
        self.store.complete([4117],[preview(empty=True)],SOURCE,advance=False)
        body=json.loads(self.store.row(4336)["record"])
        self.assertEqual(body["media_preview"]["title"],"Original article title")
        self.assertEqual(body["media_preview"]["description"],"Original article summary")
        self.assertTrue(body["media_present"])
        self.assertEqual(body["media_path"],"/api/media/4336")
        self.assertEqual(body["media_kind"],"photo")
        self.assertEqual(body["media_raw"]["size"],49516)
        self.assertEqual(self.store.media_destination(4336),6000)

    async def test_empty_preview_without_dedicated_attachment_keeps_metadata_only(self):
        original=preview();original.media.webpage.title="An article"
        self.complete(original)
        self.store.complete([4117],[preview(empty=True)],SOURCE,advance=False)
        body=json.loads(self.store.row(4336)["record"])
        self.assertFalse(body["media_present"])
        self.assertIsNone(body["media_path"])
        self.assertEqual(body["media_kind"],"webpage")
        self.assertEqual(body["media_preview"]["title"],"An article")

    async def test_pending_expired_preview_does_not_silently_advance_checkpoint(self):
        self.store.prepare(preview(),SOURCE)
        bot=Bot(preview(empty=True));reader=Reader(preview(empty=True),SimpleNamespace(media=preview().media))
        writer=TelegramWriter(bot,"saved-group",source_peer="source",store=self.store,reader=reader)
        with self.assertRaisesRegex(RuntimeError,"expired before preservation"):
            await Mirror(None,writer,self.store,SOURCE,"source").copy_batch([preview(empty=True)])
        self.assertEqual(self.store.meta("checkpoint",0),0)
        self.assertEqual(self.store.row(4336)["status"],"pending")
        self.assertEqual(reader.requests,[])  # URL regeneration is operator-only.
        bot.saved={4117:preview(4117,empty=True)}
        result=await repair_media(reader,writer,self.store,"source")
        self.assertEqual(result["repaired"],1)
        self.assertEqual(self.store.meta("checkpoint",0),0)
        await Mirror(None,writer,self.store,SOURCE,"source").copy_batch([preview(empty=True)])
        self.assertEqual(self.store.meta("checkpoint"),4336)
        self.assertTrue(json.loads(self.store.row(4336)["record"])["media_present"])

    async def test_failed_preservation_does_not_advance_checkpoint_or_mark_copied(self):
        message=preview();bot=Bot(message,fail=True)
        writer=TelegramWriter(bot,"saved-group",source_peer="source",store=self.store)
        with self.assertRaises(RuntimeError):await Mirror(None,writer,self.store,SOURCE,"source").copy_batch([message])
        self.assertEqual(self.store.meta("checkpoint",0),0)
        self.assertEqual(self.store.row(4336)["status"],"pending")
        self.assertEqual(self.store.media_destination(4336),4117)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM tg_media_copies").fetchone()[0],0)
        bot.fail=False
        await Mirror(None,writer,self.store,SOURCE,"source").copy_batch([message])
        self.assertEqual(sum(isinstance(r,functions.messages.ForwardMessagesRequest) for r in bot.requests),1)
        self.assertEqual(self.store.media_destination(4336),6000)
        self.assertEqual(self.store.meta("checkpoint"),4336)

    async def test_repair_regenerates_only_preview_and_preserves_text_caption_and_checkpoint(self):
        original=preview();self.complete(original)
        self.store.db.execute("INSERT INTO tg_caption_parts VALUES(4336,1,4118)");self.store.db.commit()
        empty=preview(empty=True);bot=Bot(empty,{4117:preview(4117,empty=True)})
        reader=Reader(empty,SimpleNamespace(media=preview().media))
        writer=TelegramWriter(bot,"saved-group",source_peer="source",store=self.store,reader=reader)
        before=json.loads(self.store.row(4336)["record"])
        result=await repair_media(reader,writer,self.store,"source")
        self.assertEqual(result,{"checked":1,"healthy":0,"repaired":1,"unrecoverable":0,"failed":0})
        self.assertIsInstance(reader.requests[0],functions.messages.GetWebPagePreviewRequest)
        self.assertEqual(reader.requests[0].message,URL)
        self.assertEqual(json.loads(self.store.row(4336)["record"]),before)
        self.assertEqual(self.store.row(4336)["destination_id"],4117)
        self.assertEqual(self.store.db.execute("SELECT destination_id FROM tg_caption_parts").fetchone()[0],4118)
        self.assertEqual(self.store.meta("checkpoint"),4336)
        self.assertEqual(self.store.media_destination(4336),6000)

    async def test_missing_native_attachment_does_not_regenerate_unrelated_article(self):
        original=types.Message(id=7,peer_id=types.PeerChannel(123),message=URL,
                               media=types.MessageMediaPhoto(photo=photo()))
        self.complete(original)
        reader=Reader(types.Message(id=7,peer_id=types.PeerChannel(123),message=URL))
        writer=TelegramWriter(Bot(None),"saved-group",store=self.store)
        result=await repair_media(reader,writer,self.store,"source")
        self.assertEqual(result["unrecoverable"],1);self.assertEqual(reader.requests,[])
        self.assertEqual(self.store.media_destination(7),4117)

    async def test_unrecoverable_preview_does_not_overwrite_mapping_or_claim_success(self):
        self.complete(preview());empty=preview(empty=True)
        reader=Reader(empty,SimpleNamespace(media=empty.media))
        writer=TelegramWriter(Bot(empty,{4117:preview(4117,empty=True)}),"saved-group",store=self.store)
        result=await repair_media(reader,writer,self.store,"source")
        self.assertEqual(result["unrecoverable"],1);self.assertEqual(result["repaired"],0)
        self.assertEqual(self.store.media_destination(4336),4117)

    async def test_server_copy_accepts_large_files_without_download(self):
        self.complete(preview());bot=Bot(None);writer=TelegramWriter(bot,"saved-group",store=self.store)
        await writer.save_preview_file(4336,SimpleNamespace(media=photo(),size=32*1024*1024+1))
        self.assertEqual(self.store.media_destination(4336),6000)

    async def test_upload_fallback_retains_durable_random_id_and_bounded_buffer(self):
        class FileReferenceExpiredError(Exception):pass
        class ExpiredBot(Bot):
            def __init__(self):super().__init__(None);self.uploads=[];self.first=True
            async def __call__(self,request):
                if self.first:
                    self.first=False;self.requests.append(request);raise FileReferenceExpiredError()
                return await super().__call__(request)
            async def upload_file(self,buffer,file_name):
                self.uploads.append(buffer.read());return types.InputFile(1,1,file_name,"hash")
        class DownloadReader:
            async def download_media(self,media,file):file.write(b"jpeg-bytes")
        self.complete(preview());bot=ExpiredBot();writer=TelegramWriter(bot,"saved-group",store=self.store)
        from telethon.tl.custom.file import File
        await writer.save_preview_file(4336,File(photo()),DownloadReader())
        self.assertEqual(bot.uploads,[b"jpeg-bytes"])
        self.assertEqual(bot.requests[0].random_id,bot.requests[1].random_id)
        self.assertIsInstance(bot.requests[1].media,types.InputMediaUploadedPhoto)
        self.assertEqual(self.store.media_destination(4336),6000)
        class OversizedReader:
            async def download_media(self,media,file):file.write(b"x"*(32*1024*1024+1))
        bot.first=True
        with self.assertRaisesRegex(RuntimeError,"bounded preservation limit"):
            await writer.save_preview_file(4336,File(photo()),OversizedReader(),replace=True)
        self.assertEqual(len(bot.uploads),1)
        self.assertEqual(self.store.media_destination(4336),6000)

    async def test_oversized_fallback_does_not_download_or_change_mapping(self):
        class FileReferenceExpiredError(Exception):pass
        class ExpiredBot(Bot):
            async def __call__(self,request):raise FileReferenceExpiredError()
        self.complete(preview());writer=TelegramWriter(ExpiredBot(None),"saved-group",store=self.store)
        with self.assertRaisesRegex(RuntimeError,"32 MiB"):
            await writer.save_preview_file(4336,SimpleNamespace(media=photo(),size=32*1024*1024+1),object())
        self.assertEqual(self.store.media_destination(4336),4117)

    def test_preview_url_filter_rejects_private_and_telegram_urls(self):
        urls=public_preview_urls(None,{"external_urls":["http://127.0.0.1/a","http://192.168.0.2/a","http://reader.local/a","https://t.me/VidurNeeti/7","https://user:password@example.com/",URL,URL]})
        self.assertEqual(urls,[URL])
        self.assertEqual(public_preview_urls(None,{"external_urls":[URL,"https://example.com/other"]}),[])
        self.assertEqual(public_preview_urls(preview(),{"external_urls":["https://example.com/other"]}),[URL])


if __name__=="__main__":unittest.main()
