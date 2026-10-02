"""Separate host-local bot credentials; legacy migrated sessions are never reused."""
import os
import hashlib
from pathlib import Path


def create_bot_session(role, *, reset=False):
    from telethon.sessions import MemorySession, SQLiteSession
    if role not in {"api", "writer"}:
        raise ValueError("Unknown bot session role")
    directory = os.environ.get("TELEGRAM_BOT_SESSION_DIRECTORY")
    if not directory:
        return MemorySession()
    path = Path(directory)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Token changes must not silently reuse a different bot's authorization.
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    namespace = hashlib.sha256(token.encode()).hexdigest()[:16]
    session = SQLiteSession(str(path / f"{role}-v2-{namespace}"))
    Path(session.filename).chmod(0o600)
    if reset:
        # A revoked/duplicated key needs replacement, not repeated login with
        # the same invalid key. Network errors and FloodWait never reset it.
        session.auth_key = None
        session.save()
    return session
