#!/usr/bin/env python3
"""
Export a Telegram public channel archive for the local reader.

The exporter writes a folder with:
    manifest.json
    messages.jsonl
    media/              (optional, when --download-media is enabled)

Example:
    python telegram_extract_media_quotes.py
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import mimetypes
import os
import re
import shutil
import sys
import textwrap
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LAST_RUN_CONFIG_FILE = Path(".telegram_export_lastrun.json")

from telethon import TelegramClient
from telethon.crypto import aes as telethon_aes
from telethon.errors import FloodWaitError
from telethon.tl import types


ARCHIVE_VERSION = 1
LIVE_PROGRESS_VISIBLE_LENGTH = 0
USE_COLOR = sys.stderr.isatty() and os.getenv("TERM", "").lower() != "dumb"
PANEL_PADDING = 2


def disable_broken_cryptg() -> None:
    cryptg_module = getattr(telethon_aes, "cryptg", None)
    if cryptg_module and (
        not hasattr(cryptg_module, "encrypt_ige")
        or not hasattr(cryptg_module, "decrypt_ige")
    ):
        telethon_aes.cryptg = None
        print(
            "Warning: installed cryptg is incomplete or incompatible. "
            "Falling back to Telethon's slower built-in AES implementation.",
            file=sys.stderr,
        )


disable_broken_cryptg()


def colorize(text: str, tone: str = "info", *, bold: bool = False) -> str:
    if not USE_COLOR:
        return text

    color_codes = {
        "accent": "38;5;111",
        "error": "38;5;210",
        "info": "38;5;153",
        "muted": "38;5;250",
        "ok": "38;5;151",
        "warn": "38;5;223",
    }
    parts = []
    if bold:
        parts.append("1")
    parts.append(color_codes.get(tone, color_codes["info"]))
    return f"\033[{';'.join(parts)}m{text}\033[0m"


def visible_len(text: str) -> int:
    return len(text)


def finish_live_progress() -> None:
    global LIVE_PROGRESS_VISIBLE_LENGTH
    if sys.stderr.isatty() and LIVE_PROGRESS_VISIBLE_LENGTH:
        print(file=sys.stderr, flush=True)
        LIVE_PROGRESS_VISIBLE_LENGTH = 0


def print_line(message: str, tone: str = "info") -> None:
    finish_live_progress()
    print(colorize(message, tone), file=sys.stderr, flush=True)


def terminal_width() -> int:
    return min(shutil.get_terminal_size((100, 20)).columns, 120)


def print_panel(title: str, lines: list[str], tone: str = "info") -> None:
    finish_live_progress()
    width_limit = max(50, terminal_width())
    content_width = width_limit - (PANEL_PADDING * 2) - 4
    wrapped_lines: list[str] = []
    for line in lines:
        wrapped = textwrap.wrap(line, width=content_width) or [""]
        wrapped_lines.extend(wrapped)

    panel_width = min(
        width_limit,
        max([len(title)] + [len(line) for line in wrapped_lines] + [24]) + (PANEL_PADDING * 2) + 4,
    )
    inner_width = panel_width - 4
    content_inner_width = inner_width - (PANEL_PADDING * 2)
    border = "╭" + "─" * (panel_width - 2) + "╮"
    divider = "├" + "─" * (panel_width - 2) + "┤"
    footer = "╰" + "─" * (panel_width - 2) + "╯"
    title_line = f"│ {' ' * PANEL_PADDING}{title.ljust(content_inner_width)}{' ' * PANEL_PADDING} │"
    blank_line = f"│ {' ' * inner_width} │"

    print(colorize(border, tone, bold=True), file=sys.stderr)
    print(colorize(title_line, tone, bold=True), file=sys.stderr)
    print(colorize(divider, tone), file=sys.stderr)
    print(colorize(blank_line, tone), file=sys.stderr)
    for line in wrapped_lines:
        print(
            colorize(
                f"│ {' ' * PANEL_PADDING}{line.ljust(content_inner_width)}{' ' * PANEL_PADDING} │",
                tone,
            ),
            file=sys.stderr,
        )
    print(colorize(blank_line, tone), file=sys.stderr)
    print(colorize(footer, tone, bold=True), file=sys.stderr, flush=True)


def make_progress_bar(message_count: int, total_count: int | None, width: int = 18) -> str:
    if not total_count or total_count <= 0:
        return "░" * width
    fraction = max(0.0, min(1.0, message_count / total_count))
    filled = int(round(fraction * width))
    return ("█" * filled) + ("░" * (width - filled))


def print_live_progress(message: str, tone: str = "info") -> None:
    global LIVE_PROGRESS_VISIBLE_LENGTH
    if not sys.stderr.isatty():
        print(colorize(message, tone), file=sys.stderr, flush=True)
        return

    padding = max(0, LIVE_PROGRESS_VISIBLE_LENGTH - visible_len(message))
    print(
        "\r" + colorize(message, tone) + (" " * padding),
        end="",
        file=sys.stderr,
        flush=True,
    )
    LIVE_PROGRESS_VISIBLE_LENGTH = visible_len(message)


def format_duration(total_seconds: float) -> str:
    seconds = max(0, int(total_seconds))
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def discover_existing_sessions(preferred: str | None = None) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    for path in sorted(Path.cwd().glob("*.session")):
        candidate = path.name
        if candidate not in seen:
            candidates.append(candidate)
            seen.add(candidate)

    if preferred:
        preferred_path = Path(preferred)
        candidate = preferred if preferred_path.is_absolute() else preferred_path.name
        if Path(preferred).exists() and candidate not in seen:
            candidates.insert(0, preferred)
            seen.add(candidate)

    return candidates


def prompt_session_path(default_session: str) -> str:
    existing_sessions = discover_existing_sessions(default_session)
    if not existing_sessions:
        return prompt_text(
            "Session file name or path",
            default_session,
            required=True,
        )

    lines = ["Existing session files found:"]
    lines.extend(
        [f"{index}. use existing session: {name}" for index, name in enumerate(existing_sessions, start=1)]
    )
    lines.append("new. create or use a different session file")
    print_panel("Session Selection", lines, tone="ok")

    default_choice = "1"
    while True:
        choice = prompt_text(
            "Choose a session number or type new",
            default_choice,
            required=True,
        ).lower()
        if choice.isdigit():
            index = int(choice)
            if 1 <= index <= len(existing_sessions):
                return existing_sessions[index - 1]
        if choice in {"n", "new"}:
            return prompt_text(
                "New session file name or path",
                default_session,
                required=True,
            )
        print_line("Please enter a valid session number or 'new'.", tone="warn")


def prompt_parallelism(default: int = 2) -> int:
    while True:
        value = prompt_int(
            "Parallel download workers (safe range 1-4)",
            default,
        )
        if value is None:
            return default
        if 1 <= value <= 8:
            return value
        print_line("Parallel download workers must be between 1 and 8.", tone="warn")


def prompt_resume(existing_archive: bool) -> bool:
    default = existing_archive
    label = (
        "Resume from existing archive files in the output folder"
        if existing_archive
        else "Resume mode"
    )
    return prompt_bool(label, default=default)


def read_archive_records(messages_path: Path) -> list[dict[str, Any]]:
    if not messages_path.exists():
        return []

    records: list[dict[str, Any]] = []
    with messages_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                records.append(record)
    return records


def write_archive_records(messages_path: Path, records: list[dict[str, Any]]) -> None:
    with messages_path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_failed_media_queue(queue_path: Path, records: list[dict[str, Any]]) -> None:
    failed_records = [
        {
            "message_id": record.get("message_id"),
            "message_key": record.get("message_key"),
            "chat_id": record.get("chat_id"),
            "date_utc": record.get("date_utc"),
            "media_kind": record.get("media_kind"),
            "media_path": record.get("media_path"),
            "media_download_error": record.get("media_download_error"),
            "external_urls": record.get("external_urls"),
            "permalink": record.get("permalink"),
        }
        for record in records
        if record.get("media_download_error")
    ]

    with queue_path.open("w", encoding="utf-8") as handle:
        for record in failed_records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_failed_media_links(links_path: Path, records: list[dict[str, Any]]) -> None:
    links: list[str] = []
    seen: set[str] = set()
    for record in records:
        if not record.get("media_download_error"):
            continue
        permalink = record.get("permalink")
        if isinstance(permalink, str) and permalink and permalink not in seen:
            links.append(permalink)
            seen.add(permalink)

    with links_path.open("w", encoding="utf-8") as handle:
        for link in links:
            handle.write(link + "\n")


def read_failed_media_queue(queue_path: Path) -> list[dict[str, Any]]:
    if not queue_path.exists():
        return []

    records: list[dict[str, Any]] = []
    with queue_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                records.append(record)
    return records


def compute_archive_counts(records: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "messages": len(records),
        "media_downloaded": sum(1 for record in records if record.get("media_path")),
        "media_download_failures": sum(
            1 for record in records if record.get("media_download_error")
        ),
    }


def sort_archive_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        records,
        key=lambda record: (
            record.get("message_id") if isinstance(record.get("message_id"), int) else float("inf"),
            record.get("date_utc") or "",
        ),
    )


def compute_archive_range(records: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sort_archive_records(records)
    if not ordered:
        return {
            "first_message_id": None,
            "first_message_date_utc": None,
            "last_message_id": None,
            "last_message_date_utc": None,
        }

    first = ordered[0]
    last = ordered[-1]
    return {
        "first_message_id": first.get("message_id"),
        "first_message_date_utc": first.get("date_utc"),
        "last_message_id": last.get("message_id"),
        "last_message_date_utc": last.get("date_utc"),
    }


def build_local_archive_audit(records: list[dict[str, Any]]) -> dict[str, Any]:
    message_ids = [
        record["message_id"]
        for record in records
        if isinstance(record.get("message_id"), int)
    ]
    unique_ids = set(message_ids)
    duplicate_count = len(message_ids) - len(unique_ids)
    ordered_ids = [record.get("message_id") for record in records if isinstance(record.get("message_id"), int)]
    out_of_order_transitions = sum(
        1
        for previous, current in zip(ordered_ids, ordered_ids[1:])
        if current < previous
    )
    reply_parent_missing = sum(
        1
        for record in records
        if isinstance(record.get("reply_to_msg_id"), int)
        and record["reply_to_msg_id"] not in unique_ids
    )
    reply_top_missing = sum(
        1
        for record in records
        if isinstance(record.get("reply_to_top_id"), int)
        and record["reply_to_top_id"] not in unique_ids
    )
    quote_without_parent = sum(
        1
        for record in records
        if record.get("is_quote_reply")
        and not isinstance(record.get("reply_to_msg_id"), int)
    )
    external_url_count = sum(1 for record in records if record.get("external_urls"))
    webpage_count = sum(1 for record in records if record.get("media_kind") == "webpage")
    counts = compute_archive_counts(records)
    return {
        "messages_total": len(records),
        "message_ids_unique": len(unique_ids),
        "duplicate_message_ids": duplicate_count,
        "range": compute_archive_range(records),
        "file_order_out_of_order_transitions": out_of_order_transitions,
        "reply_parent_missing": reply_parent_missing,
        "reply_top_missing": reply_top_missing,
        "quote_without_parent": quote_without_parent,
        "webpage_records": webpage_count,
        "records_with_external_urls": external_url_count,
        "media_downloaded": counts["media_downloaded"],
        "media_download_failures": counts["media_download_failures"],
    }


def update_manifest_from_records(
    manifest_path: Path,
    records: list[dict[str, Any]],
    *,
    exported_at: datetime | None = None,
    extra_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest: dict[str, Any] = {}
    if manifest_path.exists():
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                manifest = loaded
        except (json.JSONDecodeError, OSError):
            manifest = {}

    counts = compute_archive_counts(records)
    manifest.setdefault("counts", {})
    manifest.setdefault("files", {})
    manifest["files"].setdefault("messages", "messages.jsonl")
    manifest["files"]["failed_media"] = "failed_media.jsonl"
    manifest["files"]["failed_media_links"] = "failed_media_links.txt"
    manifest["counts"]["messages"] = counts["messages"]
    manifest["counts"]["media_downloaded"] = counts["media_downloaded"]
    manifest["counts"]["media_download_failures"] = counts["media_download_failures"]
    manifest["range"] = compute_archive_range(records)
    manifest["exported_at_utc"] = isoformat_utc(exported_at or datetime.now(timezone.utc))
    if extra_fields:
        manifest.update(extra_fields)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def prompt_text(
    label: str,
    default: str | None = None,
    *,
    required: bool = False,
    secret: bool = False,
) -> str:
    while True:
        if default in (None, ""):
            suffix = ""
        elif secret:
            suffix = " [saved]"
        else:
            suffix = f" [{default}]"
        prompt = colorize(f"{label}{suffix}: ", "accent", bold=True)
        value = getpass.getpass(prompt) if secret else input(prompt)
        if value.strip():
            return value.strip()
        if default not in (None, ""):
            return default
        if not required:
            return ""
        print_line(f"{label} is required.", tone="warn")


def prompt_int(label: str, default: int | None = None) -> int | None:
    while True:
        raw = prompt_text(label, str(default) if default is not None else None, required=False)
        if raw == "":
            return default
        try:
            return int(raw)
        except ValueError:
            print_line(f"{label} must be a number.", tone="warn")


def prompt_bool(label: str, default: bool = False) -> bool:
    default_label = "y" if default else "n"
    while True:
        raw = input(colorize(f"{label} [y/n] [{default_label}]: ", "accent", bold=True)).strip().lower()
        if not raw:
            return default
        if raw in {"y", "yes"}:
            return True
        if raw in {"n", "no"}:
            return False
        print_line("Please enter y or n.", tone="warn")


def save_last_run_config(args: argparse.Namespace) -> None:
    """Persist the current run settings so they can be re-used with --last-run."""
    config = {
        "api_id": args.api_id,
        "api_hash": args.api_hash,
        "session": args.session,
        "chat": args.chat,
        "output_dir": args.output_dir,
        "download_media": args.download_media,
        "include_raw": args.include_raw,
        "resume": args.resume,
        "limit": args.limit,
        "parallelism": args.parallelism,
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        LAST_RUN_CONFIG_FILE.write_text(
            json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass  # Non-critical; silently ignore


def load_last_run_config() -> dict[str, Any] | None:
    """Load the last-run config, or None if it doesn't exist."""
    if not LAST_RUN_CONFIG_FILE.exists():
        return None
    try:
        return json.loads(LAST_RUN_CONFIG_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def apply_last_run_config(args: argparse.Namespace) -> argparse.Namespace:
    """Populate args from the saved last-run config."""
    config = load_last_run_config()
    if config is None:
        raise SystemExit(
            "No previous run found. Run the script interactively first, "
            "then use --last-run to repeat with the same settings."
        )

    print_panel(
        "Last Run Config Loaded",
        [
            f"Chat: {config.get('chat')}",
            f"Session: {config.get('session')}",
            f"Output: {config.get('output_dir')}",
            f"Download media: {config.get('download_media')}",
            f"Include raw: {config.get('include_raw')}",
            f"Parallelism: {config.get('parallelism')}",
            f"Limit: {config.get('limit', 'full history')}",
            f"Saved at: {config.get('saved_at', 'unknown')}",
        ],
        tone="ok",
    )

    args.api_id = config["api_id"]
    args.api_hash = config["api_hash"]
    args.session = config["session"]
    args.chat = config["chat"]
    args.output_dir = config["output_dir"]
    args.download_media = config["download_media"]
    args.include_raw = config["include_raw"]
    args.limit = config.get("limit")
    args.parallelism = config.get("parallelism", 2)

    # Auto-detect resume based on existing archive
    candidate_output_dir = Path(args.output_dir)
    existing_archive = (candidate_output_dir / "messages.jsonl").exists()
    if existing_archive:
        args.resume = True
        print_line("Existing archive detected — auto-enabling resume mode.", tone="info")
    else:
        args.resume = False

    return args


def configure_args_interactively(args: argparse.Namespace) -> argparse.Namespace:
    if getattr(args, "repair_archive", False):
        if args.output_dir is None:
            args.output_dir = "telegram_archive"
        return args

    # Handle --last-run shortcut
    if getattr(args, "last_run", False):
        return apply_last_run_config(args)

    if not sys.stdin.isatty():
        missing = [
            name
            for name in ("api_id", "api_hash", "chat")
            if getattr(args, name, None) in (None, "")
        ]
        if missing:
            joined = ", ".join(missing)
            raise SystemExit(
                f"Missing required values in non-interactive mode: {joined}. "
                "Pass them as flags or run the script in a terminal."
            )
        if args.session is None:
            args.session = os.getenv("TG_SESSION", "telegram_user.session")
        if args.output_dir is None:
            args.output_dir = "telegram_archive"
        if args.download_media is None:
            args.download_media = False
        if args.include_raw is None:
            args.include_raw = False
        if getattr(args, "resume", None) is None:
            args.resume = (Path(args.output_dir) / "messages.jsonl").exists()
        if getattr(args, "parallelism", None) is None:
            args.parallelism = 2 if args.download_media else 1
        return args

    saved_config = load_last_run_config() or {}
    env_api_id = os.getenv("TG_API_ID")
    env_api_hash = os.getenv("TG_API_HASH")
    env_session = os.getenv("TG_SESSION")
    candidate_output_dir = Path(args.output_dir) if args.output_dir else Path("telegram_archive")
    existing_archive = (candidate_output_dir / "messages.jsonl").exists()

    saved_api_id = saved_config.get("api_id")
    saved_api_hash = saved_config.get("api_hash")
    saved_session = saved_config.get("session")

    print_panel(
        "Telegram Archive Export Setup",
        [
            "Press Enter to accept the value shown in brackets.",
            "The exporter uses an existing local Telethon session if one is found.",
        ],
        tone="accent",
    )

    if args.api_id is None:
        args.api_id = prompt_int(
            "Telegram API ID",
            (
                int(saved_api_id)
                if saved_api_id not in (None, "") else
                int(env_api_id)
                if env_api_id and env_api_id.isdigit() else None
            ),
        )
    while args.api_id is None:
        print_line("Telegram API ID is required.", tone="warn")
        args.api_id = prompt_int("Telegram API ID")

    if not args.api_hash:
        args.api_hash = prompt_text(
            "Telegram API Hash",
            saved_api_hash or env_api_hash,
            required=True,
            secret=True,
        )

    if not args.session:
        args.session = prompt_session_path(saved_session or env_session or "telegram_user.session")

    if (
        saved_session
        and args.session == saved_session
        and saved_api_id not in (None, "")
        and saved_api_hash not in (None, "")
    ):
        print_line(
            "Using saved API ID/hash from the previous run for this session.",
            tone="muted",
        )

    if not args.chat:
        args.chat = prompt_text(
            "Public channel username, t.me link, or numeric chat id",
            required=True,
        )

    if args.output_dir is None:
        args.output_dir = prompt_text(
            "Output archive folder",
            "telegram_archive",
            required=True,
        )

    if getattr(args, "resume", None) is None:
        existing_archive = (Path(args.output_dir) / "messages.jsonl").exists()
        args.resume = prompt_resume(existing_archive)

    if args.limit is None:
        while True:
            raw_limit = prompt_text(
                "Message limit (leave blank for full history)",
                "",
                required=False,
            )
            if not raw_limit:
                args.limit = None
                break
            try:
                args.limit = int(raw_limit)
                break
            except ValueError:
                print_line("Message limit must be a number.", tone="warn")

    if args.download_media is None:
        args.download_media = prompt_bool("Download media files into media/", default=False)

    if args.include_raw is None:
        print_panel(
            "Raw Data Options",
            [
                "Normal export keeps the fields the reader directly uses:",
                "message id, text, dates, reply/quote fields, media kind/path, views, sender/post author.",
                "Extra raw data additionally stores the large sanitized Telegram objects as raw JSON blobs",
                "for each message (and chat metadata in the manifest). This helps debugging and future analysis,",
                "but makes the archive larger and slower to write.",
            ],
            tone="muted",
        )
        args.include_raw = prompt_bool("Include extra raw Telegram payloads", default=False)

    if getattr(args, "parallelism", None) is None:
        args.parallelism = prompt_parallelism(default=2 if args.download_media else 1)

    return args


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Export a Telegram public channel archive with full history, reply "
            "metadata, quote-reply details, and optional downloaded media."
        )
    )
    parser.add_argument("--api-id", type=int)
    parser.add_argument("--api-hash")
    parser.add_argument(
        "--session",
        default=None,
        help="Telethon session file name or path.",
    )
    parser.add_argument(
        "--chat",
        help="Public channel/chat username, invite link, or numeric entity id.",
    )
    parser.add_argument(
        "--output-dir",
        "--output",
        dest="output_dir",
        default=None,
        help="Destination archive folder. Default: telegram_archive",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Maximum messages to scan. Default: full available history.",
    )
    parser.add_argument(
        "--download-media",
        action="store_true",
        default=None,
        help="Download media files into the archive's media/ directory.",
    )
    parser.add_argument(
        "--include-raw",
        action="store_true",
        default=None,
        help="Include sanitized raw Telethon payloads on each message record.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        default=None,
        help="Resume from an existing archive folder instead of overwriting it.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=100,
        help="Print progress every N exported messages. Default: 100",
    )
    parser.add_argument(
        "--parallelism",
        type=int,
        default=None,
        help="Concurrent message/media worker count. Default: prompted in interactive mode",
    )
    parser.add_argument(
        "--last-run",
        action="store_true",
        default=False,
        help="Re-run with identical settings from the last interactive run (same account, chat, options).",
    )
    parser.add_argument(
        "--retry-failed-media-only",
        action="store_true",
        default=False,
        help="Retry only messages that already have media_download_error in the existing archive.",
    )
    parser.add_argument(
        "--repair-archive",
        action="store_true",
        default=False,
        help="Repair local archive files only: sort messages, refresh manifest/counts, and rebuild failure lists.",
    )
    parser.add_argument(
        "--audit-source-only",
        action="store_true",
        default=False,
        help="Audit the local archive against the Telegram source without downloading media.",
    )
    parser.add_argument(
        "--backfill-urls",
        action="store_true",
        default=False,
        help="Backfill external_urls for existing archive records using Telegram message metadata only.",
    )
    args = parser.parse_args()
    return configure_args_interactively(args)


def isoformat_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def sanitize_for_json(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, datetime):
        return isoformat_utc(value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): sanitize_for_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [sanitize_for_json(item) for item in value]
    if hasattr(value, "to_dict"):
        return sanitize_for_json(value.to_dict())
    return repr(value)


def serialize_tl_object(value: Any) -> Any:
    if value is None:
        return None
    return sanitize_for_json(value)


def media_kind(message: Any) -> str | None:
    media = getattr(message, "media", None)
    if media is None:
        return None
    if isinstance(media, types.MessageMediaPhoto):
        return "photo"
    if isinstance(media, types.MessageMediaDocument):
        document = getattr(media, "document", None)
        if document:
            for attr in getattr(document, "attributes", []):
                if isinstance(attr, types.DocumentAttributeVideo):
                    return "video"
                if isinstance(attr, types.DocumentAttributeAudio):
                    return "audio"
                if isinstance(attr, types.DocumentAttributeAnimated):
                    return "animation"
                if isinstance(attr, types.DocumentAttributeSticker):
                    return "sticker"
        return "document"
    if isinstance(media, types.MessageMediaWebPage):
        return "webpage"
    if isinstance(media, types.MessageMediaContact):
        return "contact"
    if isinstance(media, types.MessageMediaGeo):
        return "geo"
    if isinstance(media, types.MessageMediaGeoLive):
        return "live_geo"
    if isinstance(media, types.MessageMediaVenue):
        return "venue"
    if isinstance(media, types.MessageMediaDice):
        return "dice"
    if isinstance(media, types.MessageMediaGame):
        return "game"
    if isinstance(media, types.MessageMediaInvoice):
        return "invoice"
    if isinstance(media, types.MessageMediaPoll):
        return "poll"
    return type(media).__name__


def infer_media_extension(message: Any) -> str:
    media = getattr(message, "media", None)
    if isinstance(media, types.MessageMediaPhoto):
        return ".jpg"

    document = getattr(media, "document", None)
    if document:
        for attr in getattr(document, "attributes", []):
            file_name = getattr(attr, "file_name", None)
            if file_name:
                suffix = Path(file_name).suffix
                if suffix:
                    return suffix

        mime_type = getattr(document, "mime_type", None)
        if mime_type == "application/x-tgsticker":
            return ".tgs"
        if mime_type == "application/x-tgwallpattern":
            return ".tgv"
        guessed = mimetypes.guess_extension(mime_type or "")
        if guessed:
            return guessed

    return ""


URL_PATTERN = re.compile(r"https?://[^\s]+", re.IGNORECASE)


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def extract_external_urls(message: Any) -> list[str]:
    urls: list[str] = []
    text = getattr(message, "message", None) or ""
    entities = getattr(message, "entities", None) or []

    for entity in entities:
        if isinstance(entity, types.MessageEntityTextUrl):
            url = getattr(entity, "url", None)
            if url:
                urls.append(url)
        elif isinstance(entity, types.MessageEntityUrl):
            offset = getattr(entity, "offset", 0)
            length = getattr(entity, "length", 0)
            if length > 0:
                urls.append(text[offset:offset + length])

    urls.extend(URL_PATTERN.findall(text))

    media = getattr(message, "media", None)
    if isinstance(media, types.MessageMediaWebPage):
        webpage = getattr(media, "webpage", None)
        for attr in ("url", "display_url"):
            value = getattr(webpage, attr, None) if webpage else None
            if value:
                urls.append(value)

    return unique_strings(urls)


def is_downloadable_media(message: Any) -> bool:
    kind = media_kind(message)
    return kind in {"photo", "video", "audio", "animation", "sticker", "document"}


def reply_header_details(reply_to: Any) -> dict[str, Any] | None:
    if not reply_to:
        return None

    quote_text = getattr(reply_to, "quote_text", None)
    details: dict[str, Any] = {
        "header_type": type(reply_to).__name__,
        "reply_to_msg_id": getattr(reply_to, "reply_to_msg_id", None),
        "reply_to_peer_id": serialize_tl_object(getattr(reply_to, "reply_to_peer_id", None)),
        "reply_to_top_id": getattr(reply_to, "reply_to_top_id", None),
        "forum_topic": getattr(reply_to, "forum_topic", None),
        "quote_text": quote_text,
        "quote_text_length": len(quote_text or ""),
        "quote_offset_utf16": getattr(reply_to, "quote_offset", None),
        "quote_entities": serialize_tl_object(getattr(reply_to, "quote_entities", None) or []),
        "monoforum_peer_id": serialize_tl_object(getattr(reply_to, "monoforum_peer_id", None)),
        "todo_item_id": getattr(reply_to, "todo_item_id", None),
    }
    details["is_reply"] = details["reply_to_msg_id"] is not None
    details["is_quote_reply"] = bool(quote_text)
    return details


def message_permalink(entity: Any, message_id: int | None) -> str | None:
    username = getattr(entity, "username", None)
    if username and message_id:
        return f"https://t.me/{username}/{message_id}"
    return None


async def maybe_download_media(
    message: Any,
    media_dir: Path | None,
    *,
    max_retries: int = 3,
) -> tuple[str | None, str | None]:
    if media_dir is None or getattr(message, "media", None) is None:
        return None, None

    kind = media_kind(message) or "media"
    extension = infer_media_extension(message)
    file_name = f"{message.id}_{kind}{extension}"
    target_path = media_dir / file_name

    if target_path.exists():
        if target_path.stat().st_size > 0:
            return str(Path("media") / target_path.name), None
        else:
            target_path.unlink()  # Remove empty partial file

    attempts = 0
    while True:
        try:
            media_dir.mkdir(parents=True, exist_ok=True)
            # Remove any partial file from a previous timed-out attempt in this loop
            # so Telethon doesn't append (1), (2), etc.
            if target_path.exists():
                target_path.unlink()

            path = await asyncio.wait_for(
                message.download_media(file=str(target_path)),
                timeout=60  # 60s timeout — fail fast on stuck downloads
            )
            if not path:
                return None, "download_returned_none"
            resolved = Path(path)
            return str(Path("media") / resolved.name), None
        except FloodWaitError as exc:
            attempts += 1
            wait_seconds = int(getattr(exc, "seconds", 0) or 0)
            if attempts > max_retries:
                return None, f"FloodWaitError({wait_seconds}s)"
            await asyncio.sleep(max(wait_seconds, 1))
        except asyncio.TimeoutError:
            attempts += 1
            if attempts > max_retries:
                return None, "TimeoutError"
            await asyncio.sleep(min(2 ** attempts, 10))
        except Exception as exc:  # noqa: BLE001
            return None, f"{type(exc).__name__}: {str(exc)}"


def build_archive_message(
    entity: Any,
    message: Any,
    chat_id: int | None,
    media_path: str | None,
    media_error: str | None,
    include_raw: bool,
) -> dict[str, Any]:
    reply = reply_header_details(getattr(message, "reply_to", None))
    kind = media_kind(message)
    text = getattr(message, "message", None) or ""
    external_urls = extract_external_urls(message)

    record = {
        "archive_version": ARCHIVE_VERSION,
        "chat_id": chat_id,
        "chat_username": getattr(entity, "username", None),
        "chat_title": getattr(entity, "title", None),
        "chat_type": type(entity).__name__,
        "message_key": f"{chat_id}:{message.id}" if chat_id is not None else str(message.id),
        "message_id": message.id,
        "message_type": type(message).__name__,
        "date_utc": isoformat_utc(getattr(message, "date", None)),
        "edit_date_utc": isoformat_utc(getattr(message, "edit_date", None)),
        "text": text,
        "text_length": len(text),
        "post_author": getattr(message, "post_author", None),
        "sender_id": getattr(message, "sender_id", None),
        "from_id": serialize_tl_object(getattr(message, "from_id", None)),
        "grouped_id": getattr(message, "grouped_id", None),
        "views": getattr(message, "views", None),
        "forwards": getattr(message, "forwards", None),
        "permalink": message_permalink(entity, getattr(message, "id", None)),
        "media_kind": kind,
        "media_present": kind is not None,
        "media_path": media_path,
        "media_download_error": media_error,
        "external_urls": external_urls,
        "media_raw": serialize_tl_object(getattr(message, "media", None)),
        "reply_parent_id": reply["reply_to_msg_id"] if reply else None,
        "reply_to_msg_id": reply["reply_to_msg_id"] if reply else None,
        "reply_to_top_id": reply["reply_to_top_id"] if reply else None,
        "reply_to_peer_id": reply["reply_to_peer_id"] if reply else None,
        "is_reply": reply["is_reply"] if reply else False,
        "is_quote_reply": reply["is_quote_reply"] if reply else False,
        "quote_text": reply["quote_text"] if reply else None,
        "quote_text_length": reply["quote_text_length"] if reply else 0,
        "quote_offset_utf16": reply["quote_offset_utf16"] if reply else None,
        "quote_entities": reply["quote_entities"] if reply else [],
        "reply_header": reply,
        "reply_counts": {
            "replies": (
                getattr(message.replies, "replies", None)
                if getattr(message, "replies", None)
                else None
            ),
            "channel_id": (
                getattr(message.replies, "channel_id", None)
                if getattr(message, "replies", None)
                else None
            ),
            "recent_repliers": (
                serialize_tl_object(getattr(message.replies, "recent_repliers", None))
                if getattr(message, "replies", None)
                else None
            ),
        },
    }

    if include_raw:
        record["raw"] = serialize_tl_object(message)

    return record


async def process_message_for_export(
    entity: Any,
    message: Any,
    chat_id: int | None,
    media_dir: Path | None,
    include_raw: bool,
    media_semaphore: asyncio.Semaphore,
) -> tuple[dict[str, Any], str | None, str | None]:
    media_path = None
    media_error = None

    if media_dir is not None and is_downloadable_media(message):
        async with media_semaphore:
            media_path, media_error = await maybe_download_media(message, media_dir)

    record = build_archive_message(
        entity=entity,
        message=message,
        chat_id=chat_id,
        media_path=media_path,
        media_error=media_error,
        include_raw=include_raw,
    )
    return record, media_path, media_error


def format_progress(message_count: int, total_count: int | None) -> str:
    if total_count and total_count > 0:
        percent = (message_count / total_count) * 100
        return f"{message_count}/{total_count} ({percent:.1f}%)"
    return str(message_count)


def build_progress_status(
    *,
    message_count: int,
    total_count: int | None,
    last_message_id: int | None,
    media_downloaded: int,
    media_failed: int,
    active_workers: int,
    rate: float,
    elapsed: float,
) -> str:
    eta_text = "--:--"
    if total_count and rate > 0 and message_count <= total_count:
        remaining = max(0, total_count - message_count)
        eta_text = format_duration(remaining / rate)

    bar = make_progress_bar(message_count, total_count, width=20)

    return (
        f"  {bar}  "
        f"{format_progress(message_count, total_count)}"
        f"  |  last #{last_message_id}"
        f"  |  workers {active_workers}"
        f"  |  media {media_downloaded}/{media_failed}"
        f"  |  {rate:.1f} msg/s"
        f"  |  {format_duration(elapsed)}"
        f"  |  eta {eta_text}"
    )


def load_existing_archive_state(messages_path: Path) -> dict[str, Any]:
    if not messages_path.exists():
        return {
            "existing_count": 0,
            "existing_ids": set(),
            "first_message_id": None,
            "first_message_date": None,
            "last_message_id": None,
            "last_message_date": None,
            "existing_media_downloaded": 0,
            "existing_media_failed": 0,
        }

    # Optimized for 5k messages - use a pre-sized set for better performance
    existing_ids: set[int] = set()
    first_message_id: int | None = None
    first_message_date: str | None = None
    last_message_id: int | None = None
    last_message_date: str | None = None
    existing_media_downloaded = 0
    existing_media_failed = 0
    existing_count = 0

    # Pre-allocate set capacity for expected size (5k messages)
    if messages_path.stat().st_size > 1000000:  # >1MB file
        existing_ids = set()  # Let it grow dynamically for larger files
    else:
        existing_ids = set()  # Default set is fine for smaller files

    with messages_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            message_id = record.get("message_id")
            if not isinstance(message_id, int):
                continue

            existing_ids.add(message_id)
            existing_count += 1
            if first_message_id is None:
                first_message_id = message_id
                first_message_date = record.get("date_utc")
            last_message_id = message_id
            last_message_date = record.get("date_utc")

            if record.get("media_path"):
                existing_media_downloaded += 1
            if record.get("media_download_error"):
                existing_media_failed += 1

    return {
        "existing_count": existing_count,
        "existing_ids": existing_ids,
        "first_message_id": first_message_id,
        "first_message_date": first_message_date,
        "last_message_id": last_message_id,
        "last_message_date": last_message_date,
        "existing_media_downloaded": existing_media_downloaded,
        "existing_media_failed": existing_media_failed,
    }


def repair_archive(output_dir: Path) -> dict[str, Any]:
    messages_path = output_dir / "messages.jsonl"
    manifest_path = output_dir / "manifest.json"
    failed_media_path = output_dir / "failed_media.jsonl"
    failed_links_path = output_dir / "failed_media_links.txt"
    audit_path = output_dir / "archive_audit.json"

    if not messages_path.exists():
        raise SystemExit(f"No archive found at {messages_path}.")

    records = read_archive_records(messages_path)
    repaired_records = sort_archive_records(records)
    write_archive_records(messages_path, repaired_records)
    write_failed_media_queue(failed_media_path, repaired_records)
    write_failed_media_links(failed_links_path, repaired_records)
    update_manifest_from_records(
        manifest_path,
        repaired_records,
        extra_fields={
            "repair_archive_last_run": {
                "repaired_at_utc": isoformat_utc(datetime.now(timezone.utc)),
            }
        },
    )
    audit = build_local_archive_audit(repaired_records)
    audit_payload = {
        "ok": True,
        "mode": "repair_archive",
        "generated_at_utc": isoformat_utc(datetime.now(timezone.utc)),
        "output_dir": str(output_dir.resolve()),
        "messages_file": str(messages_path.resolve()),
        "manifest_file": str(manifest_path.resolve()),
        "failed_media_file": str(failed_media_path.resolve()),
        "failed_media_links_file": str(failed_links_path.resolve()),
        "local_archive": audit,
    }
    audit_path.write_text(json.dumps(audit_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return audit_payload


async def audit_source_only(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    messages_path = output_dir / "messages.jsonl"
    manifest_path = output_dir / "manifest.json"
    audit_path = output_dir / "archive_audit.json"

    if not messages_path.exists():
        raise SystemExit(f"No archive found at {messages_path}.")

    records = read_archive_records(messages_path)
    local_audit = build_local_archive_audit(records)
    archive_ids = {
        record["message_id"]
        for record in records
        if isinstance(record.get("message_id"), int)
    }

    print_panel(
        "Source Audit",
        [
            f"Archive: {output_dir}",
            f"Local messages: {len(records)}",
            "This mode reads Telegram message metadata only.",
            "It does not download media files.",
        ],
        tone="info",
    )

    async with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        client.flood_sleep_threshold = 30
        entity = await client.get_entity(args.chat)
        history_probe = await client.get_messages(entity, limit=1)
        latest_message_id = history_probe[0].id if history_probe else None
        available_total_messages = getattr(history_probe, "total", None)

        source_ids: set[int] = set()
        scanned = 0
        started_at = time.monotonic()
        last_progress_at = started_at

        async for message in client.iter_messages(entity, limit=args.limit, wait_time=0):
            message_id = getattr(message, "id", None)
            if not isinstance(message_id, int):
                continue
            source_ids.add(message_id)
            scanned += 1

            now = time.monotonic()
            if now - last_progress_at >= 0.5:
                elapsed = now - started_at
                rate = scanned / elapsed if elapsed > 0 else 0
                bar = make_progress_bar(scanned, available_total_messages, width=20)
                print_live_progress(
                    f"  {bar}  scanned {format_progress(scanned, available_total_messages)}"
                    f"  |  {rate:.0f} msg/s"
                    f"  |  {format_duration(elapsed)}",
                    tone="ok",
                )
                last_progress_at = now

    finish_live_progress()

    missing_from_archive = sorted(source_ids - archive_ids)
    extra_in_archive = sorted(archive_ids - source_ids)
    local_reply_parent_missing = sorted(
        {
            record["reply_to_msg_id"]
            for record in records
            if isinstance(record.get("reply_to_msg_id"), int)
            and record["reply_to_msg_id"] not in source_ids
        }
    )
    local_reply_top_missing = sorted(
        {
            record["reply_to_top_id"]
            for record in records
            if isinstance(record.get("reply_to_top_id"), int)
            and record["reply_to_top_id"] not in source_ids
        }
    )

    source_audit = {
        "chat_id": getattr(entity, "id", None),
        "chat_title": getattr(entity, "title", None),
        "chat_username": getattr(entity, "username", None),
        "available_total_messages": available_total_messages,
        "latest_message_id": latest_message_id,
        "scanned_message_count": len(source_ids),
        "missing_from_archive_count": len(missing_from_archive),
        "missing_from_archive_sample": missing_from_archive[:50],
        "extra_in_archive_count": len(extra_in_archive),
        "extra_in_archive_sample": extra_in_archive[:50],
        "local_reply_parent_missing_in_source_count": len(local_reply_parent_missing),
        "local_reply_parent_missing_in_source_sample": local_reply_parent_missing[:50],
        "local_reply_top_missing_in_source_count": len(local_reply_top_missing),
        "local_reply_top_missing_in_source_sample": local_reply_top_missing[:50],
    }

    payload = {
        "ok": True,
        "mode": "audit_source_only",
        "generated_at_utc": isoformat_utc(datetime.now(timezone.utc)),
        "output_dir": str(output_dir.resolve()),
        "messages_file": str(messages_path.resolve()),
        "manifest_file": str(manifest_path.resolve()),
        "local_archive": local_audit,
        "source_audit": source_audit,
    }
    audit_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    update_manifest_from_records(
        manifest_path,
        records,
        extra_fields={
            "source_audit_last_run": {
                "audited_at_utc": payload["generated_at_utc"],
                "missing_from_archive_count": len(missing_from_archive),
                "extra_in_archive_count": len(extra_in_archive),
            }
        },
    )

    print_panel(
        "Audit Complete",
        [
            f"Local messages: {local_audit['messages_total']}",
            f"Source messages scanned: {len(source_ids)}",
            f"Missing from archive: {len(missing_from_archive)}",
            f"Extra in archive: {len(extra_in_archive)}",
            f"Manifest last message id: {local_audit['range']['last_message_id']}",
            f"Reply parent gaps in local archive: {local_audit['reply_parent_missing']}",
            f"Audit report: {audit_path.name}",
        ],
        tone="ok" if not missing_from_archive and not extra_in_archive else "warn",
    )
    print(json.dumps(payload, ensure_ascii=True))


async def backfill_urls(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    messages_path = output_dir / "messages.jsonl"
    manifest_path = output_dir / "manifest.json"
    failed_media_path = output_dir / "failed_media.jsonl"
    failed_links_path = output_dir / "failed_media_links.txt"
    audit_path = output_dir / "archive_audit.json"

    if not messages_path.exists():
        raise SystemExit(f"No archive found at {messages_path}.")

    records = sort_archive_records(read_archive_records(messages_path))
    message_index_by_id = {
        record.get("message_id"): index
        for index, record in enumerate(records)
        if isinstance(record.get("message_id"), int)
    }

    candidate_ids = [
        record["message_id"]
        for record in records
        if isinstance(record.get("message_id"), int)
        and (
            record.get("media_kind") == "webpage"
            or not record.get("external_urls")
        )
    ]

    if not candidate_ids:
        print_panel(
            "URL Backfill",
            ["No records need URL backfill."],
            tone="ok",
        )
        print(
            json.dumps(
                {
                    "ok": True,
                    "mode": "backfill_urls",
                    "scanned": 0,
                    "updated": 0,
                    "messages_file": str(messages_path.resolve()),
                },
                ensure_ascii=True,
            )
        )
        return

    print_panel(
        "URL Backfill",
        [
            f"Archive: {output_dir}",
            f"Candidate messages: {len(candidate_ids)}",
            "This mode reads Telegram message metadata only.",
            "It does not download media files.",
        ],
        tone="info",
    )

    updated = 0
    scanned = 0
    started_at = time.monotonic()
    last_progress_at = started_at

    async with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        client.flood_sleep_threshold = 30
        entity = await client.get_entity(args.chat)

        for batch_start in range(0, len(candidate_ids), 100):
            batch_ids = candidate_ids[batch_start:batch_start + 100]
            try:
                batch_messages = await client.get_messages(entity, ids=batch_ids)
            except FloodWaitError as exc:
                wait_seconds = int(getattr(exc, "seconds", 0) or 0)
                print_line(
                    f"Flood-wait {wait_seconds}s during URL backfill. Sleeping and resuming.",
                    tone="warn",
                )
                await asyncio.sleep(max(wait_seconds, 1))
                batch_messages = await client.get_messages(entity, ids=batch_ids)

            message_by_id = {
                getattr(message, "id", None): message
                for message in batch_messages
                if message and isinstance(getattr(message, "id", None), int)
            }

            for message_id in batch_ids:
                scanned += 1
                message = message_by_id.get(message_id)
                if message is None:
                    continue

                index = message_index_by_id.get(message_id)
                if index is None:
                    continue

                record = records[index]
                new_urls = extract_external_urls(message)
                old_urls = unique_strings(list(record.get("external_urls") or []))
                merged_urls = unique_strings(old_urls + new_urls)
                if merged_urls != old_urls:
                    record["external_urls"] = merged_urls
                    updated += 1

                now = time.monotonic()
                if now - last_progress_at >= 0.5:
                    elapsed = now - started_at
                    rate = scanned / elapsed if elapsed > 0 else 0
                    bar = make_progress_bar(scanned, len(candidate_ids), width=20)
                    print_live_progress(
                        f"  {bar}  scanned {scanned}/{len(candidate_ids)}"
                        f"  |  updated {updated}"
                        f"  |  {rate:.0f} msg/s"
                        f"  |  {format_duration(elapsed)}",
                        tone="ok",
                    )
                    last_progress_at = now

    finish_live_progress()
    records = sort_archive_records(records)
    write_archive_records(messages_path, records)
    write_failed_media_queue(failed_media_path, records)
    write_failed_media_links(failed_links_path, records)
    update_manifest_from_records(
        manifest_path,
        records,
        extra_fields={
            "url_backfill_last_run": {
                "backfilled_at_utc": isoformat_utc(datetime.now(timezone.utc)),
                "candidate_messages": len(candidate_ids),
                "scanned_messages": scanned,
                "updated_messages": updated,
            }
        },
    )

    audit_payload = {
        "ok": True,
        "mode": "backfill_urls",
        "generated_at_utc": isoformat_utc(datetime.now(timezone.utc)),
        "output_dir": str(output_dir.resolve()),
        "messages_file": str(messages_path.resolve()),
        "manifest_file": str(manifest_path.resolve()),
        "local_archive": build_local_archive_audit(records),
    }
    audit_path.write_text(json.dumps(audit_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print_panel(
        "URL Backfill Complete",
        [
            f"Candidate messages: {len(candidate_ids)}",
            f"Scanned: {scanned}",
            f"Updated: {updated}",
            f"Records with external URLs: {audit_payload['local_archive']['records_with_external_urls']}",
            f"Audit report: {audit_path.name}",
        ],
        tone="ok",
    )
    print(json.dumps(audit_payload, ensure_ascii=True))


async def export_messages(args: argparse.Namespace) -> None:
    # Save settings for --last-run before doing anything
    save_last_run_config(args)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    messages_path = output_dir / "messages.jsonl"
    manifest_path = output_dir / "manifest.json"
    failed_media_path = output_dir / "failed_media.jsonl"
    media_dir = output_dir / "media" if args.download_media else None
    existing_state = load_existing_archive_state(messages_path) if args.resume else load_existing_archive_state(Path("__missing__"))
    existing_ids: set[int] = existing_state["existing_ids"]

    exported_at = datetime.now(timezone.utc)

    async with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        client.flood_sleep_threshold = 30

        entity = await client.get_entity(args.chat)
        chat_id = getattr(entity, "id", None)
        history_probe = await client.get_messages(entity, limit=1)
        latest_message_id = history_probe[0].id if history_probe else None
        available_total_messages = getattr(history_probe, "total", None)
        target_total_messages = available_total_messages
        if args.limit is not None:
            if target_total_messages is None:
                target_total_messages = args.limit
            else:
                target_total_messages = min(target_total_messages, args.limit)

        resumed_existing_count = existing_state["existing_count"]
        skipped_existing_messages = 0
        max_parallelism = max(1, int(args.parallelism or 1))
        started_at = time.monotonic()
        last_progress_at = started_at

        print_panel(
            "Export Starting",
            [
                f"Chat: {getattr(entity, 'title', None) or getattr(entity, 'username', None) or args.chat}",
                f"Chat ID: {chat_id}",
                f"Total messages found: {available_total_messages}",
                f"Target export count: {target_total_messages}",
                f"Latest message ID: {latest_message_id}",
                f"Download media: {args.download_media}",
                f"Include raw payloads: {args.include_raw}",
                f"Resume mode: {args.resume}",
                f"Existing messages in archive: {resumed_existing_count}",
                f"Media download workers: {max_parallelism}",
            ],
            tone="info",
        )

        # ═══════════════════════════════════════════════════════════════
        # PHASE 1: Fast text-only message fetch (no media downloads)
        # ═══════════════════════════════════════════════════════════════
        print_line("", tone="info")
        print_line("▶ Phase 1: Fetching all messages (text only)...", tone="accent")

        new_records: list[dict[str, Any]] = []
        media_queue: list[tuple[int, Any]] = []  # (index_in_new_records, message_obj)
        fetch_count = 0

        async for message in client.iter_messages(
            entity,
            limit=args.limit,
            wait_time=0,
        ):
            if not hasattr(message, "id"):
                continue
            if args.resume and message.id in existing_ids:
                skipped_existing_messages += 1
                if skipped_existing_messages % 500 == 0:
                    now = time.monotonic()
                    if now - last_progress_at >= 1:
                        rate = skipped_existing_messages / (now - started_at)
                        print_live_progress(
                            f"  Skipping existing... {skipped_existing_messages} skipped  |  {rate:.0f} msg/s",
                            tone="muted",
                        )
                        last_progress_at = now
                continue

            # Build record WITHOUT downloading media
            record = build_archive_message(
                entity=entity,
                message=message,
                chat_id=chat_id,
                media_path=None,
                media_error=None,
                include_raw=args.include_raw,
            )
            new_records.append(record)

            # Queue media for Phase 2 if needed
            if args.download_media and is_downloadable_media(message):
                media_queue.append((len(new_records) - 1, message))

            fetch_count += 1
            now = time.monotonic()
            if now - last_progress_at >= 0.5:
                elapsed = now - started_at
                rate = fetch_count / elapsed if elapsed > 0 else 0
                total_for_bar = target_total_messages - resumed_existing_count if target_total_messages else None
                bar = make_progress_bar(fetch_count, total_for_bar, width=20)
                print_live_progress(
                    f"  {bar}  {fetch_count} messages fetched  |  {rate:.0f} msg/s  |  {format_duration(elapsed)}",
                    tone="ok",
                )
                last_progress_at = now

        phase1_elapsed = time.monotonic() - started_at
        finish_live_progress()
        print_line(
            f"✓ Phase 1 complete: {fetch_count} messages fetched in {format_duration(phase1_elapsed)}"
            f"  ({skipped_existing_messages} existing skipped, {len(media_queue)} media queued)",
            tone="ok",
        )

        # ═══════════════════════════════════════════════════════════════
        # PHASE 2: Parallel media downloads
        # ═══════════════════════════════════════════════════════════════
        media_downloaded = existing_state["existing_media_downloaded"]
        media_failed = existing_state["existing_media_failed"]

        if media_queue and media_dir:
            media_dir.mkdir(parents=True, exist_ok=True)
            media_total = len(media_queue)
            media_done = 0
            new_media_ok = 0
            new_media_fail = 0
            dl_workers = max(3, max_parallelism)  # 3 concurrent — less Telegram throttling
            media_semaphore = asyncio.Semaphore(dl_workers)

            # Suppress noisy Telethon internal errors during bulk downloads
            import logging
            logging.getLogger('telethon').setLevel(logging.CRITICAL)

            print_line("", tone="info")
            print_line(
                f"▶ Phase 2: Downloading {media_total} media files ({dl_workers} concurrent workers)...",
                tone="accent",
            )

            phase2_start = time.monotonic()
            last_progress_at = phase2_start

            async def download_one(record_idx: int, message: Any) -> None:
                nonlocal media_done, new_media_ok, new_media_fail, media_downloaded, media_failed
                async with media_semaphore:
                    media_path, media_error = await maybe_download_media(message, media_dir)
                    new_records[record_idx]["media_path"] = media_path
                    new_records[record_idx]["media_download_error"] = media_error
                    if media_path:
                        new_media_ok += 1
                        media_downloaded += 1
                    if media_error:
                        new_media_fail += 1
                        media_failed += 1
                    media_done += 1

            # Launch all downloads concurrently (semaphore controls actual concurrency)
            tasks = [
                asyncio.create_task(download_one(idx, msg))
                for idx, msg in media_queue
            ]

            # Monitor progress while downloads run
            while not all(t.done() for t in tasks):
                await asyncio.sleep(0.5)
                now = time.monotonic()
                if now - last_progress_at >= 0.5:
                    elapsed = now - phase2_start
                    rate = media_done / elapsed if elapsed > 0 else 0
                    remaining = media_total - media_done
                    eta = remaining / rate if rate > 0 else 0
                    bar = make_progress_bar(media_done, media_total, width=20)
                    print_live_progress(
                        f"  {bar}  {media_done}/{media_total} media"
                        f"  |  {new_media_ok} ok / {new_media_fail} failed"
                        f"  |  {rate:.1f} files/s"
                        f"  |  {format_duration(elapsed)}"
                        f"  |  eta {format_duration(eta)}",
                        tone="ok",
                    )
                    last_progress_at = now

            # Collect any exceptions
            for t in tasks:
                if t.exception():
                    print_line(f"Media download error: {t.exception()}", tone="warn")

            phase2_elapsed = time.monotonic() - phase2_start
            finish_live_progress()
            logging.getLogger('telethon').setLevel(logging.WARNING)  # Restore logging
            print_line(
                f"✓ Phase 2 complete: {new_media_ok} media downloaded,"
                f" {new_media_fail} failed"
                f" in {format_duration(phase2_elapsed)}",
                tone="ok",
            )

        # ═══════════════════════════════════════════════════════════════
        # Write final JSONL with media paths filled in
        # ═══════════════════════════════════════════════════════════════
        if new_records:
            file_mode = "a" if args.resume and messages_path.exists() else "w"
            with messages_path.open(file_mode, encoding="utf-8", buffering=1024 * 64) as messages_handle:
                for record in new_records:
                    messages_handle.write(json.dumps(record, ensure_ascii=False) + "\n")

        # Calculate final stats
        new_messages_exported = len(new_records)
        message_count = resumed_existing_count + new_messages_exported
        first_message_id = existing_state["first_message_id"]
        first_message_date = existing_state["first_message_date"]
        last_message_id = existing_state["last_message_id"]
        last_message_date = existing_state["last_message_date"]
        if new_records:
            if first_message_id is None:
                first_message_id = new_records[0]["message_id"]
                first_message_date = new_records[0]["date_utc"]
            last_message_id = new_records[-1]["message_id"]
            last_message_date = new_records[-1]["date_utc"]

        # ═══════════════════════════════════════════════════════════════
        # Write manifest
        # ═══════════════════════════════════════════════════════════════
        manifest = {
            "archive_version": ARCHIVE_VERSION,
            "exported_at_utc": isoformat_utc(exported_at),
            "source": {
                "chat_input": args.chat,
                "chat_id": chat_id,
                "chat_title": getattr(entity, "title", None),
                "chat_username": getattr(entity, "username", None),
                "chat_type": type(entity).__name__,
                "session_name": args.session,
            },
            "files": {
                "messages": "messages.jsonl",
                "media_dir": "media" if args.download_media else None,
                "failed_media": "failed_media.jsonl",
            },
            "counts": {
                "messages": message_count,
                "available_total_messages": available_total_messages,
                "target_total_messages": target_total_messages,
                "resumed_existing_messages": resumed_existing_count,
                "new_messages_exported": new_messages_exported,
                "skipped_existing_messages": skipped_existing_messages,
                "media_downloaded": media_downloaded,
                "media_download_failures": media_failed,
            },
            "range": {
                "first_message_id": first_message_id,
                "first_message_date_utc": first_message_date,
                "last_message_id": last_message_id,
                "last_message_date_utc": last_message_date,
            },
            "options": {
                "download_media": args.download_media,
                "include_raw": args.include_raw,
                "limit": args.limit,
                "resume": args.resume,
                "parallelism": max_parallelism,
            },
            "chat_raw": serialize_tl_object(entity) if args.include_raw else None,
        }

        with manifest_path.open("w", encoding="utf-8") as manifest_handle:
            json.dump(manifest, manifest_handle, ensure_ascii=False, indent=2)

        all_records = read_archive_records(messages_path)
        all_records = sort_archive_records(all_records)
        write_archive_records(messages_path, all_records)
        write_failed_media_queue(failed_media_path, all_records)
        write_failed_media_links(output_dir / "failed_media_links.txt", all_records)
        update_manifest_from_records(manifest_path, all_records, exported_at=exported_at)

        archive_range = compute_archive_range(all_records)
        message_count = len(all_records)
        first_message_id = archive_range["first_message_id"]
        first_message_date = archive_range["first_message_date_utc"]
        last_message_id = archive_range["last_message_id"]
        last_message_date = archive_range["last_message_date_utc"]
        counts = compute_archive_counts(all_records)
        media_downloaded = counts["media_downloaded"]
        media_failed = counts["media_download_failures"]

        elapsed = time.monotonic() - started_at
        rate = message_count / elapsed if elapsed > 0 else 0
        finish_live_progress()
        print_panel(
            "Export Complete",
            [
                f"Messages exported: {format_progress(message_count, target_total_messages)}",
                f"New messages written this run: {new_messages_exported}",
                f"Existing messages skipped: {skipped_existing_messages}",
                f"First message ID: {first_message_id}",
                f"Last message ID: {last_message_id}",
                f"Media downloaded: {media_downloaded}",
                f"Media failed: {media_failed}",
                f"Elapsed: {format_duration(elapsed)}",
                f"Average speed: {rate:.1f} msg/s",
            ],
            tone="ok",
        )

    print(
        json.dumps(
            {
                "ok": True,
                "archive_version": ARCHIVE_VERSION,
                "output_dir": str(output_dir.resolve()),
                "messages_file": str(messages_path.resolve()),
                "manifest_file": str(manifest_path.resolve()),
                "failed_media_file": str(failed_media_path.resolve()),
                "download_media": args.download_media,
                "message_count": message_count,
                "new_messages_exported": new_messages_exported,
                "skipped_existing_messages": skipped_existing_messages,
                "available_total_messages": available_total_messages,
                "target_total_messages": target_total_messages,
                "media_downloaded": media_downloaded,
                "media_download_failures": media_failed,
            },
            ensure_ascii=False,
        )
    )


async def retry_failed_media_only(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    messages_path = output_dir / "messages.jsonl"
    manifest_path = output_dir / "manifest.json"
    failed_media_path = output_dir / "failed_media.jsonl"
    media_dir = output_dir / "media"

    if not messages_path.exists():
        raise SystemExit(
            f"No archive found at {messages_path}. Run a normal export first."
        )

    records = read_archive_records(messages_path)
    message_index_by_id = {
        record.get("message_id"): index
        for index, record in enumerate(records)
        if isinstance(record.get("message_id"), int)
    }
    queued_failures = read_failed_media_queue(failed_media_path)
    if queued_failures:
        failed_items = [
            (message_index_by_id[record["message_id"]], records[message_index_by_id[record["message_id"]]])
            for record in queued_failures
            if isinstance(record.get("message_id"), int) and record["message_id"] in message_index_by_id
        ]
    else:
        failed_items = [
            (index, record)
            for index, record in enumerate(records)
            if record.get("media_download_error")
        ]

    if not failed_items:
        print_panel(
            "Retry Failed Media",
            ["No failed media entries were found in the existing archive."],
            tone="ok",
        )
        print(
            json.dumps(
                {
                    "ok": True,
                    "retry_mode": True,
                    "retried": 0,
                    "recovered": 0,
                    "still_failed": 0,
                    "messages_file": str(messages_path.resolve()),
                    "failed_media_file": str(failed_media_path.resolve()),
                },
                ensure_ascii=False,
            )
        )
        return

    media_dir.mkdir(parents=True, exist_ok=True)
    parallelism = max(1, int(args.parallelism or 2))

    print_panel(
        "Retry Failed Media",
        [
            f"Archive: {output_dir}",
            f"Failed media queued: {len(failed_items)}",
            f"Queue file: {failed_media_path.name}",
            f"Parallel workers: {parallelism}",
        ],
        tone="warn",
    )

    async with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        client.flood_sleep_threshold = 30
        entity = await client.get_entity(args.chat)
        semaphore = asyncio.Semaphore(parallelism)

        total = len(failed_items)
        completed = 0
        recovered = 0
        still_failed = 0
        started_at = time.monotonic()
        last_progress_at = started_at

        async def retry_one(record_index: int, record: dict[str, Any]) -> None:
            nonlocal completed, recovered, still_failed
            message_id = record.get("message_id")
            if not isinstance(message_id, int):
                record["media_download_error"] = "invalid_message_id"
                still_failed += 1
                completed += 1
                return

            async with semaphore:
                try:
                    message = await client.get_messages(entity, ids=message_id)
                except FloodWaitError as exc:
                    wait_seconds = int(getattr(exc, "seconds", 0) or 0)
                    print_line(
                        f"Flood-wait {wait_seconds}s while fetching message #{message_id}. Sleeping and retrying once.",
                        tone="warn",
                    )
                    await asyncio.sleep(max(wait_seconds, 1))
                    message = await client.get_messages(entity, ids=message_id)
                except Exception as exc:  # noqa: BLE001
                    records[record_index]["media_download_error"] = type(exc).__name__
                    still_failed += 1
                    completed += 1
                    return

                if not message or not getattr(message, "media", None):
                    records[record_index]["media_download_error"] = "message_missing_or_no_media"
                    still_failed += 1
                    completed += 1
                    return

                records[record_index]["external_urls"] = extract_external_urls(message)

                if not is_downloadable_media(message):
                    records[record_index]["media_download_error"] = None
                    records[record_index]["media_kind"] = media_kind(message)
                    records[record_index]["media_present"] = media_kind(message) is not None
                    records[record_index]["media_raw"] = serialize_tl_object(getattr(message, "media", None))
                    recovered += 1
                    completed += 1
                    return

                media_path, media_error = await maybe_download_media(message, media_dir)
                records[record_index]["media_path"] = media_path
                records[record_index]["media_download_error"] = media_error
                records[record_index]["media_kind"] = media_kind(message)
                records[record_index]["media_present"] = media_kind(message) is not None
                records[record_index]["media_raw"] = serialize_tl_object(getattr(message, "media", None))

                if media_path and not media_error:
                    recovered += 1
                else:
                    still_failed += 1
                completed += 1

        tasks = [
            asyncio.create_task(retry_one(index, record))
            for index, record in failed_items
        ]

        while not all(task.done() for task in tasks):
            await asyncio.sleep(0.5)
            now = time.monotonic()
            if now - last_progress_at >= 0.5:
                elapsed = now - started_at
                rate = completed / elapsed if elapsed > 0 else 0
                remaining = total - completed
                eta = remaining / rate if rate > 0 else 0
                bar = make_progress_bar(completed, total, width=20)
                print_live_progress(
                    f"  {bar}  {completed}/{total} retried"
                    f"  |  {recovered} recovered / {still_failed} still failed"
                    f"  |  {rate:.1f} files/s"
                    f"  |  {format_duration(elapsed)}"
                    f"  |  eta {format_duration(eta)}",
                    tone="ok",
                )
                last_progress_at = now

        for task in tasks:
            if task.exception():
                print_line(f"Retry task error: {task.exception()}", tone="warn")

    finish_live_progress()
    write_archive_records(messages_path, records)
    write_failed_media_queue(failed_media_path, records)
    write_failed_media_links(output_dir / "failed_media_links.txt", records)

    counts = compute_archive_counts(records)
    update_manifest_from_records(
        manifest_path,
        records,
        extra_fields={
            "retry_failed_media_only_last_run": {
                "retried": total,
                "recovered": recovered,
                "still_failed": still_failed,
            }
        },
    )

    print_panel(
        "Retry Complete",
        [
            f"Retried: {total}",
            f"Recovered: {recovered}",
            f"Still failed: {still_failed}",
            f"Archive media downloaded total: {counts['media_downloaded']}",
            f"Archive media failures total: {counts['media_download_failures']}",
        ],
        tone="ok" if still_failed == 0 else "warn",
    )

    print(
        json.dumps(
            {
                "ok": True,
                "retry_mode": True,
                "output_dir": str(output_dir.resolve()),
                "messages_file": str(messages_path.resolve()),
                "manifest_file": str(manifest_path.resolve()),
                "failed_media_file": str(failed_media_path.resolve()),
                "retried": total,
                "recovered": recovered,
                "still_failed": still_failed,
                "media_downloaded": counts["media_downloaded"],
                "media_download_failures": counts["media_download_failures"],
            },
            ensure_ascii=False,
        )
    )


def main() -> None:
    args = parse_args()
    if getattr(args, "repair_archive", False):
        output_dir = Path(args.output_dir)
        payload = repair_archive(output_dir)
        print_panel(
            "Repair Complete",
            [
                f"Archive: {output_dir}",
                f"Messages: {payload['local_archive']['messages_total']}",
                f"Last message ID: {payload['local_archive']['range']['last_message_id']}",
                f"Media failures: {payload['local_archive']['media_download_failures']}",
                "Archive files were sorted and refreshed locally.",
            ],
            tone="ok",
        )
        print(json.dumps(payload, ensure_ascii=False))
    elif getattr(args, "retry_failed_media_only", False):
        asyncio.run(retry_failed_media_only(args))
    elif getattr(args, "backfill_urls", False):
        asyncio.run(backfill_urls(args))
    elif getattr(args, "audit_source_only", False):
        asyncio.run(audit_source_only(args))
    else:
        asyncio.run(export_messages(args))


if __name__ == "__main__":
    main()
