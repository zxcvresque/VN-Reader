"""Operator CLI: backfill existing Telegram-copied media to R2.

Usage:
  python -m server.r2_backfill              # all missing
  python -m server.r2_backfill --limit 100  # first 100 missing
  python -m server.r2_backfill --dry-run    # plan without uploading

Requires R2_ENABLED + creds in server/.env; uses VN_DATABASE_PATH.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

log = logging.getLogger(__name__)


async def run(limit: int | None = None, dry_run: bool = False) -> dict:
    from server.mirror import MirrorStore, configuration
    from server import r2_store as r2

    cfg = configuration()
    if not cfg:
        raise RuntimeError("Missing Telegram configuration in server/.env")

    r2cfg = r2.load_r2_config()
    if not r2cfg.enabled:
        raise RuntimeError("R2 is not configured — set R2_ENABLED=1 and R2_* vars in server/.env")

    store = MirrorStore(cfg["database"])

    # Find copied rows that have media but no R2 row
    all_rows = list(store.db.execute(
        "SELECT source_id, record FROM tg_messages WHERE status='copied' ORDER BY source_id"
    ))
    candidates: list[tuple[int, dict]] = []
    for sid, rec_json in all_rows:
        rec = json.loads(rec_json)
        if not rec.get("media_present"):
            continue
        if store.r2_row(sid):
            continue
        candidates.append((sid, rec))
        if limit and len(candidates) >= limit:
            break

    if dry_run:
        print(f"[dry-run] {len(candidates)} posts would be backfilled to R2")
        for sid, rec in candidates[:20]:
            print(f"  #{sid}  {rec.get('media_kind')}  {rec.get('media_raw', {}).get('name','')}  {rec.get('date_utc','')[:10]}")
        if len(candidates) > 20:
            print(f"  ... and {len(candidates)-20} more")
        store.close()
        return {"dryRun": True, "candidates": len(candidates)}

    if not candidates:
        print("No posts need R2 backfill.")
        store.close()
        return {"uploaded": 0, "failed": 0, "skipped": 0}

    # Need telethon clients — reuse the same bot-reader pattern as mirror watch,
    # but we only need the writer bot to fetch private copies.
    from telethon import TelegramClient
    from server.bot_sessions import create_bot_session

    print(f"Backfilling {len(candidates)} posts to R2 …")
    bot = TelegramClient(create_bot_session("api"), cfg["api_id"], cfg["api_hash"], flood_sleep_threshold=0)
    await bot.start(bot_token=cfg["bot_token"])
    dest = await bot.get_input_entity(cfg["destination"])

    uploaded = failed = skipped = 0
    for sid, rec in candidates:
        # Resolve destination message id for fetch
        row = store.row(sid)
        dest_id = None
        try:
            # Prefer media copy mapping
            mrow = store.db.execute("SELECT destination_id FROM tg_media_copies WHERE source_id=?", (sid,)).fetchone()
            dest_id = mrow[0] if mrow else (row["destination_id"] if row else None)
        except Exception:
            dest_id = row["destination_id"] if row else None
        if not dest_id:
            skipped += 1
            continue
        try:
            msg = await bot.get_messages(dest, ids=dest_id)
            if not msg or not getattr(msg, "file", None) or not getattr(msg.file, "media", None):
                skipped += 1
                continue
            file = msg.file
            fname = getattr(file, "name", None) or f"media-{sid}"
            year = (rec.get("date_utc") or "")[:4] or "unknown"
            if not year.isdigit():
                year = "unknown"
            key = r2.r2_key(year, sid, fname)
            buf = io.BytesIO()
            await bot.download_media(file.media, file=buf)
            data = buf.getvalue()
            if not data:
                skipped += 1
                continue
            # Choose account AFTER knowing exact size (storage + Class A caps)
            try:
                acct = r2.choose_account_for_write(r2cfg, db=store.db, upcoming_bytes=len(data))
            except Exception:
                acct = r2cfg.primary
            if not acct:
                print("R2 write capped (storage or Class A) — stopping. Fix caps or wait for next month.")
                break
            ct = getattr(file, "mime_type", None)
            url = await asyncio.to_thread(r2.upload_bytes, acct, key, data, ct)
            try:
                r2.record_class_a(store.db, acct.bucket, 1)
                r2.invalidate_stats_cache(acct)
            except Exception:
                pass
            store.save_r2_media(sid, key, acct.bucket, url, len(data))
            uploaded += 1
            if uploaded % 25 == 0:
                print(f"  … {uploaded} uploaded")
        except Exception as exc:
            # FileReference etc — log and continue
            if exc.__class__.__name__ == "FloodWaitError":
                wait = int(getattr(exc, "seconds", 10)) + 1
                print(f"  FloodWait {wait}s at #{sid} — pausing …")
                await asyncio.sleep(wait)
                continue
            log.warning("Backfill failed for #%s: %s", sid, exc)
            failed += 1

    await bot.disconnect()
    store.close()
    print(f"Done: {uploaded} uploaded, {failed} failed, {skipped} skipped (no media on Telegram)")
    return {"uploaded": uploaded, "failed": failed, "skipped": skipped, "total": len(candidates)}


def main() -> None:
    ap = argparse.ArgumentParser(description="Backfill Telegram-copied media to R2")
    ap.add_argument("--limit", type=int, default=None, help="Max posts to backfill")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--env-file", default="server/.env")
    args = ap.parse_args()
    load_dotenv(args.env_file)
    logging.basicConfig(level=logging.INFO)
    result = asyncio.run(run(limit=args.limit, dry_run=args.dry_run))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
