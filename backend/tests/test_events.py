import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest

from app.events import Audience, Broker, event_stream
from tests.conftest import login, send_all, start_upload


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _drain(sub):
    out = []
    while not sub.queue.empty():
        out.append(sub.queue.get_nowait())
    return [m for m in out if m is not None]


@pytest.mark.anyio
async def test_created_event_reaches_only_people_who_can_see_it():
    b = Broker(max_streams_per_user=10)
    ayman, rahim, outsider = b.subscribe(1, False), b.subscribe(2, False), b.subscribe(3, False)
    b.publish("item.created", {"item": {"id": "x"}}, Audience(False, frozenset({1, 2})))
    await asyncio.sleep(0)
    assert len(_drain(ayman)) == 1 and len(_drain(rahim)) == 1 and _drain(outsider) == []


@pytest.mark.anyio
async def test_global_account_gets_only_everyone_events():
    b = Broker(max_streams_per_user=10)
    glob, user = b.subscribe(9, True), b.subscribe(1, False)
    b.publish("item.created", {"item": {"id": "p"}}, Audience(False, frozenset({1, 9})))
    b.publish("item.created", {"item": {"id": "g"}}, Audience(True, frozenset()))
    await asyncio.sleep(0)
    assert [m[1]["item"]["id"] for m in _drain(glob)] == ["g"]
    assert [m[1]["item"]["id"] for m in _drain(user)] == ["p", "g"]


@pytest.mark.anyio
async def test_stream_frames_heartbeat_and_end_on_revoked_session():
    b = Broker(max_streams_per_user=10)
    sub = b.subscribe(1, False)
    allowed = iter([True, False])

    async def still_allowed():
        return next(allowed)

    gen = event_stream(sub, still_allowed, heartbeat_s=0.01)
    assert await gen.__anext__() == "retry: 3000\n\n"
    b.publish("item.deleted", {"id": "x", "by": "rahim"}, Audience(True, frozenset()))
    frame = await gen.__anext__()
    assert frame.startswith("event: item.deleted\ndata: ") and frame.endswith("\n\n")
    assert json.loads(frame.split("data: ", 1)[1]) == {"id": "x", "by": "rahim"}
    # a named event, not an SSE comment: EventSource never shows comments to the page
    assert await gen.__anext__() == "event: ping\ndata: {}\n\n"  # still allowed
    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()  # session gone at the next heartbeat → stream ends


@pytest.mark.anyio
async def test_stream_cap_closes_oldest():
    b = Broker(max_streams_per_user=2)
    first, second, third = b.subscribe(1, False), b.subscribe(1, False), b.subscribe(1, False)
    assert first.dropped and not second.dropped and not third.dropped


@pytest.mark.anyio
async def test_slow_subscriber_is_dropped_not_blocking():
    b = Broker(max_streams_per_user=10, queue_size=100)
    slow, other = b.subscribe(1, False), b.subscribe(2, False)
    for i in range(101):
        b.publish("item.created", {"item": {"id": str(i)}}, Audience(True, frozenset()))
    await asyncio.sleep(0)
    assert slow.dropped and other.dropped is True  # neither read: both overflowed
    fresh = b.subscribe(3, False)
    b.publish("item.created", {"item": {"id": "z"}}, Audience(True, frozenset()))
    await asyncio.sleep(0)
    assert len(_drain(fresh)) == 1  # the broker itself never blocked


@pytest.mark.anyio
async def test_publish_from_another_thread():
    b = Broker(max_streams_per_user=10)
    sub = b.subscribe(1, False)
    await asyncio.to_thread(b.publish, "item.created", {"item": {"id": "t"}},
                            Audience(True, frozenset()))
    await asyncio.sleep(0.05)
    assert len(_drain(sub)) == 1


@pytest.fixture
def recorded(app):
    calls = []
    app.state.broker.publish = lambda event, payload, audience: calls.append(
        (event, payload, audience))
    return calls


def test_text_create_and_delete_publish(client, make_client, recorded):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    item = a.post("/api/items/text", json={"body": "hi", "recipient_ids": [r.me["id"]]}).json()
    assert recorded[-1][0] == "item.created" and recorded[-1][1]["item"]["id"] == item["id"]
    assert recorded[-1][2] == Audience(False, frozenset({a.me["id"], r.me["id"]}))
    r.delete(f"/api/items/{item['id']}")
    assert recorded[-1][0] == "item.deleted"
    assert recorded[-1][1] == {"id": item["id"], "by": "rahim"}
    assert recorded[-1][2] == Audience(False, frozenset({a.me["id"], r.me["id"]}))


def test_upload_and_batch_completion_publish_created(chunk4, client, make_client, recorded):
    from tests.conftest import register_files, start_batch

    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    uid = start_upload(a, b"abcdefgh", is_global=True).json()["upload_id"]
    send_all(a, uid, b"abcdefgh", 4)
    a.post(f"/api/uploads/{uid}/complete")
    assert recorded[-1][0] == "item.created" and recorded[-1][2].everyone
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    up = register_files(a, bid, [("x.txt", b"abcd")]).json()["uploads"][0]
    send_all(a, up["upload_id"], b"abcd", 4)
    a.post(f"/api/batches/{bid}/complete")
    assert recorded[-1][0] == "item.created" and recorded[-1][1]["item"]["kind"] == "folder"


def test_expiry_publishes_deleted_by_nobody(db_session, app_settings, make_user, make_item):
    from app.jobs import run_cleanup

    u = make_user("a@southerniot.net")
    item = make_item(u, is_global=True, expires_at=datetime.now(UTC) - timedelta(seconds=1))
    item_id = item.id
    seen = []
    run_cleanup(db_session, app_settings, datetime.now(UTC),
                on_deleted=lambda iid, aud: seen.append((iid, aud)))
    assert seen == [(item_id, Audience(True, frozenset()))]


def test_events_endpoint_needs_session(raw_client):
    assert raw_client.get("/api/events").status_code == 401


@pytest.mark.anyio
async def test_busy_stream_is_still_rechecked():
    """Review fix: events every few ms must not skip the session check forever."""
    b = Broker(max_streams_per_user=10)
    sub = b.subscribe(1, False)
    checks = []

    async def still_allowed():
        checks.append(1)
        return False  # signed out

    gen = event_stream(sub, still_allowed, heartbeat_s=0.05)
    assert await gen.__anext__() == "retry: 3000\n\n"
    frames = 0
    with pytest.raises(StopAsyncIteration):
        for _ in range(200):
            b.publish("item.created", {"item": {"id": "x"}}, Audience(True, frozenset()))
            await asyncio.sleep(0.005)
            await gen.__anext__()
            frames += 1
    assert checks and frames < 200
