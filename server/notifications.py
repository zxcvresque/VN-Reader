"""Private operator events with account identity; never credentials or reader content."""
import asyncio
import json
import os
import time
import urllib.request
import logging
from html import escape
from pathlib import Path

_schema = json.loads(Path(__file__).with_name("operatorEvents.json").read_text())
FIELD_SCHEMA = _schema["fields"]


def format_operator_event(event, detail="", severity="routine", fields=None):
    tags = (["critical"] if severity == "critical" else []) + _schema["events"].get(event, ["system"])
    lines = [f"<b>vn reader · {escape(event[:80], quote=False)}</b>", " ".join(f"#{tag}" for tag in tags)]
    if detail:
        lines += ["", f"<blockquote>{escape(detail[:200], quote=False)}</blockquote>"]
    values = []
    for key, definition in FIELD_SCHEMA.items():
        value = (fields or {}).get(key)
        if isinstance(value, str) and value:
            value = value.replace("\r", " ").replace("\n", " ").replace("\t", " ")[:definition["limit"]]
            values.append(f"<b>{definition['label']}:</b> {escape(value, quote=False)}")
    if values:
        lines += [""] + values
    return "\n".join(lines)

_last = {}

async def notify_with_keyboard(event, detail="", cooldown=300, *, severity="routine", fields=None, keyboard=None):
    """Like notify but attach inline keyboard to owner DM."""
    if severity not in {"routine","critical"}:
        raise ValueError("Unsupported notification severity")
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token: return
    topic = os.getenv("TELEGRAM_LOG_TOPIC_ID")
    destination = os.getenv("TELEGRAM_DESTINATION")
    owner = os.getenv("TELEGRAM_OWNER_ID")
    if not topic:
        try:
            import sqlite3
            with sqlite3.connect(os.getenv("VN_DATABASE_PATH","data/vn-reader.sqlite3")) as db:
                row = db.execute("SELECT value FROM tg_meta WHERE key='logs_topic_id'").fetchone()
                topic = json.loads(row[0]) if row else None
        except Exception: pass
    text = format_operator_event(event, detail, severity, fields)
    async def deliver(route, payload, interval):
        key=(route,severity,event)
        now=time.monotonic()
        if now-_last.get(key,-float("inf"))<interval: return
        _last[key]=now
        def send():
            req=urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                data=json.dumps({**payload,"text":text,"parse_mode":"HTML"}).encode(),
                headers={"Content-Type":"application/json"})
            with urllib.request.urlopen(req, timeout=8) as response:
                if not json.load(response).get("ok"): raise RuntimeError("Notification rejected")
        try: await asyncio.to_thread(send)
        except Exception: logging.getLogger(__name__).warning("Operator %s notification could not be delivered",route)
    deliveries=[]
    try:
        topic_number=int(topic)
        if topic_number>0 and destination:
            deliveries.append(deliver("topic",{"chat_id":destination,"message_thread_id":topic_number}, max(0,cooldown)))
    except (TypeError,ValueError): pass
    if severity=="critical" and owner:
        async def deliver_owner():
            key=("owner",severity,event)
            now=time.monotonic()
            if now-_last.get(key,-float("inf"))<max(300,cooldown): return
            _last[key]=now
            payload={"chat_id":owner, "text":text, "parse_mode":"HTML"}
            if keyboard: payload["reply_markup"]=keyboard
            def send():
                req=urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                    data=json.dumps(payload).encode(), headers={"Content-Type":"application/json"})
                with urllib.request.urlopen(req, timeout=8) as response:
                    if not json.load(response).get("ok"): raise RuntimeError("Notification rejected")
            try: await asyncio.to_thread(send)
            except Exception: logging.getLogger(__name__).warning("Operator owner notification could not be delivered")
        deliveries.append(deliver_owner())
    if deliveries: await asyncio.gather(*deliveries)
async def notify(event, detail="", cooldown=300, *, severity="routine", fields=None):
    """Send routine events to Logs and explicit critical events to the owner too."""
    if severity not in {"routine", "critical"}:
        raise ValueError("Unsupported notification severity")
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token: return
    topic = os.getenv("TELEGRAM_LOG_TOPIC_ID")
    destination = os.getenv("TELEGRAM_DESTINATION")
    owner = os.getenv("TELEGRAM_OWNER_ID")
    if not topic:
        # Mirror shares durable metadata but never creates competing topics.
        try:
            import sqlite3
            with sqlite3.connect(os.getenv("VN_DATABASE_PATH", "data/vn-reader.sqlite3")) as db:
                row = db.execute("SELECT value FROM tg_meta WHERE key='logs_topic_id'").fetchone()
                topic = json.loads(row[0]) if row else None
        except Exception: pass
    text = format_operator_event(event, detail, severity, fields)

    async def deliver(route, payload, interval):
        key = (route, severity, event)
        now = time.monotonic()
        if now - _last.get(key, -float("inf")) < interval: return
        # Set before awaiting so simultaneous failures cannot flood the operator.
        _last[key] = now
        def send():
            req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                data=json.dumps({**payload, "text": text, "parse_mode": "HTML"}).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=8) as response:
                if not json.load(response).get("ok"): raise RuntimeError("Notification rejected")
        try: await asyncio.to_thread(send)
        except Exception:
            # Never print exceptions: Bot API URLs contain the bot credential.
            logging.getLogger(__name__).warning("Operator %s notification could not be delivered", route)

    deliveries = []
    try:
        topic_number = int(topic)
        if topic_number > 0 and destination:
            deliveries.append(deliver("topic", {"chat_id": destination, "message_thread_id": topic_number}, max(0, cooldown)))
    except (TypeError, ValueError): pass
    if severity == "critical" and owner:
        # Owner delivery is independent of a missing, failing or throttled topic.
        deliveries.append(deliver("owner", {"chat_id": owner}, max(300, cooldown)))
    if deliveries: await asyncio.gather(*deliveries)

async def configure_topic(store):
    # The operator supplies an existing topic. Never create another on restart.
    topic = os.getenv("TELEGRAM_LOG_TOPIC_ID") or store.meta("logs_topic_id")
    try:
        topic = int(topic)
        if topic <= 0: raise ValueError()
    except (TypeError, ValueError):
        logging.getLogger(__name__).warning("Set TELEGRAM_LOG_TOPIC_ID to the existing Logs topic ID")
        return
    store.set_meta("logs_topic_id", topic)
    os.environ["TELEGRAM_LOG_TOPIC_ID"] = str(topic)
