"""Public archive API and bounded HTTP media relay from the private Telegram group."""
from __future__ import annotations
import asyncio
import logging
import math
import os
import re
import time
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import Response, StreamingResponse, RedirectResponse
from .mirror import MirrorStore, configuration, error_label
from .notifications import notify, configure_topic, FIELD_SCHEMA
from .streaming import parse_range, media_headers, telegram_chunks, RangeNotSatisfiable, media_file_info
from .media_lookup import MediaLookupCache
try:
    from . import r2_store as _r2  # optional — degrade gracefully if boto absent
    from .r2_media import r2_headers, r2_range_headers, r2_stream, r2_redirect_url
except Exception as exc:  # pragma: no cover
    logging.getLogger(__name__).warning("R2 modules could not load (%s); media will use Telegram", exc.__class__.__name__)
    _r2 = None  # type: ignore
    r2_headers = r2_range_headers = r2_stream = r2_redirect_url = None  # type: ignore

router = APIRouter()
log = logging.getLogger(__name__)
_client = None
_store = None
_destination = None
_slots = asyncio.Semaphore(8)
_reconnect_lock = asyncio.Lock()
_media_lookups = MediaLookupCache()


_config = None
_recovery_task = None
_last_error = None
_closing = False
_pending_client = None
_retry_not_before = 0.0
_reset_session = False
_CONNECT_TIMEOUT = 20
_RETRY_DELAY = 5
_media_retry_not_before = 0.0


def _r2_enabled() -> bool:
    if _r2 is None:
        return False
    try:
        return bool(_r2.load_r2_config().enabled)
    except Exception:
        return False

# Single public bucket: media.vidurneeti.xyz
# (Secondary private bucket will be wired later if needed.)


def _media_retry_remaining():
    return max(0, math.ceil(_media_retry_not_before - time.monotonic()))


def _record_media_flood(exc, source_id, stage):
    """Share Telegram's cooldown across requests without resetting authorization."""
    global _media_retry_not_before
    seconds = max(1, int(exc.seconds)) + 1
    _media_retry_not_before = max(_media_retry_not_before, time.monotonic() + seconds)
    seconds = _media_retry_remaining()
    rpc = getattr(exc, "request", None)
    rpc_name = rpc.__class__.__name__ if rpc is not None else None
    if rpc_name and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", rpc_name):
        rpc_name = None
    fields = {"post": f"#{source_id}", "stage": stage, "retryAfter": f"{seconds}s", "error": "FloodWaitError"}
    if rpc_name:
        fields["route"] = rpc_name
    log.warning("Telegram media rate limited at %s for post #%s; request=%s; retry after %ss", stage, source_id, rpc_name or "unknown", seconds)
    asyncio.create_task(notify("Media rate limited", "Telegram requested a pause. Media can be retried after the cooldown.", fields=fields))
    return _media_retry_remaining()


def archive_enabled():
    return (_store is not None and _client is not None and _destination is not None
            and getattr(_client, "is_connected", lambda: True)())


def archive_status():
    archive_ready = _store is not None and bool(_store.meta("source"))
    media_ready = bool(archive_enabled())
    return {"status": "ok" if archive_ready and media_ready else "degraded" if archive_ready else "unavailable",
            "archiveEnabled": _store is not None, "archiveReady": archive_ready,
            "botControlsReady": media_ready and bool(getattr(_client, "_vn_r2_controls_registered", False)),
            "mediaReady": media_ready, "error": _last_error,
            "retryAfter": _retry_remaining()}


def _retry_remaining():
    return max(0, math.ceil(_retry_not_before - time.monotonic()))


async def _disconnect(client):
    if client is not None:
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except Exception:
            log.warning("Telegram client cleanup did not complete")


async def _connect_client():
    global _client, _destination, _last_error, _pending_client, _retry_not_before, _reset_session
    async with _reconnect_lock:
        if _closing or not _config or archive_enabled():
            return bool(archive_enabled())
        if _retry_remaining():
            return False
        client = _pending_client
        try:
            from telethon import TelegramClient
            from .bot_sessions import create_bot_session
            if client is None:
                await _disconnect(_client)
                _client, _destination = None, None
                client = TelegramClient(create_bot_session("api",reset=_reset_session), _config["api_id"], _config["api_hash"],
                                        flood_sleep_threshold=0, connection_retries=2,
                                        request_retries=2, retry_delay=1, timeout=10)
                _reset_session = False
            async def initialize():
                await client.start(bot_token=_config["bot_token"])
                me = await client.get_me()
                if not me or not me.bot:
                    raise RuntimeError("The streaming session must belong to a bot")
                return await client.get_input_entity(_config["destination"])
            destination = await asyncio.wait_for(initialize(), timeout=_CONNECT_TIMEOUT)
        except asyncio.CancelledError:
            _pending_client = None
            _retry_not_before = 0.0
            await _disconnect(client)
            raise
        except Exception as exc:
            if exc.__class__.__name__ == "FloodWaitError":
                seconds = max(1, int(exc.seconds)) + 1
                _pending_client = client
                _retry_not_before = time.monotonic() + seconds
                _last_error = error_label(exc)
                log.warning("Telegram media connection rate limited; retrying the same session in %ss", seconds)
                return False
            _pending_client = None
            _retry_not_before = 0.0
            if exc.__class__.__name__ in {"AuthKeyDuplicatedError", "AuthKeyUnregisteredError", "SessionRevokedError", "SessionExpiredError"}:
                _reset_session = True
            await _disconnect(client)
            _last_error = error_label(exc)
            log.error("Telegram media unavailable (%s); automatic recovery will retry", _last_error)
            await notify("Archive connection failed", _last_error, severity="critical")
            return False
        recovered = _last_error is not None
        _pending_client = None
        _retry_not_before = 0.0
        _client, _destination, _last_error = client, destination, None
        _register_r2_controls(client)
        log.info("Telegram media connection ready")
        asyncio.create_task(notify("Archive connection recovered" if recovered else "Archive service started"))
        return True


async def _supervise():
    delay = _RETRY_DELAY
    while not _closing:
        await asyncio.sleep(max(delay, _retry_remaining()))
        if archive_enabled():
            delay = _RETRY_DELAY
            continue
        try:
            ready = await _connect_client()
        except Exception as exc:
            log.error("Telegram recovery failed (%s); retrying", error_label(exc))
            await notify("Archive recovery failed", error_label(exc), severity="critical")
            ready = False
        delay = _RETRY_DELAY if ready else min(60, delay * 2)


async def _r2_bucket_stats(account):
    """Probe R2 off the event loop with a separate connection for usage accounting."""
    database_path = _store.db.execute("PRAGMA database_list").fetchone()[2] if _store else ""

    def probe():
        if not database_path:
            return _r2.bucket_stats(account)
        import sqlite3
        db = sqlite3.connect(database_path, timeout=30)
        try:
            return _r2.bucket_stats(account, db=db)
        finally:
            db.close()

    return await asyncio.to_thread(probe)


async def _r2_status_bundle():
    """Gather stats + build (text, parse_mode, keyboard) for bot replies. Reuses r2_controls formatters."""
    from server.r2_controls import format_r2_status_text_with_flags, build_r2_keyboard
    cfg = _r2.load_r2_config() if _r2 else None
    if not cfg or not cfg.enabled:
        return "<b>R2 unavailable</b>\nR2 is disabled or not configured. Check the archive image and R2 settings in .env.production.", "HTML", {"inline_keyboard": []}
    stats = None
    ca = cb = 0
    local = None
    if cfg and cfg.primary:
        try:
            stats = await _r2_bucket_stats(cfg.primary)
        except Exception:
            from server.r2_store import BucketStats as _BS
            stats = _BS(bucket=cfg.primary.bucket, account_id=cfg.primary.account_id, objects=0, bytes_used=0)
        try: ca = _r2.class_a_used(_store.db, cfg.primary.bucket)  # type: ignore[union-attr]
        except Exception: pass
        try: cb = _r2.class_b_used(_store.db, cfg.primary.bucket)  # type: ignore[union-attr]
        except Exception: pass
        try: local = _store.r2_counts()  # type: ignore[union-attr]
        except Exception: pass
    if stats is None:
        from server.r2_store import BucketStats as _BS2
        stats = _BS2(bucket="—", account_id="", objects=0, bytes_used=0)
    text, mode = format_r2_status_text_with_flags(_store.db, stats, ca, cb, local)  # type: ignore[union-attr]
    kb = build_r2_keyboard(_store.db)  # type: ignore[union-attr]
    return text, mode, kb

def _register_r2_controls(client):
    """Register Telethon handlers for R2 controls (owner-only): /start, /r2stats, + callbacks."""
    if getattr(client, "_vn_r2_controls_registered", False):
        return
    try:
        from telethon import events
        from server.r2_controls import handle_r2_callback
        @client.on(events.NewMessage(incoming=True, pattern=r"^/start(\b|@)", func=lambda e: getattr(e, "is_private", False)))
        async def _on_r2_start(event):
            try:
                owner = int(os.getenv("TELEGRAM_OWNER_ID", "0") or 0)
            except Exception:
                owner = 0
            sender = getattr(event, "sender_id", None) or getattr(getattr(event, "sender", None), "id", 0)
            if not owner or int(sender or 0) != owner:
                return
            try:
                text, mode, kb = await _r2_status_bundle()
                await event.respond(text, parse_mode="html", buttons=_kb_to_telethon(kb))
            except Exception as exc:
                log.warning("R2 /start reply failed: %s", exc)

        @client.on(events.NewMessage(incoming=True, pattern=r"^/r2stats(\b|@)", func=lambda e: getattr(e, "is_private", False)))
        async def _on_r2stats(event):
            try:
                owner = int(os.getenv("TELEGRAM_OWNER_ID", "0") or 0)
            except Exception:
                owner = 0
            sender = getattr(event, "sender_id", None) or getattr(getattr(event, "sender", None), "id", 0)
            if not owner or int(sender or 0) != owner:
                return
            try:
                text, mode, kb = await _r2_status_bundle()
                await event.respond(text, parse_mode="html", buttons=_kb_to_telethon(kb))
            except Exception as exc:
                log.warning("R2 /r2stats reply failed: %s", exc)

        @client.on(events.CallbackQuery(pattern=r"^r2_"))
        async def _on_r2_callback(event):
            if _store is None:
                await event.answer("Store unavailable")
                return
            data = event.data.decode() if isinstance(event.data, bytes) else str(event.data)
            sender = getattr(event, "sender_id", None) or getattr(getattr(event, "sender", None), "id", 0)
            action, should_refresh = handle_r2_callback(data, int(sender or 0), _store.db)
            if action == "unauthorized":
                await event.answer("Not authorized", alert=True)
                return
            await event.answer(action)
            if should_refresh:
                try:
                    text, mode, kb = await _r2_status_bundle()
                    await event.edit(text, parse_mode="html", buttons=_kb_to_telethon(kb))
                except Exception as exc:
                    log.warning("R2 callback edit failed: %s", exc)
        client._vn_r2_controls_registered = True
        log.info("R2 controls command and callback handlers registered")
    except Exception as exc:
        log.warning("R2 controls handler not registered: %s", exc)

def _kb_to_telethon(kb: dict):
    """Convert Bot API inline_keyboard JSON to Telethon buttons."""
    try:
        from telethon import Button
        rows = []
        for row in kb.get("inline_keyboard", []):
            trow = [Button.inline(b["text"], data=b["callback_data"].encode()) for b in row]
            rows.append(trow)
        return rows
    except Exception:
        return None

async def start_telegram():
    os.umask(0o077)
    global _store, _config, _recovery_task, _last_error, _closing
    _closing = False
    try:
        _config = configuration()
    except Exception as exc:
        _last_error = error_label(exc)
        await notify("Archive startup failed", _last_error, severity="critical")
        raise
    if not _config:
        _last_error = "MissingTelegramConfiguration"
        log.error("Telegram archive configuration is incomplete")
        await notify("Archive startup failed", _last_error, severity="critical")
        return
    try:
        store = MirrorStore(_config["database"])
        identity = store.meta("identity")
        if identity and identity["destination"] != str(_config["destination"]):
            store.close()
            raise RuntimeError("Configured storage group differs from archive mapping")
        _store = store
        await configure_topic(store)
    except Exception as exc:
        _last_error = error_label(exc)
        log.error("Archive database startup failed (%s)", _last_error)
        await notify("Archive startup failed", _last_error, severity="critical")
        raise
    await _connect_client()
    _recovery_task = asyncio.create_task(_supervise())


async def stop_telegram():
    global _client, _store, _destination, _config, _recovery_task, _closing, _pending_client, _retry_not_before, _reset_session, _media_retry_not_before
    _closing = True
    if _recovery_task is not None:
        _recovery_task.cancel()
        try:
            await _recovery_task
        except asyncio.CancelledError:
            pass
        _recovery_task = None
    await _media_lookups.clear()
    await _disconnect(_client)
    if _pending_client is not _client:
        await _disconnect(_pending_client)
    if _store:
        _store.close()
    _client, _store, _destination, _config = None, None, None, None
    _pending_client, _retry_not_before = None, 0.0
    _reset_session = False
    _media_retry_not_before = 0.0


@router.post("/api/r2-control")
async def r2_control(request: Request):
    """Owner-gated R2 controls — toggles flags and returns updated status + keyboard.
    Auth: Bearer TELEGRAM_BOT_TOKEN or x-vn-internal, and body must include owner intent.
    For bot DMs, use the CallbackQuery handler instead."""
    import secrets as _sec, json as _json
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    auth = request.headers.get("authorization", "")
    internal = request.headers.get("x-vn-internal", "")
    bearer_ok = bool(token and _sec.compare_digest(auth, f"Bearer {token}"))
    if not bearer_ok and internal != "account-service":
        raise HTTPException(401, "Admin session required")
    if _store is None:
        raise HTTPException(503, "Store not ready")
    try:
        body = _json.loads((await request.body()) or b"{}")
    except Exception:
        body = {}
    action = body.get("action", "")
    sender = body.get("sender_id") or int(os.getenv("TELEGRAM_OWNER_ID", "0") or 0)
    try:
        from server.r2_controls import handle_r2_callback as _h, format_r2_status_text_with_flags as _fmt, build_r2_keyboard as _kb
        msg, _ = _h(action, int(sender), _store.db)
        if msg == "unauthorized":
            raise HTTPException(403, "Not authorized")
        # Build fresh status
        stats = None
        ca = cb = 0
        local = None
        if _r2:
            cfg = _r2.load_r2_config()
            if cfg.primary:
                try: stats = await _r2_bucket_stats(cfg.primary)
                except Exception:
                    from server.r2_store import BucketStats as _BS
                    stats = _BS(bucket=cfg.primary.bucket, account_id=cfg.primary.account_id, objects=0, bytes_used=0)
                try: ca = _r2.class_a_used(_store.db, cfg.primary.bucket)
                except Exception: pass
                try: cb = _r2.class_b_used(_store.db, cfg.primary.bucket)
                except Exception: pass
                try: local = _store.r2_counts()
                except Exception: pass
        text, mode = _fmt(_store.db, stats, ca, cb, local) if stats else ("R2 not configured", "HTML")
        kb = _kb(_store.db)
        return {"ok": True, "action": msg, "text": text, "parse_mode": mode, "keyboard": kb}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc)[:300])

def _require_r2_admin(request: Request) -> None:
    """Shared auth for /api/r2-* — Bearer TELEGRAM_BOT_TOKEN or x-vn-internal."""
    import secrets as _sec
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    auth = request.headers.get("authorization", "")
    internal_caller = request.headers.get("x-vn-internal", "")
    bearer_ok = bool(token and _sec.compare_digest(auth, f"Bearer {token}"))
    if not bearer_ok and internal_caller != "account-service":
        raise HTTPException(401, "Admin session required")


def _r2_flags(db) -> dict:
    """Read tg_r2_controls flags for dashboard (single bucket)."""
    if db is None:
        return {"pausedWrites": False, "pausedReads": False, "autoStopped": False, "autoReason": ""}
    try:
        from server.r2_controls import get_control as _gc, is_paused as _ip, is_origin_paused
        return {
            "pausedWrites": bool(_ip(db, "r2_pause_writes") or _ip(db, "r2_pause_all") or _ip(db, "r2_auto_stopped")),
            "pausedReads": is_origin_paused(db),
            "autoStopped": bool(_ip(db, "r2_auto_stopped")),
            "autoReason": _gc(db, "r2_auto_stopped_reason") or "",
        }
    except Exception:
        return {"pausedWrites": False, "pausedReads": False, "autoStopped": False, "autoReason": ""}


def _monthly_counters(db) -> list[dict]:
    if db is None:
        return []
    try:
        db.execute("CREATE TABLE IF NOT EXISTS tg_r2_counters(month TEXT NOT NULL, bucket TEXT NOT NULL, class TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(month, bucket, class))")
        rows = db.execute("SELECT month, bucket, class, count FROM tg_r2_counters ORDER BY month DESC, bucket, class").fetchall()
        return [{"month": r[0], "bucket": r[1], "class": r[2], "count": int(r[3])} for r in rows]
    except Exception:
        return []


@router.get("/api/r2-stats")
async def r2_stats(request: Request):
    """Admin-only R2 storage probe — enriched for dashboard.

    Auth: either ``Authorization: Bearer <TELEGRAM_BOT_TOKEN>`` (operator/VPS) or
    a valid admin Better Auth session forwarded by the Node account service.
    No public access — caller must be admin-gated via accountService proxy or bearer.
    """
    _require_r2_admin(request)
    if _r2 is None:
        return {"enabled": False, "reason": "r2_store not available"}
    cfg = _r2.load_r2_config()
    if not cfg.enabled:
        return {"enabled": False, "reason": "R2 not configured — set R2_* in .env.production",
                "freeTierBytes": _r2.FREE_TIER_BYTES, "freeTierClassA": _r2.FREE_TIER_CLASS_A, "freeTierClassB": _r2.FREE_TIER_CLASS_B,
                "thresholds": {"warn90": _r2.WARN_90_PCT, "warn95": _r2.WARN_95_PCT, "autoStop98": _r2.AUTO_STOP_PCT}}
    out: dict = {"enabled": True, "freeTierBytes": _r2.FREE_TIER_BYTES,
                 "freeTierClassA": _r2.FREE_TIER_CLASS_A, "freeTierClassB": _r2.FREE_TIER_CLASS_B,
                 "thresholds": {"warn90": _r2.WARN_90_PCT, "warn95": _r2.WARN_95_PCT, "autoStop98": _r2.AUTO_STOP_PCT},
                 "accounts": []}
    db = _store.db if _store else None
    flags_top = _r2_flags(db)
    for label, acct in (("primary", cfg.primary),):
        if not acct:
            out["accounts"].append({"label": label, "configured": False})
            continue
        try:
            stats = await _r2_bucket_stats(acct)
            d: dict = {**stats.to_dict(), "publicBase": acct.public_base or f"https://{acct.bucket}.r2.dev", "configured": True}
            # Class counters — read in main thread (SQLite) to avoid cross-thread error
            if db is not None:
                try:
                    d["classAUsed"] = _r2.class_a_used(db, acct.bucket)
                    d["classApct"] = round(d["classAUsed"] / _r2.FREE_TIER_CLASS_A * 100, 2) if _r2.FREE_TIER_CLASS_A else 0
                except Exception:
                    d["classAUsed"] = 0; d["classApct"] = 0
                try:
                    d["classBUsed"] = _r2.class_b_used(db, acct.bucket)
                    d["classBpct"] = round(d["classBUsed"] / _r2.FREE_TIER_CLASS_B * 100, 2) if _r2.FREE_TIER_CLASS_B else 0
                except Exception:
                    d["classBUsed"] = 0; d["classBpct"] = 0
            else:
                d["classAUsed"] = d["classBUsed"] = 0
                d["classApct"] = d["classBpct"] = 0
            d["flags"] = dict(flags_top)
            out["accounts"].append({"label": label, **d})
        except Exception as exc:
            out["accounts"].append({"label": label, "configured": True, "error": f"{exc.__class__.__name__}: {str(exc)[:160]}",
                                     "flags": dict(flags_top)})
    if db is not None:
        try:
            cnt, b = _store.r2_counts()  # type: ignore[attr-defined]
            out["localR2Rows"] = {"objects": cnt, "bytes": b}
        except Exception:
            pass
        out["monthlyCounters"] = _monthly_counters(db)
    else:
        out["monthlyCounters"] = []
    out["flags"] = flags_top
    return out


@router.get("/api/r2-analytics")
async def r2_analytics(request: Request):
    """Time-series friendly analytics — admin only (same auth as r2-stats).

    Returns storageHistory (30d), classSeries (daily proxy from monthly counters),
    and topObjects (largest keys). History is synthesized from current snapshot
    if tg_meta history is unavailable — still returns current counters by month.
    """
    _require_r2_admin(request)
    if _r2 is None:
        return {"enabled": False, "reason": "r2_store not available"}
    cfg = _r2.load_r2_config()
    if not cfg.enabled:
        return {"enabled": False, "reason": "R2 not configured"}
    db = _store.db if _store else None
    # Current snapshot for synthesis
    snapshot: dict | None = None
    if cfg.primary:
        try:
            stats = await _r2_bucket_stats(cfg.primary)
            snapshot = stats.to_dict()
        except Exception:
            pass
    # Storage history — try tg_meta json array, else synthesize current point
    storage_history: list[dict] = []
    try:
        if db is not None:
            row = db.execute("SELECT value FROM tg_meta WHERE key='r2_storage_history'").fetchone()
            if row:
                import json as _json
                parsed = _json.loads(row[0])
                if isinstance(parsed, list):
                    storage_history = parsed[-30:]
    except Exception:
        pass
    if not storage_history and snapshot:
        import datetime as _dt
        today = _dt.date.today().isoformat()
        storage_history = [{"date": today, "bytesUsed": snapshot.get("bytesUsed", 0), "objects": snapshot.get("objects", 0)}]
    # Class series: expand monthly counters into daily-ish projection
    monthly = _monthly_counters(db)
    # Build classSeries as per-month aggregates (time-series friendly for chart)
    class_series = [{"month": r["month"], "bucket": r["bucket"], "class": r["class"], "count": r["count"]} for r in monthly]
    # Top objects
    top_objects: list[dict] = []
    try:
        if db is not None:
            rows = db.execute("SELECT source_id, r2_key, r2_bucket, bytes FROM tg_r2_media ORDER BY bytes DESC LIMIT 20").fetchall()
            top_objects = [{"sourceId": r[0], "key": r[1], "bucket": r[2], "bytes": r[3]} for r in rows]
    except Exception:
        pass
    return {
        "enabled": True,
        "storageHistory": storage_history,
        "classSeries": class_series,
        "monthlyCounters": monthly,
        "topObjects": top_objects,
        "snapshot": snapshot,
        "flags": _r2_flags(db),
        "thresholds": {"warn90": _r2.WARN_90_PCT, "warn95": _r2.WARN_95_PCT, "autoStop98": _r2.AUTO_STOP_PCT},
    }


@router.get("/api/archive")
async def archive(request: Request):
    if not _store:
        raise HTTPException(503, "The hosted archive is not configured yet")
    with _store.archive_snapshot() as revision:
        if revision is None:
            raise HTTPException(503, "The archive is waiting for its first import")
        etag = f'W/"vn-archive-v1-{revision}"'
        headers = {"ETag": etag, "Cache-Control": "public, no-cache"}
        validators = request.headers.get("if-none-match", "").split(",")
        if any(value.strip() == "*" or value.strip().removeprefix("W/") == etag.removeprefix("W/") for value in validators):
            return Response(status_code=304, headers=headers)
        return Response(_store.archive_json(revision), media_type="application/json", headers=headers)


@router.api_route("/api/media/{source_id}", methods=["GET", "HEAD"])
async def media(source_id: int, request: Request):
    if source_id <= 0: raise HTTPException(404, "Media not found")
    if _store is None:
        raise HTTPException(503, "Media connection is recovering", headers={"Retry-After": str(_retry_remaining() or 5)})
    # ── R2 fast-path: gated by R2_ENABLED — when disabled, fall through to Telegram ──
    # r2_redirect_url is only for keys already indexed in tg_r2_media — never arbitrary keys (prevents enumeration).
    # Bucket is private (no public ACL/list); uploads ONLY via server S3 credentials scoped to this bucket.
    _r2_all_paused = False
    _r2_origin_paused = False
    if _r2_enabled():
        try:
            from server.r2_controls import is_all_paused as _is_all, is_origin_paused as _is_orig
            if _store is not None:
                _r2_all_paused = _is_all(_store.db)
                _r2_origin_paused = _is_orig(_store.db)
        except Exception:
            pass
        if _r2_all_paused:
            log.info("R2 entire blocked via controls — serving post #%s from Telegram (no CDN)", source_id)
        elif _r2_origin_paused:
            log.info("R2 origin blocked via controls — post #%s may use CDN 302 only", source_id)
        if not _r2_all_paused:
            try:
                r2row = _store.r2_row(source_id)  # type: ignore[attr-defined]
            except Exception:
                r2row = None
            if r2row and r2row["r2_key"] and r2row["r2_bucket"]:
                cfg = _r2.load_r2_config()
                acct = cfg.primary if cfg.primary and cfg.primary.bucket == r2row["r2_bucket"] else None
                if acct:
                    try:
                        # Size/etag come from SQLite — never HEAD (saves Class A/B).
                        r2_size = int(r2row["bytes"]) if r2row["bytes"] else None
                        r2_etag_val = r2row["etag"]
                        if r2_size is None or r2_size == 0:
                            if _store is not None:
                                ok_b, _ = _r2.reserve_class_b(_store.db, acct.bucket, 1)  # type: ignore
                                if not ok_b:
                                    raise RuntimeError("Class B cap — cannot HEAD R2 object, falling back to Telegram")
                            meta = await asyncio.to_thread(_r2.head_object, acct, r2row["r2_key"])
                            if meta is None:
                                raise FileNotFoundError("R2 key missing")
                            r2_size = int(meta.get("ContentLength", 0))
                        r2_etag_hdr = f'"{r2_etag_val}"' if r2_etag_val else None
                        range_header = request.headers.get("range")
                        if request.headers.get("if-range") and r2_etag_hdr and request.headers["if-range"] != r2_etag_hdr:
                            range_header = None
                        try:
                            start, end, partial = parse_range(range_header, r2_size)
                        except RangeNotSatisfiable:
                            return Response(status_code=416, headers={"Content-Range": f"bytes */{r2_size}", "Accept-Ranges": "bytes"})
                        try:
                            rec = __import__("json").loads(_store.row(source_id)["record"] if _store.row(source_id) else "{}")
                        except Exception:
                            rec = {}
                        mime = (rec.get("media_raw") or {}).get("mime_type")
                        fname = (rec.get("media_raw") or {}).get("name") or r2row["r2_key"].rsplit("/", 1)[-1]
                        is_range = partial or request.headers.get("range")
                        if not is_range and acct.public_base and request.method == "GET":
                            url = r2_redirect_url(acct, r2row["r2_key"])  # type: ignore
                            if url:
                                if _store is not None:
                                    _r2.reserve_class_b(_store.db, acct.bucket, 1)  # type: ignore
                                return RedirectResponse(url=url, status_code=302, headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Media-Source": "r2-redirect"})
                        if _store is not None:
                            ok_b, reason_b = _r2.reserve_class_b(_store.db, acct.bucket, 1)  # type: ignore
                            if not ok_b:
                                log.warning("Class B cap for %s — falling back to Telegram for #%s: %s", acct.bucket, source_id, reason_b)
                                raise RuntimeError(reason_b)
                        if partial:
                            headers = r2_range_headers(r2_size, start, end, mime, fname, r2_etag=r2_etag_hdr)  # type: ignore
                            status = 206
                        else:
                            headers = r2_headers(r2_size, mime, fname, r2_etag=r2_etag_hdr)  # type: ignore
                            if r2_etag_hdr:
                                headers["ETag"] = r2_etag_hdr
                            status = 200
                        if r2_etag_hdr:
                            headers["ETag"] = r2_etag_hdr
                        if request.method == "HEAD":
                            return Response(status_code=status, headers=headers)
                        async def r2_body():
                            async for chunk in r2_stream(acct, r2row["r2_key"], start, end):  # type: ignore
                                if await request.is_disconnected():
                                    return
                                yield chunk
                        return StreamingResponse(r2_body(), status_code=status, headers=headers, media_type=None)
                    except FileNotFoundError:
                        log.warning("R2 key %s missing for post #%s — falling back to Telegram", r2row["r2_key"], source_id)
                    except RuntimeError as exc:
                        if "Class B" not in str(exc):
                            log.warning("R2 media failed for post #%s (%s) — falling back to Telegram", source_id, exc.__class__.__name__)
                    except Exception as exc:
                        log.warning("R2 media failed for post #%s (%s) — falling back to Telegram", source_id, exc.__class__.__name__)
                        pass
    if _client is None or _destination is None:
        raise HTTPException(503, "Media connection is recovering", headers={"Retry-After": str(_retry_remaining() or 5)})
    row = _store.row(source_id)
    if not row or row["status"] != "copied" or not row["destination_id"]:
        raise HTTPException(404, "Media not found")
    def check_cooldown():
        seconds = _media_retry_remaining()
        if seconds:
            raise HTTPException(503, "Telegram media is rate limited; retry after the cooldown", headers={"Retry-After": str(seconds), "X-Media-Status": "rate-limited", "Cache-Control": "no-store"})
    check_cooldown()
    try:
        await asyncio.wait_for(_slots.acquire(), timeout=5)
    except asyncio.TimeoutError:
        raise HTTPException(503, "Media service busy", headers={"Retry-After": "5"})
    handed_off = False
    try:
        async def fetch(force=False):
            global _client, _destination, _last_error, _reset_session
            check_cooldown()
            client, destination = _client, _destination
            media_destination = getattr(_store, "media_destination", None)
            destination_id = media_destination(source_id) if media_destination else row["destination_id"]
            async def lookup(current_client, current_destination):
                async def load():
                    try:
                        return await asyncio.wait_for(current_client.get_messages(current_destination, ids=destination_id), timeout=20)
                    except Exception as exc:
                        if exc.__class__.__name__ == "FloodWaitError":
                            _record_media_flood(exc, source_id, "Lookup")
                            check_cooldown()
                        raise
                return await _media_lookups.get(current_client, current_destination, destination_id, load, force=force)
            try:
                return await lookup(client, destination)
            except Exception as exc:
                invalid_auth = exc.__class__.__name__ in {"AuthKeyDuplicatedError", "AuthKeyUnregisteredError", "SessionRevokedError", "SessionExpiredError"}
                if invalid_auth:
                    async with _reconnect_lock:
                        if _client is client:
                            await _disconnect(client)
                            _client, _destination = None, None
                            _last_error = error_label(exc)
                            _reset_session = True
                    if not await _connect_client():
                        raise ConnectionError("Telegram authorization is recovering") from exc
                elif isinstance(exc, (ConnectionError, asyncio.TimeoutError)):
                    async with _reconnect_lock:
                        if _client is client and not client.is_connected():
                            await asyncio.wait_for(client.connect(), timeout=15)
                else:
                    raise
                if _client is None:
                    raise ConnectionError("Telegram connection is recovering")
                result = await lookup(_client, _destination)
                asyncio.create_task(notify("Telegram media connection recovered"))
                return result
        message = await fetch()
        if not message or not message.file or message.file.size is None:
            from telethon.tl.types import MessageMediaWebPage
            if message and isinstance(getattr(message, "media", None), MessageMediaWebPage):
                raise HTTPException(410, "Telegram no longer provides media for this link preview",
                                    headers={"X-Media-Status": "link-preview-unavailable", "Cache-Control": "no-store"})
            raise HTTPException(404, "Stored media not found")
        _, _, size = media_file_info(message)
        native_id = getattr(message.file.media, "id", row["destination_id"])
        etag = f'"tg-{source_id}-{native_id}-{size}"'
        range_header = request.headers.get("range")
        if request.headers.get("if-range") and request.headers["if-range"] != etag:
            range_header = None
        try:
            start, end, partial = parse_range(range_header, size)
        except RangeNotSatisfiable:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"})
        headers = media_headers(size, start, end, partial, message.file.mime_type, message.file.name)
        headers["ETag"] = etag
        status = 206 if partial else 200
        if request.method == "HEAD": return Response(status_code=status, headers=headers)
        async def body():
            async def flood_wait(exc):
                seconds = _record_media_flood(exc, source_id, "Download")
                if seconds > 5:
                    return False
                while _media_retry_remaining():
                    if await request.is_disconnected():
                        return False
                    if _media_retry_remaining() > 5:
                        return False
                    await asyncio.sleep(_media_retry_remaining())
                return True
            try:
                async def refresh():
                    return await fetch(force=True)
                async for chunk in telegram_chunks(_client, message, start, end, request.is_disconnected, refresh, get_client=lambda: _client, flood_wait=flood_wait):
                    yield chunk
            except Exception as exc:
                if exc.__class__.__name__ != "FloodWaitError" and not (isinstance(exc, HTTPException) and exc.headers and exc.headers.get("X-Media-Status") == "rate-limited"):
                    asyncio.create_task(notify("Media stream failed", "The media stream stopped before delivery completed.", severity="critical", fields={"post": f"#{source_id}", "stage": "Download", "error": exc.__class__.__name__}))
                raise
            finally:
                _slots.release()
        handed_off = True
        return StreamingResponse(body(), status_code=status, headers=headers, media_type=None)
    except HTTPException:
        raise
    except Exception as exc:
        if exc.__class__.__name__ == "FloodWaitError":
            _record_media_flood(exc, source_id, "Lookup")
            check_cooldown()
        log.warning("Stored Telegram media lookup failed (%s)", exc.__class__.__name__)
        asyncio.create_task(notify("Media delivery failed", "The stored media could not be retrieved.", severity="critical", fields={"post": f"#{source_id}", "stage": "Lookup", "error": exc.__class__.__name__}))
        raise HTTPException(502, "Stored media is temporarily unavailable")
    finally:
        if not handed_off: _slots.release()

@router.post("/internal/events")
async def operator_event(request: Request):
    import secrets
    token=os.getenv("TELEGRAM_BOT_TOKEN","")
    if not token or not secrets.compare_digest(request.headers.get("authorization",""),f"Bearer {token}"):
        raise HTTPException(403,"Forbidden")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8192: raise HTTPException(413, "Event too large")
    import json
    try: data=json.loads(raw)
    except ValueError: raise HTTPException(422,"Invalid event")
    if not isinstance(data,dict) or not isinstance(data.get("event"), str) or data.get("event") not in {"Account created","Email verified","Reader signed in","Reader login rejected","OTP email delivery failed","Account request failed","Account service started","Account service startup failed","Account service fatal"}:
        raise HTTPException(422,"Unsupported event")
    severity = data.get("severity", "routine")
    if not isinstance(severity, str) or severity not in {"routine", "critical"} or (severity == "critical" and data["event"] not in {"OTP email delivery failed", "Account request failed", "Account service startup failed", "Account service fatal"}):
        raise HTTPException(422, "Unsupported event severity")
    if not isinstance(data.get("detail", ""), str) or len(data.get("detail", "")) > 200:
        raise HTTPException(422, "Invalid event detail")
    fields = data.get("fields", {})
    if not isinstance(fields, dict) or any(key not in FIELD_SCHEMA or not isinstance(value, str) or len(value) > FIELD_SCHEMA[key]["limit"] for key, value in fields.items()):
        raise HTTPException(422, "Invalid event fields")
    options = {"fields": fields} if fields else {}
    asyncio.create_task(notify(data["event"], data.get("detail", ""), cooldown=0 if data["event"] in {"Account created", "Email verified", "Reader signed in"} else 300, severity=severity, **options))
    return {"ok":True}
