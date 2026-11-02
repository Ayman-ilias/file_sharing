"""Parallel chunks must never lose a `received` entry (guards the per-upload lock)."""

import time

import pytest

from tests.conftest import login, start_upload

DATA = b"0123456789ab"  # 3 chunks of 4


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_concurrent_chunks_never_lose_received_entries(chunk4, client, make_client, app,
                                                             monkeypatch):
    import anyio

    import app.transfers as transfers
    from app.models import Upload

    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]

    real_now = transfers.utcnow

    def slow_now():  # called between loading the row and committing it: widens the race window
        time.sleep(0.05)
        return real_now()

    monkeypatch.setattr(transfers, "utcnow", slow_now)
    async with anyio.create_task_group() as tg:
        for n in range(3):
            tg.start_soon(transfers.record_chunk, app, uid, n, DATA[n * 4:(n + 1) * 4])
    with app.state.session_factory() as s:
        up = s.get(Upload, uid)
        assert up.received == [0, 1, 2] and up.received_bytes == 12
