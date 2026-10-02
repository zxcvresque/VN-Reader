"""Durable, ordered Telegram archive copier and explicit operator CLI.

A user session reads the public source; the bot writes private copies. Another bot session serves media
from the private group. The web process never starts copying or asks for a login.
"""
from __future__ import annotations
from .notifications import notify
import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import time
import sys
import copy
from pathlib import Path
import sqlite3
from datetime import datetime, timezone, timedelta

log = logging.getLogger(__name__)


def error_label(error):
    code=getattr(error,"message",None)
    # Telegram's symbolic RPC code is useful; arbitrary exception text may contain secrets.
    return error.__class__.__name__+(":"+code if isinstance(code,str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,100}",code) else "")


def utc(value):
    return value.isoformat() if value else None


def serialized(value):
    if value is None:
        return None
    if hasattr(value, "to_dict"):
        value = value.to_dict()
    return json.loads(json.dumps(value, default=lambda x: utc(x) if hasattr(x, "isoformat") else None))


def record(message, source):
    text = getattr(message, "message", None) or ""
    reply = getattr(message, "reply_to", None)
    file = getattr(message, "file", None)
    photo = getattr(message, "photo", None)
    document = getattr(message, "document", None)
    poll_media = getattr(message, "media", None)
    poll = getattr(poll_media, "poll", None)
    media_kind = "photo" if photo else "document" if document else "webpage" if getattr(message, "web_preview", None) else None
    if document:
        for attr in getattr(document, "attributes", []):
            kind = attr.__class__.__name__
            if kind == "DocumentAttributeVideo": media_kind = "video"
            if kind == "DocumentAttributeAudio": media_kind = "voice" if getattr(attr, "voice", False) else "audio"
        kinds = {attr.__class__.__name__ for attr in getattr(document, "attributes", [])}
        if "DocumentAttributeAnimated" in kinds and str(getattr(file, "mime_type", "")).startswith("video/"): media_kind = "animation"
        if "DocumentAttributeSticker" in kinds:
            mime = str(getattr(file, "mime_type", ""))
            media_kind = "sticker" if mime.startswith("image/") else "video" if mime.startswith("video/") else "document"
    poll_snapshot = None
    if poll:
        media_kind = "poll"
        question = getattr(poll.question, "text", poll.question)
        votes = {r.option: r.voters for r in (getattr(poll_media.results, "results", None) or [])}
        answers = [{"text": getattr(a.text, "text", a.text), "votes": votes.get(a.option)} for a in poll.answers]
        poll_snapshot = {"question": question, "answers": answers, "total_voters": getattr(poll_media.results, "total_voters", None)}
        text = str(question) + "\n\n" + "\n".join("• " + str(a["text"]) + (f' — {a["votes"]} votes' if a["votes"] is not None else "") for a in answers)
    parent = local_parent(message, source)
    quote_text = getattr(reply, "quote_text", None)
    source_id = source["chat_id"]
    return {
        "archive_version": 1, "chat_id": source_id, "chat_username": source.get("chat_username"),
        "chat_title": source.get("chat_title"), "chat_type": "channel", "message_key": f"{source_id}:{message.id}",
        "message_id": message.id, "message_type": message.__class__.__name__, "date_utc": utc(getattr(message, "date", None)),
        "edit_date_utc": utc(getattr(message, "edit_date", None)), "text": text, "text_length": len(text),
        "post_author": getattr(message, "post_author", None), "sender_id": getattr(message, "sender_id", None),
        "from_id": serialized(getattr(message, "from_id", None)), "grouped_id": getattr(message, "grouped_id", None),
        "views": getattr(message, "views", None), "forwards": getattr(message, "forwards", None),
        "permalink": f'https://t.me/{source["chat_username"]}/{message.id}' if source.get("chat_username") else None,
        "media_kind": media_kind, "media_present": bool(file), "media_path": f"/api/media/{message.id}" if file else None,
        "media_download_error": None, "external_urls": list(dict.fromkeys(re.findall(r'https?://[^\s<>]+', text) + [e.url for e in (getattr(message, "entities", None) or []) if getattr(e, "url", None)])), "media_raw": {"mime_type": getattr(file, "mime_type", None), "name": getattr(file, "name", None), "size": getattr(file, "size", None)} if file else poll_snapshot,
        "reply_parent_id": parent, "reply_to_msg_id": parent, "reply_to_top_id": getattr(reply, "reply_to_top_id", None),
        "reply_to_peer_id": serialized(getattr(reply, "reply_to_peer_id", None)), "is_reply": parent is not None, "is_quote_reply": bool(quote_text),
        "quote_text": quote_text, "quote_text_length": len(quote_text or ""),
        "quote_offset_utf16": getattr(reply, "quote_offset", None), "quote_entities": serialized(getattr(reply, "quote_entities", None)) or [],
        "reply_header": {"quote_text": quote_text, "quote_offset": getattr(reply, "quote_offset", None)},
        "reply_counts": {"replies": None, "channel_id": None, "recent_repliers": None},
        "raw": {"entities": [serialized(e) for e in (getattr(message, "entities", None) or [])]},
    }


def local_parent(message, source):
    reply = getattr(message, "reply_to", None)
    peer = getattr(reply, "reply_to_peer_id", None)
    if peer is not None:
        from telethon import utils
        if utils.get_peer_id(peer) != source["chat_id"]:
            return None
    return getattr(reply, "reply_to_msg_id", None)


class MirrorStore:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS tg_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tg_messages(source_id INTEGER PRIMARY KEY,destination_id INTEGER,random_id INTEGER NOT NULL,
                record TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT);
            CREATE TABLE IF NOT EXISTS tg_edit_queue(source_id INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS tg_caption_parts(source_id INTEGER NOT NULL,part INTEGER NOT NULL,
                destination_id INTEGER NOT NULL,PRIMARY KEY(source_id,part));
            CREATE TABLE IF NOT EXISTS tg_quote_parts(source_id INTEGER NOT NULL,part INTEGER NOT NULL,
                destination_id INTEGER,PRIMARY KEY(source_id,part));
        """)
        self.db.commit()

    def close(self): self.db.close()
    def meta(self, key, default=None):
        row = self.db.execute("SELECT value FROM tg_meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default
    def set_meta(self, key, value):
        self.db.execute("INSERT INTO tg_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
        self.db.commit()
    def bind(self, source, destination):
        identity = {"source": source["chat_id"], "destination": str(destination)}
        if self.meta("identity") not in (None, identity):
            raise ValueError("This database belongs to another Telegram source or destination")
        self.set_meta("identity", identity)
        self.set_meta("source", source)
    def row(self, source_id):
        return self.db.execute("SELECT * FROM tg_messages WHERE source_id=?", (source_id,)).fetchone()
    def prepare(self, message, source):
        body = record(message, source)
        identity = self.meta("identity")
        random_id = int.from_bytes(hashlib.sha256(f'{identity}:{message.id}'.encode()).digest()[:8], "big") & ((1 << 63) - 1)
        self.db.execute("INSERT INTO tg_messages(source_id,random_id,record) VALUES (?,?,?) ON CONFLICT(source_id) DO NOTHING", (message.id, random_id, json.dumps(body)))
        self.db.commit()
        return self.row(message.id)
    def complete(self, pairs, messages, source, advance=True):
        with self.db:
            for message, dest_id in zip(messages, pairs):
                self.db.execute("UPDATE tg_messages SET destination_id=?,record=?,status='copied',error=NULL WHERE source_id=?", (dest_id, json.dumps(record(message, source)), message.id))
            if advance:
                checkpoint = max(self.meta("checkpoint", 0), max(m.id for m in messages))
                self.db.execute("INSERT INTO tg_meta VALUES ('checkpoint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(checkpoint),))
    def fail(self, messages, error):
        # Never put Telegram exception text or credentials into HTTP responses.
        with self.db:
            for message in messages:
                self.db.execute("UPDATE tg_messages SET error=? WHERE source_id=?", (error_label(error), message.id))
    def skip(self, messages, source, reason):
        for message in messages: self.prepare(message, source)
        with self.db:
            for message in messages:
                self.db.execute("UPDATE tg_messages SET status='skipped',error=? WHERE source_id=? AND status!='copied'", (reason, message.id))
            checkpoint = max(self.meta("checkpoint", 0), max(m.id for m in messages))
            self.db.execute("INSERT INTO tg_meta VALUES ('checkpoint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(checkpoint),))
    def counts(self):
        counts = dict(self.db.execute("SELECT status,count(*) FROM tg_messages GROUP BY status"))
        return counts.get("copied", 0), counts.get("skipped", 0)
    def queue_edit(self, source_id):
        self.db.execute("INSERT OR IGNORE INTO tg_edit_queue VALUES (?)", (source_id,))
        self.db.commit()
    def archive(self):
        source = self.meta("source")
        if not source: return None
        messages = [json.loads(r[0]) for r in self.db.execute("SELECT record FROM tg_messages WHERE status='copied' ORDER BY source_id")]
        first, last = (messages[0], messages[-1]) if messages else ({}, {})
        manifest = {
            "archive_version": 1, "exported_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": dict(source, chat_input=source.get("chat_username") or "VN", chat_type="channel", session_name="hosted"),
            "files": {"messages": "/api/archive", "media_dir": None},
            "counts": {"messages": len(messages), "media_downloaded": sum(bool(m["media_present"]) for m in messages), "media_download_failures": 0},
            "range": {"first_message_id": first.get("message_id"), "first_message_date_utc": first.get("date_utc"), "last_message_id": last.get("message_id"), "last_message_date_utc": last.get("date_utc")},
            "options": {"download_media": False, "include_raw": False, "limit": None},
        }
        return {"manifest": manifest, "messages": messages}


class TerminalProgress:
    """Readable per-batch progress; ANSI backgrounds only in an interactive terminal."""
    def __init__(self, store, total=None, color=None, output=None):
        self.store, self.total = store, total
        self.output = output or sys.stdout
        self.color = self.output.isatty() if color is None else color
        self.started = time.monotonic()
    def pill(self, label, value, background):
        text = f" {label} {value} "
        return f"\033[48;2;{background}m\033[38;2;240;245;255m{text}\033[0m" if self.color else f"[{text.strip()}]"
    def __call__(self, action="Resuming", message=None, complete=False):
        copied, skipped = self.store.counts()
        handled = copied + skipped
        percent = "100.0%" if complete else f"{min(99.9, handled / self.total * 100):.1f}%" if self.total else "—"
        number = message.id if message else self.store.meta("checkpoint", 0)
        date = getattr(message, "date", None)
        if date is None and number:
            row = self.store.row(number)
            raw = json.loads(row["record"]) if row else {}
            if raw.get("date_utc"): date = datetime.fromisoformat(raw["date_utc"])
        stamp = date.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%d %b %Y · %H:%M IST") if date else "—"
        parts = [self.pill("DATE", stamp, "30;64;100"), self.pill("POST", f"#{number}", "77;49;109"), self.pill("DONE", percent, "25;84;65")]
        total = str(self.total) if self.total is not None else "?"
        print(" ".join(parts) + f"  {total} source posts · {copied:,} copied · {skipped:,} skipped · {action}", file=self.output, flush=True)
    def notice(self, label, text):
        print(self.pill(label, text, "101;65;25"), file=self.output, flush=True)
    async def wait(self, seconds, label="RATE LIMIT"):
        remaining = max(1, int(seconds))
        while remaining:
            self.notice(label, f"Resuming in {remaining}s · checkpoint #{self.store.meta('checkpoint', 0)} saved")
            interval = min(5, remaining)
            await asyncio.sleep(interval)
            remaining -= interval


class Mirror:
    def __init__(self, reader, writer, store, source, source_peer, settle_live_albums=False, progress=None, batch_size=1):
        self.reader, self.writer, self.store, self.source, self.source_peer = reader, writer, store, source, source_peer
        self.settle_live_albums = settle_live_albums
        self.progress = progress
        self.batch_size = max(1,min(100,batch_size))
    async def copy_batch(self, messages):
        if not messages: return
        # Truly empty/service posts have no content to send. Persist their disposition
        # so they cannot block the checkpoint or reappear after a restart.
        empty = [m for m in messages if getattr(m, "action", None) or (not (getattr(m, "message", None) or "").strip() and not getattr(m, "media", None) and not getattr(m, "photo", None) and not getattr(m, "document", None))]
        if empty:
            if len(empty) != len(messages): raise RuntimeError("Album contains a noncopyable member; checkpoint retained")
            self.store.skip(empty, self.source, "EmptyOrService")
            if self.progress: self.progress("Skipped empty/service", empty[-1])
            return
        rows = [self.store.prepare(m, self.source) for m in messages]
        pending = [(m, r) for m, r in zip(messages, rows) if r["status"] != "copied"]
        if not pending:
            self.store.complete([r["destination_id"] for r in rows], messages, self.source)
            return
        # Atomic albums are either entirely pending or entirely complete.
        if len(pending) != len(messages):
            raise RuntimeError("Partially mapped album requires operator reconciliation")
        parent = local_parent(messages[0], self.source)
        parent_row = self.store.row(parent) if parent else None
        mapped_parent = parent_row["destination_id"] if parent_row else None
        try:
            ids = await self.writer.send(messages, [r["random_id"] for r in rows], mapped_parent)
            if len(ids) != len(messages): raise RuntimeError("Telegram did not map every copied message")
            self.store.complete(ids, messages, self.source)
            if self.progress: self.progress("Copied", messages[-1])
        except Exception as exc:
            self.store.fail(messages, exc)
            raise
    async def backfill(self):
        unit, roots = [], []
        async def flush_roots():
            if roots:
                await self.copy_batch(list(roots))
                roots.clear()
        async def accept(messages):
            empty = any(getattr(m,"action",None) or (not (getattr(m,"message",None) or "").strip() and not getattr(m,"media",None) and not getattr(m,"photo",None) and not getattr(m,"document",None)) for m in messages)
            if empty or local_parent(messages[0],self.source):
                await flush_roots()
                await self.copy_batch(messages)
            else:
                if roots and len(roots)+len(messages)>self.batch_size: await flush_roots()
                roots.extend(messages)
                if len(roots)>=self.batch_size: await flush_roots()
        async for message in self.reader.iter_messages(self.source_peer,min_id=self.store.meta("checkpoint",0),reverse=True):
            if unit and (not getattr(message,"grouped_id",None) or message.grouped_id!=getattr(unit[0],"grouped_id",None)):
                await accept(unit);unit=[]
            unit.append(message)
            if not getattr(message,"grouped_id",None):
                await accept(unit);unit=[]
        if unit:
            latest=getattr(unit[-1],"date",None)
            if self.settle_live_albums and latest and (datetime.now(timezone.utc)-latest).total_seconds()<3:
                await flush_roots()
                return False
            await accept(unit)
        await flush_roots()
        return True
    async def apply_edits(self):
        ids = [r[0] for r in self.store.db.execute("SELECT source_id FROM tg_edit_queue ORDER BY source_id")]
        for source_id in ids:
            row = self.store.row(source_id)
            if row and row["destination_id"]:
                message = await self.reader.get_messages(self.source_peer, ids=source_id)
                if message and not getattr(message, "action", None):
                    await self.writer.edit(row["destination_id"], message)
                    self.store.complete([row["destination_id"]], [message], self.source, advance=False)
            with self.store.db:
                self.store.db.execute("DELETE FROM tg_edit_queue WHERE source_id=?", (source_id,))


def caption_parts(message):
    """Split without cutting Unicode characters; entity offsets use UTF-16 units."""
    text=message.message or ""
    parts=[];start=0;offset=0
    while start<len(text):
        limit=1024 if not parts else 4096
        end=start;units=0
        while end<len(text):
            width=len(text[end].encode("utf-16-le"))//2
            if units+width>limit:break
            units+=width;end+=1
        entities=[]
        for original in message.entities or []:
            left=max(offset,original.offset);right=min(offset+units,original.offset+original.length)
            if right>left:
                entity=copy.copy(original);entity.offset=left-offset;entity.length=right-left;entities.append(entity)
        parts.append((text[start:end],entities));start=end;offset+=units
    return parts or [("",[])]


class TelegramWriter:
    def __init__(self, client, destination, topic_id=None, source_peer=None, store=None):
        self.client, self.destination, self.topic_id, self.source_peer = client, destination, topic_id, source_peer
        self.store=store
    async def send(self, messages, random_ids, parent):
        from telethon import functions, types, utils
        if self.source_peer is not None and parent is None:
            # One native Telegram request carries mixed text/media/polls and albums.
            # No media-reference lookup, download, or upload is needed for forwarding.
            request=functions.messages.ForwardMessagesRequest(from_peer=self.source_peer,
                id=[m.id for m in messages],to_peer=self.destination,random_id=random_ids,
                top_msg_id=self.topic_id or None,silent=True)
            result=await self.client(request)
            return self.mapped_ids(result,random_ids,types)
        if self.source_peer is not None:
            # File references are refreshed under the writing bot's identity.
            # The bot can retrieve known public IDs; history enumeration uses the reader.
            refreshed = await self.client.get_messages(self.source_peer, ids=[m.id for m in messages])
            if len(refreshed) != len(messages) or any(not m or getattr(m, "action", None) for m in refreshed):
                raise RuntimeError("Source changed before copying; checkpoint retained")
            messages = refreshed
        reply = None
        if parent:
            original = getattr(messages[0], "reply_to", None)
            reply = types.InputReplyToMessage(reply_to_msg_id=parent,
                quote_text=getattr(original, "quote_text", None), quote_entities=getattr(original, "quote_entities", None),
                quote_offset=getattr(original, "quote_offset", None), top_msg_id=self.topic_id or None)
            self.remap_caption_quote(reply)
        elif self.topic_id:
            reply = types.InputReplyToMessage(reply_to_msg_id=self.topic_id, top_msg_id=self.topic_id)
        common = dict(peer=self.destination, reply_to=reply)
        original_quote=getattr(getattr(messages[0],"reply_to",None),"quote_text",None)
        quote_fallback=bool(original_quote and reply and not reply.quote_text)
        if self.store and self.store.db.execute("SELECT 1 FROM tg_quote_parts WHERE source_id=?",(messages[0].id,)).fetchone():
            quote_fallback=True
        if quote_fallback and reply:
            self.clear_native_quote(reply)
            self.remember_quote_fallback(messages[0].id)
        captions={m.id:caption_parts(m) for m in messages if getattr(m,"media",None)
            and not isinstance(m.media,(types.MessageMediaWebPage,types.MessageMediaPoll))}
        if len(messages) > 1:
            media = [types.InputSingleMedia(media=utils.get_input_media(m.media), random_id=rid,
                message=captions[m.id][0][0], entities=captions[m.id][0][1]) for m, rid in zip(messages, random_ids)]
            request = functions.messages.SendMultiMediaRequest(multi_media=media, **common)
        elif isinstance(getattr(messages[0], "media", None), types.MessageMediaPoll):
            if self.source_peer is None: raise RuntimeError("Poll forwarding requires the source peer")
            # Forward the original poll so votes/results and quizzes survive; cloning
            # InputMediaPoll would create a fresh poll with zero votes.
            request = functions.messages.ForwardMessagesRequest(from_peer=self.source_peer,
                id=[messages[0].id], to_peer=self.destination, random_id=random_ids,
                top_msg_id=self.topic_id or None, silent=True)
        elif getattr(messages[0], "media", None) and not isinstance(messages[0].media, types.MessageMediaWebPage):
            message = messages[0]
            request = functions.messages.SendMediaRequest(media=utils.get_input_media(message.media), message=captions[message.id][0][0],
                random_id=random_ids[0], entities=captions[message.id][0][1], **common)
        else:
            message = messages[0]
            request = functions.messages.SendMessageRequest(message=message.message or "", random_id=random_ids[0],
                entities=message.entities or [], no_webpage=False, **common)
        rows=[self.store.row(m.id) for m in messages] if self.store else []
        # A caption follow-up can fail after media succeeds. Persist media IDs before
        # follow-ups, but leave the main checkpoint pending until all text is saved.
        if rows and all(r is not None and r["status"]=="pending" and r["destination_id"] for r in rows):
            ids=[r["destination_id"] for r in rows]
        else:
            try:
                result=await self.client(request)
            except Exception as exc:
                from telethon.errors import BadRequestError
                # An edited parent or an invalid quote entity can invalidate Telegram's
                # substring check. Keep the same parent and durable random IDs; only
                # this specific RPC permits dropping the native quote and retrying.
                if not (isinstance(exc,BadRequestError) and getattr(exc,"message",None)=="QUOTE_TEXT_INVALID"
                        and reply and reply.quote_text):
                    raise
                self.remember_quote_fallback(messages[0].id)
                quote_fallback=True
                self.clear_native_quote(reply)
                log.warning("Telegram rejected native quote for post #%s; retaining parent and saving quoted context",messages[0].id)
                result=await self.client(request)
            ids=self.mapped_ids(result,random_ids,types)
            if self.store:
                self.store.db.executemany("UPDATE tg_messages SET destination_id=? WHERE source_id=?",[(d,m.id) for d,m in zip(ids,messages)])
                self.store.db.commit()
        for m,rid,dest in zip(messages,random_ids,ids):
            await self.save_caption_parts(m,rid,dest,captions.get(m.id,[]))
        if quote_fallback:
            await self.save_quote_context(messages[0],random_ids[0],ids[0],original_quote)
        return ids
    @staticmethod
    def clear_native_quote(reply):
        reply.quote_text=None;reply.quote_entities=None;reply.quote_offset=None
    def remember_quote_fallback(self,source_id):
        if self.store:
            self.store.db.execute("INSERT OR IGNORE INTO tg_quote_parts VALUES(?,0,NULL)",(source_id,))
            self.store.db.commit()
    async def save_quote_context(self,message,random_id,destination_id,quote):
        from telethon import functions,types
        from types import SimpleNamespace
        if self.store:
            row=self.store.row(message.id)
            quote=json.loads(row["record"]).get("quote_text") if row else quote
        if not quote:return
        parts=caption_parts(SimpleNamespace(message="Quoted context from the original post:\n\n"+quote,entities=[]))
        for index,(text,entities) in enumerate(parts):
            existing=self.store.db.execute("SELECT destination_id FROM tg_quote_parts WHERE source_id=? AND part=?",(message.id,index)).fetchone() if self.store else None
            if existing and existing[0]:continue
            part_random=int.from_bytes(hashlib.sha256(f"vn-quote:{random_id}:{index}".encode()).digest()[:8],"big") & ((1<<63)-1)
            result=await self.client(functions.messages.SendMessageRequest(peer=self.destination,message=text,entities=entities,
                random_id=part_random,no_webpage=True,silent=True,reply_to=types.InputReplyToMessage(reply_to_msg_id=destination_id,top_msg_id=self.topic_id or None)))
            part_id=self.mapped_ids(result,[part_random],types)[0]
            if self.store:
                self.store.db.execute("INSERT INTO tg_quote_parts VALUES(?,?,?) ON CONFLICT(source_id,part) DO UPDATE SET destination_id=excluded.destination_id",(message.id,index,part_id));self.store.db.commit()
    def remap_caption_quote(self,reply):
        if not self.store or not reply.quote_text:return
        parent=self.store.db.execute("SELECT source_id,record FROM tg_messages WHERE destination_id=?",(reply.reply_to_msg_id,)).fetchone()
        if not parent:return
        continuations=dict(self.store.db.execute("SELECT part,destination_id FROM tg_caption_parts WHERE source_id=?",(parent["source_id"],)))
        if not continuations:return
        from types import SimpleNamespace
        body=json.loads(parent["record"])
        parts=caption_parts(SimpleNamespace(message=body["text"],entities=[]))
        offset=reply.quote_offset or 0;position=0;quote=reply.quote_text.encode("utf-16-le")
        for index,(text,_) in enumerate(parts):
            encoded=text.encode("utf-16-le");length=len(encoded)//2
            local=offset-position
            if local>=0 and encoded[local*2:local*2+len(quote)]==quote:
                target=continuations.get(index) if index else reply.reply_to_msg_id
                if target:
                    reply.reply_to_msg_id=target;reply.quote_offset=local;return
            position+=length
        # A quote crossing two saved parts cannot be a native Telegram substring.
        # Retain the original parent relation; the full quote remains in web metadata.
        reply.quote_text=None;reply.quote_entities=None;reply.quote_offset=None
        log.warning("Quote crosses caption parts or changed; retaining the parent reply and archived web quote")
    async def save_caption_parts(self,message,random_id,destination_id,parts):
        from telethon import functions,types
        from telethon.errors import MessageNotModifiedError
        for index,(text,entities) in enumerate(parts[1:],1):
            existing=self.store.db.execute("SELECT destination_id FROM tg_caption_parts WHERE source_id=? AND part=?",(message.id,index)).fetchone() if self.store else None
            if existing:
                try:await self.client.edit_message(self.destination,existing[0],text=text,parse_mode=None,formatting_entities=entities)
                except MessageNotModifiedError:pass
                continue
            part_random=int.from_bytes(hashlib.sha256(f"vn-caption:{random_id}:{index}".encode()).digest()[:8],"big") & ((1<<63)-1)
            result=await self.client(functions.messages.SendMessageRequest(peer=self.destination,message=text,entities=entities,
                random_id=part_random,no_webpage=True,silent=True,reply_to=types.InputReplyToMessage(reply_to_msg_id=destination_id,top_msg_id=self.topic_id or None)))
            part_id=self.mapped_ids(result,[part_random],types)[0]
            if self.store:
                self.store.db.execute("INSERT INTO tg_caption_parts VALUES(?,?,?)",(message.id,index,part_id));self.store.db.commit()
        if self.store:
            obsolete=self.store.db.execute("SELECT destination_id FROM tg_caption_parts WHERE source_id=? AND part>=?",(message.id,max(1,len(parts)))).fetchall()
            if obsolete:
                await self.client.delete_messages(self.destination,[r[0] for r in obsolete])
                self.store.db.execute("DELETE FROM tg_caption_parts WHERE source_id=? AND part>=?",(message.id,max(1,len(parts))));self.store.db.commit()
    @staticmethod
    def mapped_ids(result, random_ids, types):
        mapping = {u.random_id: u.id for u in getattr(result, "updates", []) if isinstance(u, types.UpdateMessageID)}
        # UpdateShortSentMessage is possible for basic groups.
        if len(random_ids) == 1 and hasattr(result, "id"): mapping[random_ids[0]] = result.id
        if not all(rid in mapping for rid in random_ids):
            raise RuntimeError("Missing Telegram random-ID mapping; retry with same durable IDs")
        return [mapping[rid] for rid in random_ids]
    async def edit(self, destination_id, message):
        from telethon.errors import MessageNotModifiedError
        if self.source_peer is not None:
            message = await self.client.get_messages(self.source_peer, ids=message.id)
            if not message: raise RuntimeError("Edited source is no longer available")
        from telethon import types
        if isinstance(getattr(message, "media", None), types.MessageMediaPoll):
            return  # Forwarded polls retain the original Telegram poll; refresh its web snapshot only.
        parts=caption_parts(message) if getattr(message,"file",None) else [(message.message or "",message.entities or [])]
        try:
            await self.client.edit_message(self.destination, destination_id, text=parts[0][0], parse_mode=None,
                formatting_entities=parts[0][1], file=message.media if getattr(message, "file", None) else None)
        except MessageNotModifiedError:
            pass
        row=self.store.row(message.id) if self.store else None
        await self.save_caption_parts(message,row["random_id"] if row else destination_id,destination_id,parts)


def configuration():
    required = ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_BOT_TOKEN", "TELEGRAM_SOURCE", "TELEGRAM_DESTINATION"]
    if not all(os.environ.get(k) for k in required):
        return None
    return {
        "api_id": int(os.environ["TELEGRAM_API_ID"]), "api_hash": os.environ["TELEGRAM_API_HASH"],
        "bot_token": os.environ["TELEGRAM_BOT_TOKEN"], "source": os.environ["TELEGRAM_SOURCE"],
        "destination": int(os.environ["TELEGRAM_DESTINATION"]),
        "reader_session": os.environ.get("TELEGRAM_READER_SESSION", "server/data/archive-reader"),
        "bot_session": os.environ.get("TELEGRAM_BOT_SESSION", "server/data/archive-streamer"),
        "mirror_bot_session": os.environ.get("TELEGRAM_MIRROR_BOT_SESSION", "data/telegram-mirror-bot"),
        "database": os.environ.get("VN_DATABASE_PATH", os.environ.get("DATABASE_PATH", "data/vn-reader.sqlite3")),
        "topic_id": int(os.environ["TELEGRAM_ARCHIVE_TOPIC_ID"]) if os.environ.get("TELEGRAM_ARCHIVE_TOPIC_ID") else None,
    }


async def run(command):
    # Await fatal alerts before asyncio.run closes its loop and cancels tasks.
    state = {"started": False, "alerted": False}
    try:
        await _run(command, state)
    except Exception as exc:
        if not state["alerted"]:
            event = "Archive mirror stopped" if state["started"] else "Archive mirror startup failed"
            await notify(event, exc.__class__.__name__, severity="critical")
        raise


async def _run(command, state):
    os.umask(0o077)
    from telethon import TelegramClient, events, utils, functions, types
    config = configuration()
    if not config: raise RuntimeError("Configure Telegram variables before running the mirror")
    Path(config["reader_session"]).parent.mkdir(parents=True, exist_ok=True)
    reader = TelegramClient(config["reader_session"], config["api_id"], config["api_hash"], flood_sleep_threshold=0)
    # Login happens only in this explicit, interactive operator command.
    if command == "login":
        await reader.start()
        await reader.disconnect()
        return
    bot = None
    store = None
    try:
        await reader.connect()
        if not await reader.is_user_authorized(): raise RuntimeError("Run python -m server.mirror login first")
        entity = await reader.get_entity(config["source"])
        if not getattr(entity, "broadcast", False) or not getattr(entity, "username", None):
            raise RuntimeError("TELEGRAM_SOURCE must resolve to a public channel")
        if getattr(entity, "noforwards", False): raise RuntimeError("Source disallows saving or forwarding content")
        from telethon.sessions import MemorySession
        # Each writer gets its own auth key; copied disk sessions can be invalidated
        # when a local instance and VPS connect from different IP addresses.
        bot = TelegramClient(MemorySession(), config["api_id"], config["api_hash"], flood_sleep_threshold=0)
        await bot.start(bot_token=config["bot_token"])
        if not (await bot.get_me()).bot: raise RuntimeError("Mirror writer must be the configured bot")
        bot_source = await bot.get_entity(config["source"])
        destination = await bot.get_entity(config["destination"])
        if not getattr(destination, "megagroup", False) or getattr(destination, "username", None):
            raise RuntimeError("TELEGRAM_DESTINATION must be your private supergroup")
        peer = await bot.get_input_entity(destination)
        source = {"chat_id": utils.get_peer_id(entity), "chat_title": entity.title, "chat_username": entity.username}
        store = MirrorStore(config["database"])
        store.bind(source, config["destination"])
        topic_id = config["topic_id"] if config["topic_id"] is not None else store.meta("archive_topic_id")
        if getattr(destination, "forum", False) and topic_id is None:
            try:
                result = await bot(functions.messages.CreateForumTopicRequest(peer=peer, title="VidurNeeti archive",
                    random_id=int.from_bytes(hashlib.sha256(f'vn-topic:{config["destination"]}'.encode()).digest()[:8], "big") & ((1 << 63) - 1)))
                topic_id = next((update.message.id for update in result.updates
                    if isinstance(update, types.UpdateNewChannelMessage) and isinstance(getattr(update.message, "action", None), types.MessageActionTopicCreate)), None)
                if topic_id is None: raise RuntimeError("Could not obtain the archive topic ID")
            except Exception as exc:
                if exc.__class__.__name__ not in {"ChatWriteForbiddenError", "ChatAdminRequiredError"}: raise
                # General is already one topic; no extra group permission is required.
                topic_id = 0
                log.warning("Topic creation unavailable; using the existing General topic for this archive")
            store.set_meta("archive_topic_id", topic_id)
        elif topic_id:
            store.set_meta("archive_topic_id", topic_id)
        progress = TerminalProgress(store)
        mirror = Mirror(reader, TelegramWriter(bot, peer, topic_id, bot_source,store), store, source, entity,
            settle_live_albums=command=="watch", progress=progress, batch_size=100)
        progress.notice("ARCHIVE", f"{entity.title} · saved progress will be resumed · Ctrl+C stops safely")
        asyncio.create_task(notify("Archive mirror started"))
        wake = asyncio.Event()
        async def new_message(event): wake.set()
        async def edited(event):
            store.queue_edit(event.message.id)
            wake.set()
        reader.add_event_handler(new_message, events.NewMessage(chats=entity))
        reader.add_event_handler(edited, events.MessageEdited(chats=entity))
        await reader.catch_up()
        last_total_refresh = 0
        last_notified_checkpoint = store.meta("checkpoint", 0)
        was_paused = False
        consecutive_failures = 0
        state["started"] = True
        while True:
            try:
                if time.monotonic() - last_total_refresh >= 60:
                    history = await reader.get_messages(entity, limit=0)
                    progress.total = history.total
                    last_total_refresh = time.monotonic()
                    progress("Resuming" if command=="backfill" else "Catching up")
                complete = await mirror.backfill()
                await mirror.apply_edits()
                checkpoint = store.meta("checkpoint", 0)
                consecutive_failures = 0
                if was_paused:
                    asyncio.create_task(notify("Archive mirror recovered", f"Checkpoint {checkpoint}"))
                    was_paused = False
                if checkpoint != last_notified_checkpoint:
                    asyncio.create_task(notify("Archive updated", f"Copied through post #{checkpoint}"))
                    last_notified_checkpoint = checkpoint
                progress(("Backfill complete" if command=="backfill" else "Caught up · listening for new posts") if complete else "Waiting for the latest album to finish arriving", complete=complete)
                if command == "backfill": return
                # Catch-up polling repairs missed events/restarts. Edits received by Telethon are durable.
                wake.clear()
                try: await asyncio.wait_for(wake.wait(), timeout=15)
                except asyncio.TimeoutError: pass
                # Album members arrive as separate updates: give the group a brief settling interval.
                await asyncio.sleep(2)
            except Exception as exc:
                if exc.__class__.__name__ == "FloodWaitError":
                    await progress.wait(exc.seconds)
                    continue
                was_paused = True
                consecutive_failures += 1
                alert = notify("Archive mirror paused", f"Checkpoint {store.meta('checkpoint', 0)} · {exc.__class__.__name__}", severity="critical" if consecutive_failures >= 2 or command == "backfill" else "routine")
                if command == "backfill":
                    await alert
                    state["alerted"] = True
                else:
                    asyncio.create_task(alert)
                log.error("Mirror paused at checkpoint %s (%s); retrying without skipping", store.meta("checkpoint", 0), error_label(exc))
                if command == "backfill": raise
                await progress.wait(15, "RETRY")
    finally:
        if store: store.close()
        if bot: await bot.disconnect()
        await reader.disconnect()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["login", "backfill", "watch"])
    parser.add_argument("--env-file", default="server/.env", help="Operator configuration (never committed)")
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(args.env_file)
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("telethon").setLevel(logging.WARNING)
    import fcntl
    config=configuration()
    if not config: parser.error("Configure Telegram variables in server/.env first")
    os.umask(0o077)
    lock_path=Path(config["reader_session"]+".mirror.lock")
    lock_path.parent.mkdir(parents=True,exist_ok=True)
    lock=lock_path.open("a")
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        parser.exit(1,"Another mirror is already running with this reader session. Stop that terminal first.\n")
    try:
        asyncio.run(run(args.command))
    except KeyboardInterrupt:
        print("\nStopped safely. Run the same command to resume saved progress.", flush=True)
