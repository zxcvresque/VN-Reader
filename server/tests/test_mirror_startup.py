"""Startup rate limits pause the existing clients instead of restarting them."""
import io
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from telethon.errors import FloodWaitError

from server import mirror


class MirrorStartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_every_startup_rpc_waits_and_resumes_same_clients(self):
        for stage in ("connect", "authorization", "reader_entity", "bot_login",
                      "bot_identity", "bot_source", "bot_destination", "bot_peer", "catch_up"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                source = SimpleNamespace(broadcast=True, username="VidurNeeti", title="VN", noforwards=False)
                destination = SimpleNamespace(megagroup=True, username=None, forum=False)
                reader = SimpleNamespace(connect=AsyncMock(), is_user_authorized=AsyncMock(return_value=True),
                    get_entity=AsyncMock(return_value=source), disconnect=AsyncMock(), catch_up=AsyncMock(),
                    add_event_handler=Mock(), get_messages=AsyncMock(return_value=SimpleNamespace(total=0)))
                bot = SimpleNamespace(start=AsyncMock(), get_me=AsyncMock(return_value=SimpleNamespace(bot=True)),
                    get_entity=AsyncMock(side_effect=[source, destination]),
                    get_input_entity=AsyncMock(return_value="private-peer"), disconnect=AsyncMock())
                methods = {"connect": reader.connect, "authorization": reader.is_user_authorized,
                           "reader_entity": reader.get_entity, "bot_login": bot.start,
                           "bot_identity": bot.get_me, "bot_source": bot.get_entity,
                           "bot_destination": bot.get_entity, "bot_peer": bot.get_input_entity,
                           "catch_up": reader.catch_up}
                operation = methods[stage]
                flood = FloodWaitError(None, capture=1799)
                if stage == "bot_source": operation.side_effect = [flood, source, destination]
                elif stage == "bot_destination": operation.side_effect = [source, flood, destination]
                else: operation.side_effect = [flood, operation.return_value]
                config = {"reader_session": str(Path(directory)/"reader"), "api_id": 123,
                          "api_hash": "fake-hash", "bot_token": "123:fake-token", "source": "@VidurNeeti",
                          "destination": -100999, "database": str(Path(directory)/"mirror.sqlite"), "topic_id": 42}
                fake_mirror = SimpleNamespace(backfill=AsyncMock(return_value=True), apply_edits=AsyncMock())
                with patch.object(mirror, "configuration", return_value=config), \
                     patch("telethon.TelegramClient", side_effect=[reader, bot]) as constructors, \
                     patch("telethon.utils.get_peer_id", return_value=-100123), \
                     patch.object(mirror, "Mirror", return_value=fake_mirror), \
                     patch.object(mirror.TerminalProgress, "wait", new_callable=AsyncMock) as wait, \
                     patch.object(mirror, "notify", new_callable=AsyncMock) as notify, \
                     patch("sys.stdout", new=io.StringIO()):
                    await mirror.run("backfill")
                    wait.assert_awaited_once_with(1800)
                    self.assertEqual(constructors.call_count, 2)
                    self.assertEqual(operation.await_count, 3 if stage.startswith("bot_") and stage in {"bot_source", "bot_destination"} else 2)
                    self.assertFalse(any(call.kwargs.get("severity") == "critical" for call in notify.call_args_list))
                reader.disconnect.assert_awaited_once()
                bot.disconnect.assert_awaited_once()

    async def test_startup_countdown_works_before_database_is_bound(self):
        output = io.StringIO()
        progress = mirror.TerminalProgress(None, color=False, output=output)
        with patch.object(mirror.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            await progress.wait(6)
        self.assertIn("startup paused safely", output.getvalue())
        self.assertEqual([call.args[0] for call in sleep.await_args_list], [5, 1])


if __name__ == "__main__": unittest.main()
