import asyncio
from datetime import datetime, timezone
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from server.mirror import Mirror, MirrorStore, TerminalProgress, TelegramWriter, record, caption_parts, error_label
from server.streaming import parse_range, RangeNotSatisfiable, media_headers, telegram_chunks


def msg(number, parent=None, album=None, text=None):
    return SimpleNamespace(id=number, message=text or f"Message {number}", date=datetime.now(timezone.utc), edit_date=None,
        entities=[], media=None, file=None, grouped_id=album, reply_to=SimpleNamespace(reply_to_msg_id=parent,
        quote_text="quoted line" if parent else None, quote_offset=3) if parent else None)

class FakeReader:
    def __init__(self, messages): self.messages = messages
    async def iter_messages(self, peer, min_id, reverse):
        for message in self.messages:
            if message.id > min_id: yield message
    async def get_messages(self, peer, ids): return next((m for m in self.messages if m.id == ids), None)

class FakeWriter:
    def __init__(self): self.sent, self.edits, self.fail_id = [], [], None
    async def send(self, messages, random_ids, parent):
        if messages[0].id == self.fail_id: raise ConnectionError("simulated Telegram failure")
        self.sent.append(([m.id for m in messages], random_ids, parent))
        return [m.id + 1000 for m in messages]
    async def edit(self, dest, message): self.edits.append((dest, message.message))

class MirrorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "archive.sqlite3")
        self.store = MirrorStore(self.path)
        self.source = {"chat_id": -10055, "chat_username": "example", "chat_title": "Example"}
        self.store.bind(self.source, -10099)
    def tearDown(self):
        self.store.close(); self.tmp.cleanup()
    async def test_replies_albums_and_restart_are_idempotent(self):
        reader = FakeReader([msg(1), msg(2, 1), msg(3, 1, 9), msg(4, 1, 9)])
        writer = FakeWriter()
        mirror = Mirror(reader, writer, self.store, self.source, "source")
        await mirror.backfill()
        self.assertEqual([(s[0], s[2]) for s in writer.sent], [([1], None), ([2], 1001), ([3, 4], 1001)])
        await mirror.backfill()
        self.assertEqual(len(writer.sent), 3)
        archive = self.store.archive()
        self.assertEqual(len(archive["messages"]), 4)
        self.assertEqual(archive["messages"][1]["quote_text"], "quoted line")
        self.assertNotIn("destination", str(archive))
        self.assertEqual(archive["messages"][3]["message_key"], "-10055:4")
    async def test_bulk_forwarding_chunks_and_preserves_reply_mapping(self):
        messages=[msg(i) for i in range(1,206)]+[msg(206,1)]
        writer=FakeWriter()
        mirror=Mirror(FakeReader(messages),writer,self.store,self.source,"source",batch_size=100)
        await mirror.backfill()
        self.assertEqual([len(s[0]) for s in writer.sent],[100,100,5,1])
        self.assertEqual(writer.sent[-1][2],1001)
        self.assertEqual(self.store.meta("checkpoint"),206)
        await mirror.backfill();self.assertEqual(len(writer.sent),4)
    async def test_bulk_forwarding_does_not_split_album_at_boundary(self):
        messages=[msg(i) for i in range(1,100)]+[msg(i,album=9) for i in range(100,104)]
        writer=FakeWriter()
        await Mirror(FakeReader(messages),writer,self.store,self.source,"source",batch_size=100).backfill()
        self.assertEqual([len(s[0]) for s in writer.sent],[99,4])
    async def test_native_forward_needs_no_media_lookup(self):
        from telethon import functions,types
        requests=[]
        class Client:
            async def __call__(self,request):
                requests.append(request)
                return SimpleNamespace(updates=[types.UpdateMessageID(id=n+1000,random_id=r) for n,r in zip(request.id,request.random_id)])
            async def get_messages(self,*args,**kwargs):raise AssertionError("Unexpected media lookup")
        ids=await TelegramWriter(Client(),"destination",42,"source").send([msg(i) for i in range(1,101)],list(range(101,201)),None)
        self.assertIsInstance(requests[0],functions.messages.ForwardMessagesRequest)
        self.assertEqual(len(requests[0].id),100)
        self.assertEqual(requests[0].top_msg_id,42)
        self.assertEqual(ids,list(range(1001,1101)))
    async def test_poll_is_archived_with_question_and_results(self):
        poll=msg(1);poll.message=""
        poll.media=SimpleNamespace(poll=SimpleNamespace(question=SimpleNamespace(text="Choose?"),answers=[SimpleNamespace(text=SimpleNamespace(text="Yes"),option=b"a")]),results=SimpleNamespace(results=[SimpleNamespace(option=b"a",voters=4)],total_voters=4))
        writer=FakeWriter()
        await Mirror(FakeReader([poll]),writer,self.store,self.source,"source",batch_size=100).backfill()
        snapshot=record(poll,self.source)
        self.assertEqual(snapshot["media_kind"],"poll")
        self.assertIn("Yes — 4 votes",snapshot["text"])
        self.assertEqual(self.store.counts(),(1,0))
    def test_caption_split_preserves_unicode_and_entity_offsets(self):
        from telethon import types
        message=msg(2,text="a"*1023+"😀"+"b"*5000)
        message.entities=[types.MessageEntityBold(offset=1000,length=100)]
        parts=caption_parts(message)
        self.assertEqual("".join(p[0] for p in parts),message.message)
        self.assertLessEqual(len(parts[0][0].encode("utf-16-le"))//2,1024)
        self.assertTrue(all(len(p[0].encode("utf-16-le"))//2<=4096 for p in parts[1:]))
        self.assertEqual((parts[0][1][0].offset,parts[0][1][0].length),(1000,23))
        self.assertEqual((parts[1][1][0].offset,parts[1][1][0].length),(0,77))
    async def test_quote_maps_to_caption_continuation_with_utf16_offset(self):
        from telethon import types
        parent=msg(1,text="a"*1024+"😀"+"quote here"+"z"*40)
        await Mirror(FakeReader([parent]),FakeWriter(),self.store,self.source,"source").backfill()
        self.store.db.execute("INSERT INTO tg_caption_parts VALUES(1,1,2001)");self.store.db.commit()
        writer=TelegramWriter(None,"dest",store=self.store)
        reply=types.InputReplyToMessage(reply_to_msg_id=1001,quote_text="quote here",quote_offset=1026)
        writer.remap_caption_quote(reply)
        self.assertEqual(reply.reply_to_msg_id,2001)
        self.assertEqual(reply.quote_offset,2)
        self.assertEqual(reply.quote_text,"quote here")
        crossing=types.InputReplyToMessage(reply_to_msg_id=1001,quote_text="a😀",quote_offset=1023)
        writer.remap_caption_quote(crossing)
        self.assertEqual(crossing.reply_to_msg_id,1001)
        self.assertIsNone(crossing.quote_text)
    def test_error_label_exposes_only_symbolic_rpc_code(self):
        from telethon.errors import BadRequestError
        self.assertEqual(error_label(BadRequestError(None,"QUOTE_TEXT_INVALID",400)),"BadRequestError:QUOTE_TEXT_INVALID")
        self.assertEqual(error_label(BadRequestError(None,"https://example.test/secret",400)),"BadRequestError")
    async def test_invalid_native_quote_retries_same_ids_and_keeps_context_after_restart(self):
        from telethon import functions,types
        from telethon.errors import BadRequestError
        import copy
        await Mirror(FakeReader([msg(1)]),FakeWriter(),self.store,self.source,"source").backfill()
        message=msg(2,1)
        message.reply_to.quote_entities=[types.MessageEntityBold(offset=0,length=11)]
        class Client:
            def __init__(self):self.requests=[];self.reject=True;self.fail_context=True
            async def get_messages(self,*args,**kwargs):return [message]
            async def __call__(self,request):
                self.requests.append(copy.deepcopy(request))
                if request.message==message.message and self.reject:
                    self.reject=False;raise BadRequestError(request,"QUOTE_TEXT_INVALID",400)
                if request.message.startswith("Quoted context") and self.fail_context:
                    self.fail_context=False;raise ConnectionError("Interrupted quote continuation")
                return SimpleNamespace(updates=[types.UpdateMessageID(id=2000+len(self.requests),random_id=request.random_id)])
        client=Client();writer=TelegramWriter(client,"dest",42,"source",self.store)
        mirror=Mirror(FakeReader([message]),writer,self.store,self.source,"source")
        with self.assertRaises(ConnectionError):await mirror.backfill()
        self.assertEqual(self.store.meta("checkpoint"),1)
        destination=self.store.row(2)["destination_id"]
        await mirror.backfill()
        first,retry=client.requests[:2]
        self.assertEqual(first.random_id,retry.random_id)
        self.assertEqual(retry.reply_to.reply_to_msg_id,1001)
        self.assertEqual(retry.reply_to.top_msg_id,42)
        self.assertEqual(first.reply_to.quote_text,"quoted line")
        self.assertIsNone(retry.reply_to.quote_text)
        self.assertIsNone(retry.reply_to.quote_entities)
        self.assertIsNone(retry.reply_to.quote_offset)
        contexts=[r for r in client.requests if r.message.startswith("Quoted context")]
        self.assertEqual(len(contexts),2)
        self.assertEqual(contexts[0].random_id,contexts[1].random_id)
        self.assertEqual(contexts[-1].reply_to.reply_to_msg_id,destination)
        self.assertIn("quoted line",contexts[-1].message)
        self.assertEqual(self.store.archive()["messages"][-1]["quote_text"],"quoted line")
        self.assertEqual(self.store.meta("checkpoint"),2)
        await mirror.backfill();self.assertEqual(len(client.requests),4)
    async def test_other_bad_request_does_not_drop_quote_or_advance_checkpoint(self):
        from telethon.errors import BadRequestError
        await Mirror(FakeReader([msg(1)]),FakeWriter(),self.store,self.source,"source").backfill()
        message=msg(2,1)
        class Client:
            def __init__(self):self.calls=0
            async def get_messages(self,*args,**kwargs):return [message]
            async def __call__(self,request):
                self.calls+=1;raise BadRequestError(request,"ENTITY_BOUNDS_INVALID",400)
        client=Client();writer=TelegramWriter(client,"dest",42,"source",self.store)
        with self.assertRaises(BadRequestError):
            await Mirror(FakeReader([message]),writer,self.store,self.source,"source").backfill()
        self.assertEqual(client.calls,1)
        self.assertEqual(self.store.meta("checkpoint"),1)
    async def test_long_album_caption_retry_preserves_full_text_without_resending_media(self):
        from telethon import functions,types
        from unittest.mock import patch
        await Mirror(FakeReader([msg(1)]),FakeWriter(),self.store,self.source,"source").backfill()
        messages=[msg(2,1,9,text="a"*2047),msg(3,1,9)]
        for m in messages:m.media=SimpleNamespace(kind="photo")
        class Client:
            def __init__(self):self.requests=[];self.fail=True;self.edits=[];self.deleted=[]
            async def get_messages(self,peer,ids):return messages if isinstance(ids,list) else next(m for m in messages if m.id==ids)
            async def __call__(self,request):
                self.requests.append(request)
                if isinstance(request,functions.messages.SendMessageRequest) and self.fail:
                    self.fail=False;raise ConnectionError("Interrupted follow-up")
                randoms=[m.random_id for m in request.multi_media] if isinstance(request,functions.messages.SendMultiMediaRequest) else [request.random_id]
                return SimpleNamespace(updates=[types.UpdateMessageID(id=2000+i,random_id=r) for i,r in enumerate(randoms)])
            async def edit_message(self,*args,**kwargs):self.edits.append((args,kwargs))
            async def delete_messages(self,*args):self.deleted.append(args)
        client=Client();writer=TelegramWriter(client,"dest",42,"source",self.store)
        mirror=Mirror(FakeReader(messages),writer,self.store,self.source,"source",batch_size=100)
        with patch("telethon.utils.get_input_media",return_value=types.InputMediaEmpty()):
            with self.assertRaises(ConnectionError):await mirror.backfill()
            self.assertEqual(self.store.meta("checkpoint"),1)
            self.assertEqual(self.store.row(2)["destination_id"],2000)
            await mirror.backfill()
        albums=[r for r in client.requests if isinstance(r,functions.messages.SendMultiMediaRequest)]
        self.assertEqual(len(albums),1)
        self.assertEqual(albums[0].reply_to.reply_to_msg_id,1001)
        captions=[r for r in client.requests if isinstance(r,functions.messages.SendMessageRequest)]
        self.assertEqual(captions[0].random_id,captions[1].random_id)
        self.assertEqual(captions[-1].reply_to.reply_to_msg_id,2000)
        self.assertEqual(albums[0].multi_media[0].message+captions[-1].message,messages[0].message)
        self.assertEqual(self.store.meta("checkpoint"),3)
        self.assertEqual(self.store.archive()["messages"][1]["text"],messages[0].message)
        messages[0].message="Shortened";messages[0].file=SimpleNamespace()
        await writer.edit(2000,messages[0])
        self.assertEqual(client.edits[-1][1]["text"],"Shortened")
        self.assertEqual(len(client.deleted),1)
    async def test_failure_never_advances_past_gap_and_random_id_survives_restart(self):
        reader = FakeReader([msg(1), msg(2), msg(3)])
        writer = FakeWriter(); writer.fail_id = 2
        mirror = Mirror(reader, writer, self.store, self.source, "source")
        with self.assertRaises(ConnectionError): await mirror.backfill()
        self.assertEqual(self.store.meta("checkpoint"), 1)
        old_random = self.store.row(2)["random_id"]
        self.store.close(); self.store = MirrorStore(self.path)
        writer.fail_id = None
        await Mirror(reader, writer, self.store, self.source, "source").backfill()
        self.assertEqual(writer.sent[1][1][0], old_random)
        self.assertEqual(self.store.meta("checkpoint"), 3)
        self.assertEqual(len(self.store.archive()["messages"]), 3)
    async def test_edit_updates_original_copy_and_retains_checkpoint(self):
        reader = FakeReader([msg(1), msg(2)]); writer = FakeWriter()
        mirror = Mirror(reader, writer, self.store, self.source, "source")
        await mirror.backfill()
        reader.messages[0].message = "Changed text"
        self.store.queue_edit(1)
        await mirror.apply_edits()
        self.assertEqual(writer.edits, [(1001, "Changed text")])
        self.assertEqual(self.store.archive()["messages"][0]["text"], "Changed text")
        self.assertEqual(self.store.meta("checkpoint"), 2)
    def test_database_cannot_be_reused_for_other_private_group(self):
        with self.assertRaises(ValueError): self.store.bind(self.source, -10000)
    async def test_external_reply_does_not_link_to_matching_local_id(self):
        from telethon.types import PeerChannel
        reply = msg(2, 1)
        reply.reply_to.reply_to_peer_id = PeerChannel(999)
        writer = FakeWriter()
        await Mirror(FakeReader([msg(1),reply]), writer, self.store, self.source, "source").backfill()
        self.assertIsNone(writer.sent[1][2])
        self.assertIsNone(self.store.archive()["messages"][1]["reply_parent_id"])
        self.assertEqual(self.store.archive()["messages"][1]["quote_text"], "quoted line")
    async def test_newest_live_album_waits_before_advancing_checkpoint(self):
        reader = FakeReader([msg(1),msg(2,album=5),msg(3,album=5)])
        writer = FakeWriter()
        await Mirror(reader, writer, self.store, self.source, "source", settle_live_albums=True).backfill()
        self.assertEqual(self.store.meta("checkpoint"),1)
        self.assertEqual(len(writer.sent),1)
    async def test_empty_post_is_skipped_durably_and_next_post_is_copied(self):
        empty=msg(2);empty.message=""
        writer=FakeWriter()
        mirror=Mirror(FakeReader([msg(1),empty,msg(3)]),writer,self.store,self.source,"source")
        await mirror.backfill()
        self.assertEqual(self.store.meta("checkpoint"),3)
        self.assertEqual(self.store.row(2)["status"],"skipped")
        self.assertEqual(self.store.counts(),(2,1))
        self.assertEqual([s[0] for s in writer.sent],[[1],[3]])
        self.assertEqual([m["message_id"] for m in self.store.archive()["messages"]],[1,3])
        await mirror.backfill();self.assertEqual(len(writer.sent),2)
    async def test_empty_looking_media_is_still_copied_and_failures_still_block(self):
        media=msg(1);media.message="";media.media=SimpleNamespace(kind="photo")
        writer=FakeWriter();writer.fail_id=1
        with self.assertRaises(ConnectionError):await Mirror(FakeReader([media,msg(2)]),writer,self.store,self.source,"source").backfill()
        self.assertEqual(self.store.meta("checkpoint",0),0)
        self.assertEqual(self.store.row(1)["status"],"pending")
    async def test_progress_reports_date_post_percent_and_colors_without_message_text(self):
        import io
        writer=FakeWriter();output=io.StringIO();progress=TerminalProgress(self.store,total=4,color=True,output=output)
        await Mirror(FakeReader([msg(1)]),writer,self.store,self.source,"source",progress=progress).backfill()
        line=output.getvalue()
        self.assertIn("POST #1",line);self.assertIn("DONE 25.0%",line)
        self.assertIn("IST",line);self.assertIn("1 copied",line)
        self.assertIn("\033[48;2;",line);self.assertNotIn("Message 1",line)

class RangeTests(unittest.TestCase):
    def test_ranges(self):
        for header, expected in [(None, (0,99,False)), ("bytes=10-19",(10,19,True)), ("bytes=95-",(95,99,True)),
            ("bytes=-12",(88,99,True)), ("bytes=0-200",(0,99,True)), ("bytes=-200",(0,99,True))]:
            self.assertEqual(parse_range(header, 100), expected)
        for header in ["bytes=-0", "bytes=100-", "bytes=20-10", "bytes=0-1,4-5", "bytes=-", "items=1-2"]:
            with self.assertRaises(RangeNotSatisfiable): parse_range(header, 100)
        with self.assertRaises(RangeNotSatisfiable): parse_range("bytes=0-", 0)
    def test_active_documents_download_and_filenames_cannot_inject_headers(self):
        headers = media_headers(100, 0, 9, True, "image/svg+xml", 'bad\r\nname.svg')
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertTrue(headers["Content-Disposition"].startswith("attachment"))
        self.assertNotIn("\r", str(headers)); self.assertNotIn("\n", str(headers))
        self.assertEqual(headers["Content-Range"], "bytes 0-9/100")

class ChunkTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_range_and_sender_cleanup(self):
        class Iterator:
            def __init__(self, start): self.pos, self.closed = start, False
            def __aiter__(self): return self
            async def __anext__(self):
                if self.pos >= 100: raise StopAsyncIteration
                data = bytes(range(self.pos, min(100, self.pos + 8))); self.pos += len(data); return data
            async def close(self): self.closed = True
        class Client:
            def iter_download(self, media, **kw): self.iterator = Iterator(kw["offset"]); return self.iterator
        client = Client(); message = SimpleNamespace(media="stored", file=SimpleNamespace(size=100))
        chunks = [chunk async for chunk in telegram_chunks(client, message, 11, 24)]
        self.assertEqual(b"".join(chunks), bytes(range(11,25)))
        self.assertTrue(client.iterator.closed)
    async def test_disconnect_stops_and_closes_sender(self):
        class Iterator:
            closed = False
            def __aiter__(self): return self
            async def __anext__(self): return b"12345"
            async def close(self): self.closed = True
        iterator = Iterator()
        client = SimpleNamespace(iter_download=lambda *a, **kw: iterator)
        async def disconnected(): return True
        message = SimpleNamespace(media="stored", file=SimpleNamespace(size=100))
        self.assertEqual([c async for c in telegram_chunks(client, message, 0, 9, disconnected)], [])
        self.assertTrue(iterator.closed)

if __name__ == "__main__": unittest.main()
