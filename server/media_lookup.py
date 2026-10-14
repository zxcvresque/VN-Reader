"""Bounded, short-lived Telegram message metadata; never downloaded file bytes."""
from __future__ import annotations
import asyncio
from collections import OrderedDict
import time


class _Identity:
    """Identity key that retains its object, preventing recycled id() collisions."""
    def __init__(self, value):
        self.value = value
    def __hash__(self):
        return id(self.value)
    def __eq__(self, other):
        return isinstance(other, _Identity) and self.value is other.value


def _destination_key(destination):
    if isinstance(destination, (str, int)):
        return (type(destination), destination)
    # Telethon InputPeer objects are mutable and unhashable. Their peer identity
    # plus access hash distinguishes destinations while allowing equivalent peers.
    for field in ("channel_id", "chat_id", "user_id"):
        value = getattr(destination, field, None)
        if isinstance(value, int):
            return (type(destination), field, value, getattr(destination, "access_hash", None))
    return _Identity(destination)


class MediaLookupCache:
    def __init__(self, ttl=30, max_entries=256, clock=time.monotonic):
        if ttl <= 0 or max_entries <= 0:
            raise ValueError("Cache lifetime and capacity must be positive")
        self.ttl, self.max_entries, self.clock = ttl, max_entries, clock
        self._entries = OrderedDict()
        self._pending = {}
        self._clearing = False

    async def get(self, client, destination, message_id, loader, *, force=False):
        if self._clearing:
            raise asyncio.CancelledError()
        key = (_Identity(client), _destination_key(destination), message_id)
        now = self.clock()
        for expired in [entry for entry, (deadline, _) in self._entries.items() if deadline <= now]:
            self._entries.pop(expired, None)
        if force:
            self._entries.pop(key, None)
        elif key in self._entries:
            self._entries.move_to_end(key)
            return self._entries[key][1]
        task = self._pending.get(key)
        if task is None:
            task = asyncio.create_task(self._load(key, loader))
            self._pending[key] = task
            # Retrieve failures even when every HTTP caller disconnects, avoiding
            # an unobserved task exception without turning failures into cache hits.
            task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        # A disconnected caller must not cancel another caller's shared lookup.
        return await asyncio.shield(task)

    async def _load(self, key, loader):
        try:
            message = await loader()
            file = getattr(message, "file", None)
            if file is not None and getattr(file, "size", None) is not None:
                self._entries[key] = (self.clock() + self.ttl, message)
                self._entries.move_to_end(key)
                while len(self._entries) > self.max_entries:
                    self._entries.popitem(last=False)
            return message
        finally:
            if self._pending.get(key) is asyncio.current_task():
                self._pending.pop(key, None)

    async def clear(self):
        """Shutdown: cancel shared loaders, await cleanup, then drop metadata."""
        self._clearing = True
        try:
            tasks = list(self._pending.values())
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            self._pending.clear()
            self._entries.clear()
            self._clearing = False
