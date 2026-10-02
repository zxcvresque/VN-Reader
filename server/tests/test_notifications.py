import os
import unittest
from unittest.mock import patch, Mock
from server import notifications


class NotificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_topic_is_persisted_without_creating_a_topic(self):
        store = Mock()
        store.meta.return_value = 999
        with patch.dict(os.environ, {"TELEGRAM_LOG_TOPIC_ID": "4523"}), patch("urllib.request.urlopen") as request:
            await notifications.configure_topic(store)
            store.set_meta.assert_called_once_with("logs_topic_id", 4523)
            request.assert_not_called()

    async def test_no_configured_topic_never_creates_duplicates(self):
        store = Mock()
        store.meta.return_value = None
        with patch.dict(os.environ, {}, clear=True), patch("urllib.request.urlopen") as request:
            await notifications.configure_topic(store)
            request.assert_not_called()
            store.set_meta.assert_not_called()

    async def test_failure_events_are_throttled_and_use_existing_topic(self):
        import json
        calls = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"ok":true}'
        def send(request, timeout):
            calls.append(json.loads(request.data))
            return Response()
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN":"test", "TELEGRAM_LOG_TOPIC_ID":"4523", "TELEGRAM_DESTINATION":"-1004434351194"}), patch("urllib.request.urlopen", side_effect=send), patch.object(notifications, "_last", {}):
            await notifications.notify("Media delivery failed", "Post #10 · ConnectionError")
            await notifications.notify("Media delivery failed", "Post #11 · ConnectionError")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["message_thread_id"], 4523)
        self.assertEqual(calls[0]["chat_id"], "-1004434351194")

    async def test_only_explicit_critical_events_reach_owner_and_are_throttled(self):
        import json
        calls = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"ok":true}'
        def send(request, timeout):
            calls.append(json.loads(request.data)); return Response()
        env = {"TELEGRAM_BOT_TOKEN":"test", "TELEGRAM_LOG_TOPIC_ID":"4523", "TELEGRAM_DESTINATION":"-1004434351194", "TELEGRAM_OWNER_ID":"5988446905"}
        with patch.dict(os.environ, env, clear=True), patch("urllib.request.urlopen", side_effect=send), patch.object(notifications, "_last", {}):
            await notifications.notify("Critical failure words in routine event", cooldown=0)
            await notifications.notify("Media delivery failed", "ConnectionError", cooldown=0, severity="critical")
            await notifications.notify("Media delivery failed", "ConnectionError", cooldown=0, severity="critical")
        owner = [c for c in calls if c["chat_id"] == "5988446905"]
        self.assertEqual(len(owner),1)
        self.assertNotIn("message_thread_id",owner[0])
        self.assertIn("Media delivery failed",owner[0]["text"])
        self.assertTrue(owner[0]["text"].startswith("CRITICAL · "))
        self.assertEqual(len([c for c in calls if "message_thread_id" in c]),3)

    async def test_owner_delivery_survives_missing_or_failing_topic(self):
        import json
        for topic in ["", "4523"]:
            calls = []
            class Response:
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self): return b'{"ok":true}'
            def send(request, timeout):
                body = json.loads(request.data)
                if "message_thread_id" in body: raise RuntimeError("private credential must not be logged")
                calls.append(body); return Response()
            env = {"TELEGRAM_BOT_TOKEN":"test", "TELEGRAM_LOG_TOPIC_ID":topic, "TELEGRAM_DESTINATION":"-1004434351194", "TELEGRAM_OWNER_ID":"5988446905", "VN_DATABASE_PATH":":memory:"}
            with patch.dict(os.environ, env, clear=True), patch("urllib.request.urlopen", side_effect=send), patch.object(notifications, "_last", {}):
                await notifications.notify("Archive startup failed", "ConnectionError", severity="critical")
            self.assertEqual(len(calls),1)
            self.assertEqual(calls[0]["chat_id"],"5988446905")

    async def test_delivery_failures_never_escape_or_include_exception_credentials(self):
        env = {"TELEGRAM_BOT_TOKEN":"private-token", "TELEGRAM_OWNER_ID":"5988446905", "VN_DATABASE_PATH":":memory:"}
        with patch.dict(os.environ, env, clear=True), patch("urllib.request.urlopen", side_effect=RuntimeError("https://api.telegram.org/botprivate-token/sendMessage")), patch.object(notifications, "_last", {}):
            with self.assertLogs("server.notifications", level="WARNING") as captured:
                await notifications.notify("Archive startup failed", severity="critical")
            self.assertNotIn("private-token",str(captured.output))

    async def test_mirror_startup_failure_alert_is_awaited_before_exit(self):
        from server import mirror
        from unittest.mock import AsyncMock
        alert = AsyncMock()
        with patch.object(mirror, "configuration", side_effect=ValueError("private configuration")), patch.object(mirror, "notify", alert):
            with self.assertRaises(ValueError):
                await mirror.run("watch")
        alert.assert_awaited_once_with("Archive mirror startup failed", "ValueError", severity="critical")

    async def test_mirror_fatal_failure_alert_is_awaited_and_not_duplicated(self):
        from server import mirror
        from unittest.mock import AsyncMock
        async def failed(command, state):
            state["started"] = True
            raise ConnectionError("private configuration")
        alert = AsyncMock()
        with patch.object(mirror, "_run", failed), patch.object(mirror, "notify", alert):
            with self.assertRaises(ConnectionError): await mirror.run("backfill")
        alert.assert_awaited_once_with("Archive mirror stopped", "ConnectionError", severity="critical")
        async def already_alerted(command, state):
            state["alerted"] = True
            raise ConnectionError()
        alert.reset_mock()
        with patch.object(mirror, "_run", already_alerted), patch.object(mirror, "notify", alert):
            with self.assertRaises(ConnectionError): await mirror.run("backfill")
        alert.assert_not_awaited()
