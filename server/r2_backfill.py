"""Operator CLI: backfill existing Telegram-copied media to R2 (single bucket).

Usage:
  python -m server.r2_backfill              # all missing
  python -m server.r2_backfill --limit 100  # first 100 missing
  python -m server.r2_backfill --dry-run    # plan without uploading

Hard caps enforced: storage headroom, Class A reserve (atomic, fail-closed),
Class B (for the Telegram download path only).  On any cap exception the
run stops — it never falls back to an uncapped path.

Requires R2_ENABLED + creds; uses VN_DATABASE_PATH or --env-file.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import sys

from dotenv import load_dotenv

log = logging.getLogger(__name__)


async def run(limit: int | None = None, dry_run: bool = False) -> dict:
    from server.mirror import MirrorStore, configuration
    from server import r2_store as r2

    cfg = configuration()
    if not cfg:
        raise RuntimeError("Missing Telegram configuration")

    r2cfg = r2.load_r2_config()
    if not r2cfg.enabled or not r2cfg.primary:
        raise RuntimeError("R2 is not configured — set R2_ENABLED=1 and R2_* in your env file")

    store = MirrorStore(cfg["database"])

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

    from telethon import TelegramClient
    from server.bot_sessions import create_bot_session

    print(f"Backfilling {len(candidates)} posts to R2 …")
    bot = TelegramClient(create_bot_session("api"), cfg["api_id"], cfg["api_hash"], flood_sleep_threshold=0)
    await bot.start(bot_token=cfg["bot_token"])
    dest = await bot.get_input_entity(cfg["destination"])

    uploaded = failed = skipped = blocked = 0
    for sid, rec in candidates:
        row = store.row(sid)
        dest_id = None
        try:
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
            # Choose account + check caps — fail-closed; never fallback to primary on error
            try:
                acct = r2.choose_account_for_write(r2cfg, db=store.db, upcoming_bytes=len(data))
            except Exception as exc:
                print(f"R2 cap check error at #{sid}: {exc} — stopping (fail-closed).")
                blocked += 1
                break
            if not acct:
                print(f"R2 write capped at #{sid} (storage or Class A) — stopping. Remaining {len(candidates)-uploaded-skipped-blocked} skipped.")
                blocked = len(candidates) - uploaded - skipped - blocked
                break
            # Atomic Class A reserve BEFORE the PUT
            ok_a, reason_a = r2.reserve_class_a(store.db, acct.bucket, 1)
            if not ok_a:
                print(f"Class A exhausted at #{sid}: {reason_a} — stopping.")
                blocked = len(candidates) - uploaded - skipped
                break
            try:
                ct = getattr(file, "mime_type", None)
                url = await asyncio.to_thread(r2.upload_bytes, acct, key, data, ct)
            except Exception as exc:
                # Reservation already counted — over-count is safe
                log.warning("Backfill PUT failed for #%s after reservation: %s", sid, exc)
                failed += 1
                continue
            store.save_r2_media(sid, key, acct.bucket, url, len(data))
            uploaded += 1
            if uploaded % 25 == 0:
                print(f"  … {uploaded} uploaded")
        except Exception as exc:
            if exc.__class__.__name__ == "FloodWaitError":
                wait = int(getattr(exc, "seconds", 10)) + 1
                print(f"  FloodWait {wait}s at #{sid} — pausing …")
                await asyncio.sleep(wait)
                continue
            log.warning("Backfill failed for #%s: %s", sid, exc)
            failed += 1

    await bot.disconnect()
    store.close()
    print(f"Done: {uploaded} uploaded, {failed} failed, {skipped} skipped, {blocked} blocked by caps (total {len(candidates)})")
    return {"uploaded": uploaded, "failed": failed, "skipped": skipped, "blocked": blocked, "total": len(candidates)}


def main() -> None:
    ap = argparse.ArgumentParser(description="Backfill Telegram-copied media to R2 (single bucket)")
    ap.add_argument("--limit", type=int, default=None, help="Max posts to backfill")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--env-file", default=".env.production")
    args = ap.parse_args()
    load_dotenv(args.env_file)
    logging.basicConfig(level=logging.INFO)
    result = asyncio.run(run(limit=args.limit, dry_run=args.dry_run))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
