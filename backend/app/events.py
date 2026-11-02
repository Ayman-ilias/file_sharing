"""Live updates (Server-Sent Events): an in-process broker, one per app (one uvicorn worker)."""

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

from fastapi import FastAPI


@dataclass(frozen=True)
class Audience:
    """Who may see an item: everyone (Global), or exactly these users (sender + recipients)."""

    everyone: bool
    user_ids: frozenset[int]


def audience_for(sender_id: int, is_global: bool, recipient_ids) -> Audience:
    if is_global:
        return Audience(True, frozenset())
    return Audience(False, frozenset({sender_id, *recipient_ids}))


@dataclass(eq=False)
class Subscription:
    user_id: int
    is_global_account: bool
    queue: asyncio.Queue
    dropped: bool = False


@dataclass
class Broker:
    max_streams_per_user: int
    queue_size: int = 100
    _subs: list[Subscription] = field(default_factory=list)
    _loop: asyncio.AbstractEventLoop | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def subscribe(self, user_id: int, is_global_account: bool) -> Subscription:
        self._loop = asyncio.get_running_loop()
        sub = Subscription(user_id, is_global_account, asyncio.Queue(maxsize=self.queue_size))
        with self._lock:
            self._subs.append(sub)
            mine = [s for s in self._subs if s.user_id == user_id and not s.dropped]
            for old in mine[: max(0, len(mine) - self.max_streams_per_user)]:
                self._drop(old)  # too many tabs: close the oldest
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            if sub in self._subs:
                self._subs.remove(sub)

    def _drop(self, sub: Subscription) -> None:
        sub.dropped = True
        if sub in self._subs:
            self._subs.remove(sub)
        try:
            sub.queue.put_nowait(None)  # wake the stream so it can end
        except asyncio.QueueFull:
            pass

    def publish(self, event: str, payload: dict, audience: Audience) -> None:
        """Safe from any thread. Slow subscribers are dropped, never waited on."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._deliver(event, payload, audience)
        else:
            loop.call_soon_threadsafe(self._deliver, event, payload, audience)

    def _deliver(self, event: str, payload: dict, audience: Audience) -> None:
        with self._lock:
            for sub in list(self._subs):
                if audience.everyone:
                    wanted = True
                else:  # the global account only ever sees Global items
                    wanted = not sub.is_global_account and sub.user_id in audience.user_ids
                if not wanted:
                    continue
                try:
                    sub.queue.put_nowait((event, payload))
                except asyncio.QueueFull:
                    self._drop(sub)


async def event_stream(sub: Subscription, still_allowed: Callable[[], Awaitable[bool]],
                       heartbeat_s: float = 25) -> AsyncIterator[str]:
    """SSE frames. Ends when the subscription is dropped or the session stops being valid."""
    yield "retry: 3000\n\n"
    while True:
        try:
            msg = await asyncio.wait_for(sub.queue.get(), timeout=heartbeat_s)
        except TimeoutError:
            if not await still_allowed():
                return
            yield ": ping\n\n"
            continue
        if msg is None or sub.dropped:
            return
        event, payload = msg
        yield f"event: {event}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"


def notify_created(app: FastAPI, item_out, audience: Audience) -> None:
    app.state.broker.publish("item.created", {"item": item_out.model_dump(mode="json")}, audience)


def notify_deleted(app: FastAPI, item_id: str, audience: Audience, by: str | None) -> None:
    app.state.broker.publish("item.deleted", {"id": item_id, "by": by}, audience)
