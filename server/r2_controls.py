"""R2 bot DM controls — rich status + inline keyboard + callback handling.

Single bucket only. Uses SQLite table ``tg_r2_controls`` (key TEXT PK, value TEXT)
for durable flags: r2_pause_writes, r2_pause_origin (primary), r2_pause_reads
(alias for backward compat), r2_pause_all, r2_auto_stopped, r2_auto_stopped_reason.

Semantics:
  - r2_pause_origin  blocks VPS GetObject (origin fetch) but keeps frontdesk 302 enabled.
  - r2_pause_all     blocks BOTH origin fetch and 302 redirect (100% Telegram fallback).
  - r2_pause_reads   kept as alias to r2_pause_origin / r2_pause_all for backward compat.

Security: only TELEGRAM_OWNER_ID may toggle; others are ignored.
"""
from __future__ import annotations
import html
import os

# ── control table helpers ──────────────────────────────────────

def _ensure_controls_table(db) -> None:
    db.execute("CREATE TABLE IF NOT EXISTS tg_r2_controls(key TEXT PRIMARY KEY, value TEXT NOT NULL)")

def get_control(db, key: str) -> str | None:
    try:
        _ensure_controls_table(db)
        row = db.execute("SELECT value FROM tg_r2_controls WHERE key=?", (key,)).fetchone()
        return row[0] if row else None
    except Exception:
        return None

def set_control(db, key: str, value: str) -> None:
    _ensure_controls_table(db)
    db.execute("INSERT INTO tg_r2_controls(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
    db.commit()

def delete_control(db, key: str) -> None:
    try:
        _ensure_controls_table(db)
        db.execute("DELETE FROM tg_r2_controls WHERE key=?", (key,))
        db.commit()
    except Exception:
        pass

def is_paused(db, key: str) -> bool:
    return get_control(db, key) == "1"

# ── pause predicates ───────────────────────────────────────────

def is_origin_paused(db) -> bool:
    """Origin fetch paused — blocks VPS GetObject but keeps 302."""
    # primary key r2_pause_origin; alias r2_pause_reads for backward compat
    return is_paused(db, "r2_pause_origin") or is_paused(db, "r2_pause_reads") or is_paused(db, "r2_pause_all")

def is_all_paused(db) -> bool:
    """Entire R2 paused — blocks both GetObject and 302."""
    return is_paused(db, "r2_pause_all")

def is_write_paused(db) -> bool:
    return is_paused(db, "r2_pause_writes") or is_paused(db, "r2_pause_all") or is_paused(db, "r2_auto_stopped")

def is_read_paused(db) -> bool:
    """Alias to is_all_paused for backward compat — callers that used read_paused
    expected blocking both. Origin-only pause is handled via is_origin_paused."""
    return is_all_paused(db)

# ── status formatting ──────────────────────────────────────────

def _pct(n: int, cap: int) -> float:
    return (n / cap * 100) if cap else 0

def format_r2_status_text(stats, class_a_used: int, class_b_used: int, local_counts: tuple[int,int] | None) -> tuple[str, str]:
    """Return (text, parse_mode). Uses HTML for safety (no MarkdownV2 escaping needed)."""
    from server.r2_store import FREE_TIER_BYTES, FREE_TIER_CLASS_A, FREE_TIER_CLASS_B
    pct = stats.percent if stats and hasattr(stats, "percent") else 0
    gib_used = stats.bytes_used / (1024**3) if stats else 0
    gib_quota = (stats.quota_bytes if stats and hasattr(stats, "quota_bytes") else FREE_TIER_BYTES) / (1024**3)
    cap_a = FREE_TIER_CLASS_A
    cap_b = FREE_TIER_CLASS_B
    pct_a = _pct(class_a_used, cap_a)
    pct_b = _pct(class_b_used, cap_b)
    local_objects, local_bytes = local_counts if local_counts else (0, 0)
    local_gib = local_bytes / (1024**3)
    lines = [
        "<b>R2 Status</b>",
        f"Bucket: <code>{html.escape(stats.bucket if stats else '—')}</code>",
        "",
        f"<b>Storage:</b> <code>{stats.bytes_used if stats else 0:,}</code> bytes ({gib_used:.2f} / {gib_quota:.0f} GiB) — <b>{pct:.1f}%</b>",
        f"<b>Class A:</b> <code>{class_a_used:,}</code> / {cap_a:,} — <b>{pct_a:.1f}%</b>",
        f"<b>Class B:</b> <code>{class_b_used:,}</code> / {cap_b:,} — <b>{pct_b:.1f}%</b>",
        f"<b>Local index:</b> {local_objects:,} objects — {local_gib:.2f} GiB",
    ]
    return "\n".join(lines), "HTML"

def _frontdesk_note(db) -> str | None:
    if is_all_paused(db):
        return "ℹ️ Frontdesk CDN: ❌ DISABLED — all media via Telegram."
    if is_origin_paused(db):
        return "ℹ️ Frontdesk CDN: ✅ ENABLED — cached media still served free."
    # Show enabled when R2 is healthy (requirement: note about frontdesk CDN enabled/disabled state)
    # Keep always visible so owner understands CDN is active by default
    return "ℹ️ Frontdesk CDN: ✅ ENABLED — cached media still served free."

def format_r2_status_text_with_flags(db, stats, class_a_used: int, class_b_used: int, local_counts) -> tuple[str, str]:
    text, mode = format_r2_status_text(stats, class_a_used, class_b_used, local_counts)
    flags = []
    if is_paused(db, "r2_auto_stopped"):
        reason = get_control(db, "r2_auto_stopped_reason") or ""
        flags.append(f"⛔ AUTO-STOPPED: {html.escape(reason[:120])}" if reason else "⛔ AUTO-STOPPED at 98%")
    else:
        if is_all_paused(db):
            flags.append("⏸ Paused: ALL (origin + CDN)")
        else:
            if is_paused(db, "r2_pause_writes"):
                flags.append("⏸ Writes paused")
            if is_origin_paused(db):
                # Distinguish origin vs legacy read alias
                if is_paused(db, "r2_pause_origin") or is_paused(db, "r2_pause_reads"):
                    flags.append("⏸ R2 Origin paused (CDN still enabled)")
    if flags:
        text += "\n\n" + "\n".join(flags)
    note = _frontdesk_note(db)
    if note:
        text += f"\n\n{note}"
    return text, mode

# ── keyboard ───────────────────────────────────────────────────

def build_r2_keyboard(db) -> dict:
    """Return Telegram Bot API reply_markup dict.

    Rows:
      Row1: [Pause Writes] [Block R2 Origin]  => r2_pause_writes / r2_pause_origin
      Row2: [Block Entire R2] [Resume All]    => r2_pause_all / r2_resume_all
      Row3: [Refresh Stats]                   => r2_refresh
      (+ Clear Auto-Stop row when auto-stopped)
    """
    auto = is_paused(db, "r2_auto_stopped")
    writes_paused = is_paused(db, "r2_pause_writes") or is_paused(db, "r2_pause_all")
    origin_paused = is_origin_paused(db)
    all_paused = is_all_paused(db)

    # Toggle labels for writes
    if writes_paused and not auto:
        w_label = "▶️ Resume Writes"
        w_data = "r2_unpause_writes"
    else:
        w_label = "⏸ Pause Writes"
        w_data = "r2_pause_writes"

    # Toggle for origin
    if origin_paused and not all_paused:
        o_label = "▶️ Resume Origin"
        o_data = "r2_unpause_origin"
    elif all_paused:
        # Origin is implicitly paused via ALL; show resume origin as part of resume all flow
        o_label = "▶️ Resume Origin"
        o_data = "r2_unpause_origin"
        # If all paused, origin resume should clear both origin and all? we map it to unpause_origin which clears both
        if auto:
            o_label = "⏸ Block R2 Origin"
            o_data = "r2_pause_origin"
    else:
        o_label = "⏸ Block R2 Origin"
        o_data = "r2_pause_origin"

    rows = [
        [{"text": w_label, "callback_data": w_data}, {"text": o_label, "callback_data": o_data}],
        [{"text": "🛑 Block Entire R2", "callback_data": "r2_pause_all"}, {"text": "▶️ Resume All", "callback_data": "r2_resume_all"}],
        [{"text": "📊 Refresh Stats", "callback_data": "r2_refresh"}],
    ]
    if auto:
        rows.append([{"text": "✅ Clear Auto-Stop", "callback_data": "r2_clear_auto_stop"}])
    return {"inline_keyboard": rows}

# ── callback handler ───────────────────────────────────────────

# Map legacy r2_pause_reads alias -> r2_pause_origin
_LEGACY_READ_TO_ORIGIN = {"r2_pause_reads": "r2_pause_origin", "r2_unpause_reads": "r2_unpause_origin"}

def _normalize_action(data: str) -> str:
    return _LEGACY_READ_TO_ORIGIN.get(data, data)

def handle_r2_callback(data: str, sender_id: int, db) -> tuple[str, bool]:
    """Process callback data. Returns (action_taken_description, should_refresh). Validates owner."""
    try:
        owner = int(os.getenv("TELEGRAM_OWNER_ID", "0") or 0)
    except Exception:
        owner = 0
    if owner and int(sender_id) != owner:
        return "unauthorized", False
    _ensure_controls_table(db)
    # Normalize legacy alias
    orig_data = data
    data = _normalize_action(data)
    if data == "r2_pause_writes":
        set_control(db, "r2_pause_writes", "1")
        return "Writes paused", True
    if data == "r2_unpause_writes":
        delete_control(db, "r2_pause_writes")
        if is_paused(db, "r2_pause_all"):
            delete_control(db, "r2_pause_all")
        return "Writes resumed", True
    if data == "r2_pause_origin":
        # Block origin only — keep r2_pause_all untouched
        set_control(db, "r2_pause_origin", "1")
        # Clear legacy alias if present
        delete_control(db, "r2_pause_reads")
        return "R2 Origin blocked (CDN enabled)", True
    if data == "r2_unpause_origin":
        delete_control(db, "r2_pause_origin")
        delete_control(db, "r2_pause_reads")
        # If entire was blocked, unpausing origin also clears entire (owner intent to unblock at least origin)
        if is_paused(db, "r2_pause_all"):
            delete_control(db, "r2_pause_all")
        return "R2 Origin resumed", True
    # Legacy direct handlers (kept for admin panel POST compat)
    if orig_data == "r2_pause_reads":
        set_control(db, "r2_pause_origin", "1")
        return "R2 Origin blocked (CDN enabled)", True
    if orig_data == "r2_unpause_reads":
        delete_control(db, "r2_pause_origin")
        delete_control(db, "r2_pause_reads")
        if is_paused(db, "r2_pause_all"):
            delete_control(db, "r2_pause_all")
        return "Reads resumed", True
    if data == "r2_pause_all":
        set_control(db, "r2_pause_all", "1")
        return "Entire R2 blocked", True
    if data == "r2_resume_all":
        delete_control(db, "r2_pause_all")
        delete_control(db, "r2_pause_writes")
        delete_control(db, "r2_pause_origin")
        delete_control(db, "r2_pause_reads")
        return "All resumed", True
    if data == "r2_refresh":
        return "Refreshed", True
    if data == "r2_clear_auto_stop":
        delete_control(db, "r2_auto_stopped")
        delete_control(db, "r2_auto_stopped_reason")
        try:
            from server.r2_store import clear_auto_stop as _clear
            _clear(db)
        except Exception:
            pass
        return "Auto-stop cleared", True
    return "unknown", False
