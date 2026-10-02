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
