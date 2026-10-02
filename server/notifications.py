"""Best-effort operator events; never includes credentials or reader content."""
import asyncio
import json
import os
import time
import urllib.request
import logging

_last = {}
async def notify(event, detail="", cooldown=300):
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    topic = os.getenv("TELEGRAM_LOG_TOPIC_ID")
    destination = os.getenv("TELEGRAM_DESTINATION")
    if not topic:
        # Mirror shares the durable metadata but never creates competing topics.
        try:
            import sqlite3
            with sqlite3.connect(os.getenv("VN_DATABASE_PATH","data/vn-reader.sqlite3")) as db:
                row=db.execute("SELECT value FROM tg_meta WHERE key='logs_topic_id'").fetchone()
                topic=json.loads(row[0]) if row else None
        except Exception: pass
    if not token or not topic or not destination: return
    now = time.monotonic()
    if now - _last.get(event, -cooldown) < cooldown: return
    _last[event] = now
    def send():
        data = json.dumps({"chat_id": destination, "message_thread_id": int(topic),
                           "text": f"vn reader · {event}\n{detail}"[:1000]}).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as response:
            if not json.load(response).get("ok"): raise RuntimeError("Notification rejected")
    try: await asyncio.to_thread(send)
    except Exception: logging.getLogger(__name__).warning("Operator notification could not be delivered")

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
