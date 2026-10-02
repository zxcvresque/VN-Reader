"""VPS bot roles reuse their own credentials without sharing legacy sessions."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from telethon.crypto import AuthKey
from telethon.sessions import MemorySession, SQLiteSession
from telethon import TelegramClient, types

from server.bot_sessions import create_bot_session


class BotSessionTests(unittest.TestCase):
    def test_local_clients_get_independent_memory_sessions(self):
        with patch.dict(os.environ, {"TELEGRAM_BOT_SESSION_DIRECTORY": ""}):
            first = create_bot_session("api")
            second = create_bot_session("api")
        self.assertIsInstance(first, MemorySession)
        self.assertNotIsInstance(first, SQLiteSession)
        self.assertIsNot(first, second)

    def test_vps_restarts_reuse_key_and_keep_roles_separate(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"TELEGRAM_BOT_SESSION_DIRECTORY": directory}):
            first = create_bot_session("api")
            first.auth_key = AuthKey(bytes(range(256)))
            first.save(); first.close()
            restarted = create_bot_session("api")
            writer = create_bot_session("writer")
            try:
                self.assertEqual(restarted.auth_key.key, bytes(range(256)))
                self.assertIsNone(writer.auth_key)
                self.assertNotEqual(restarted.filename, writer.filename)
                self.assertEqual(Path(restarted.filename).stat().st_mode & 0o777, 0o600)
            finally:
                restarted.close(); writer.close()

    def test_invalid_api_key_reset_leaves_writer_key_intact(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"TELEGRAM_BOT_SESSION_DIRECTORY": directory}):
            for role in ("api", "writer"):
                session = create_bot_session(role)
                session.auth_key = AuthKey(bytes(range(256)))
                session.save(); session.close()
            reset = create_bot_session("api", reset=True)
            writer = create_bot_session("writer")
            try:
                self.assertIsNone(reset.auth_key)
                self.assertEqual(writer.auth_key.key, bytes(range(256)))
            finally:
                reset.close(); writer.close()

    def test_legacy_session_files_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"TELEGRAM_BOT_SESSION_DIRECTORY": directory}):
            legacy = SQLiteSession(str(Path(directory)/"telegram-streamer"))
            legacy.auth_key = AuthKey(bytes(range(256)))
            legacy.save(); legacy.close()
            session = create_bot_session("api")
            try:
                self.assertIsNone(session.auth_key)
            finally:
                session.close()

    def test_unknown_role_cannot_select_arbitrary_session_path(self):
        with self.assertRaises(ValueError):
            create_bot_session("../reader")

    def test_rotated_bot_token_does_not_reuse_previous_authorization(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"TELEGRAM_BOT_SESSION_DIRECTORY": directory, "TELEGRAM_BOT_TOKEN": "123:first-test-token"}):
            first = create_bot_session("api")
            first.auth_key = AuthKey(bytes(range(256)))
            first.save(); first.close()
            with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "456:second-test-token"}):
                replacement = create_bot_session("api")
                try:
                    self.assertIsNone(replacement.auth_key)
                    self.assertNotEqual(replacement.filename, first.filename)
                finally:
                    replacement.close()


class BotSessionLoginTests(unittest.IsolatedAsyncioTestCase):
    async def test_restarted_client_with_valid_saved_login_skips_bot_authorization(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"TELEGRAM_BOT_SESSION_DIRECTORY": directory}):
            session = create_bot_session("api")
            session.set_dc(2, "149.154.167.51", 443)
            session.auth_key = AuthKey(bytes(range(256)))
            session.save(); session.close()
            restored = create_bot_session("api")
            client = TelegramClient(restored, 123, "fake-hash")
            me = types.User(id=123, bot=True, first_name="Test")
            try:
                with patch.object(client, "is_connected", Mock(return_value=True)), \
                     patch.object(client, "get_me", AsyncMock(return_value=me)), \
                     patch.object(client, "sign_in", AsyncMock()) as sign_in:
                    self.assertIs(await client.start(bot_token="123:fake-token"), client)
                    sign_in.assert_not_awaited()
            finally:
                restored.close()


if __name__ == "__main__": unittest.main()
