"""R2 packaging and bot command regressions; no live Telegram or R2 requests."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from telethon import TelegramClient, events
from telethon.sessions import MemorySession

from server import telegram
from server.mirror import MirrorStore
from server.r2_store import R2Config, R2Account, class_a_used, invalidate_stats_cache


class R2BotControlsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = MirrorStore(str(Path(self.tmp.name) / "archive.sqlite3"))
        self.client = TelegramClient(MemorySession(), 123, "test-hash")
        self.patches = [patch.object(telegram, "_store", self.store),
                        patch.dict("os.environ", {"TELEGRAM_OWNER_ID": "1234"})]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.store.close()
        self.tmp.cleanup()

    def command(self, text):
        telegram._register_r2_controls(self.client)
        return next(handler for handler, builder in self.client.list_event_handlers()
                    if isinstance(builder, events.NewMessage) and builder.pattern(text))

    async def test_start_replies_when_r2_disabled_instead_of_silently_disappearing(self):
        event = SimpleNamespace(sender_id=1234, respond=AsyncMock())
        with patch.object(telegram._r2, "load_r2_config", return_value=R2Config(None, None)):
            await self.command("/start")(event)
        event.respond.assert_awaited_once()
        self.assertIn("R2 unavailable", event.respond.call_args.args[0])

    async def test_start_returns_status_and_inline_controls_for_owner(self):
        event = SimpleNamespace(sender_id=1234, respond=AsyncMock())
        bundle = ("<b>R2 Status</b>", "HTML", {"inline_keyboard": [[{"text": "Refresh", "callback_data": "r2_refresh"}]]})
        with patch.object(telegram, "_r2_status_bundle", new=AsyncMock(return_value=bundle)):
            await self.command("/start")(event)
        self.assertEqual(event.respond.call_args.args[0], bundle[0])
        self.assertEqual(event.respond.call_args.kwargs["buttons"][0][0].type.data, b"r2_refresh")

    async def test_non_owner_and_missing_owner_cannot_get_controls(self):
        event = SimpleNamespace(sender_id=9999, respond=AsyncMock())
        await self.command("/start")(event)
        event.respond.assert_not_awaited()
        with patch.dict("os.environ", {"TELEGRAM_OWNER_ID": ""}):
            await self.command("/r2stats")(event)
        event.respond.assert_not_awaited()

    async def test_registration_is_idempotent_and_new_client_receives_handlers(self):
        telegram._register_r2_controls(self.client)
        telegram._register_r2_controls(self.client)
        self.assertEqual(len(self.client.list_event_handlers()), 3)
        replacement = TelegramClient(MemorySession(), 123, "test-hash")
        telegram._register_r2_controls(replacement)
        self.assertEqual(len(replacement.list_event_handlers()), 3)

    async def test_status_reads_real_usage_off_thread_without_sharing_sqlite_connection(self):
        account = R2Account("test-account", "test-key", "test-secret", "test-bucket", "https://media.example.com")
        client = SimpleNamespace(list_objects_v2=lambda **kwargs: {"Contents": [{"Size": 12345}]})
        invalidate_stats_cache()
        try:
            with patch.object(telegram._r2, "_client_for", return_value=client), \
                    patch.object(telegram._r2, "load_r2_config", return_value=R2Config(account, None, enabled=True)):
                text, _, keyboard = await telegram._r2_status_bundle()
            self.assertIn("12,345", text)
            self.assertEqual(class_a_used(self.store.db, account.bucket), 1)
            self.assertTrue(keyboard["inline_keyboard"])
        finally:
            invalidate_stats_cache()

    def test_archive_docker_image_packages_r2_modules(self):
        root = Path(__file__).resolve().parents[2]
        dockerfile = (root / "deploy/Dockerfile.telegram").read_text()
        packaged = " ".join(line for line in dockerfile.splitlines() if line.startswith("COPY server/"))
        for name in ["r2_store.py", "r2_media.py", "r2_controls.py", "r2_backfill.py"]:
            self.assertIn(f"server/{name}", packaged)
            self.assertTrue((root / "server" / name).is_file())
