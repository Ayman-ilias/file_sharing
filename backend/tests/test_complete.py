import os
import time
from datetime import UTC, datetime, timedelta

import pytest

from app.storage import storage_path
from tests.conftest import login, put_chunk, send_all, start_upload

DATA = b"0123456789"


@pytest.fixture
def pair(chunk4, client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    return a, r


def _complete(c, uid):
    return c.post(f"/api/uploads/{uid}/complete")


def test_complete_creates_item_moves_not_copies(pair, app_settings):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]], name="report.bin").json()["upload_id"]
    send_all(a, uid, DATA, 4)
    tmp = storage_path(app_settings.data_dir, "tmp", uid)
    inode = os.stat(tmp).st_ino
    resp = _complete(a, uid)
    assert resp.status_code == 201, resp.text
    item = resp.json()
    assert item["kind"] == "file" and item["size"] == 10 and item["name"] == "report.bin"
    assert item["recipients"] == [{"id": r.me["id"], "username": "rahim"}]
    stored = storage_path(app_settings.data_dir, "files", uid)
    assert stored.read_bytes() == DATA and os.stat(stored).st_ino == inode and not tmp.exists()
    assert [i["id"] for i in r.get("/api/items?section=private").json()["items"]] == [item["id"]]
    dl = r.get(f"/api/items/{item['id']}/download")
    assert dl.headers["x-accel-redirect"].endswith(uid)


def test_complete_retry_returns_same_item(pair, db_session):
    from app.models import Item

    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    send_all(a, uid, DATA, 4)
    first = _complete(a, uid).json()
    again = _complete(a, uid)
    assert again.status_code == 200 and again.json()["id"] == first["id"]
    assert db_session.query(Item).count() == 1


def test_crash_between_rename_and_commit_recovers(pair, monkeypatch, app_settings):
    import app.routers.uploads as uploads

    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    send_all(a, uid, DATA, 4)
    real = uploads._create_item
    calls = {"n": 0}

    def crash_once(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("power cut after the rename")
        return real(*args, **kwargs)

    monkeypatch.setattr(uploads, "_create_item", crash_once)
    with pytest.raises(RuntimeError):
        _complete(a, uid)
    assert storage_path(app_settings.data_dir, "files", uid).exists()  # renamed before the crash
    resp = _complete(a, uid)
    assert resp.status_code == 201 and resp.json()["size"] == 10


def test_zero_byte_file(pair, app_settings):
    a, r = pair
    init = start_upload(a, b"", recipients=[r.me["id"]], name="empty.txt")
    assert init.status_code == 201 and init.json()["received"] == []
    resp = _complete(a, init.json()["upload_id"])
    assert resp.status_code == 201 and resp.json()["size"] == 0
    stored = storage_path(app_settings.data_dir, "files", init.json()["upload_id"])
    assert stored.read_bytes() == b""


def test_one_byte_over_a_chunk(pair, app_settings):
    a, r = pair
    data = b"abcde"
    uid = start_upload(a, data, recipients=[r.me["id"]]).json()["upload_id"]
    send_all(a, uid, data, 4)
    assert _complete(a, uid).status_code == 201
    assert storage_path(app_settings.data_dir, "files", uid).read_bytes() == data


def test_missing_chunks_reported(pair):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    put_chunk(a, uid, 0, DATA[:4])
    resp = _complete(a, uid)
    assert resp.status_code == 409
    assert resp.json() == {"detail": "missing_chunks", "missing": [1, 2]}


def test_late_chunk_after_complete_is_409(pair):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    send_all(a, uid, DATA, 4)
    _complete(a, uid)
    resp = put_chunk(a, uid, 0, DATA[:4])
    assert resp.status_code == 409 and resp.json()["detail"] == "already_complete"


def test_cannot_complete_someone_elses_upload(pair):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    send_all(a, uid, DATA, 4)
    assert _complete(r, uid).status_code == 404


def test_idle_not_age_decides_staleness(pair, db_session, app_settings):
    from app.jobs import run_cleanup
    from app.models import Upload

    a, r = pair
    busy = start_upload(a, DATA, recipients=[r.me["id"]], client_key="busy").json()["upload_id"]
    idle = start_upload(a, DATA, recipients=[r.me["id"]], client_key="idle").json()["upload_id"]
    now = datetime.now(UTC)
    for uid, updated in ((busy, now - timedelta(hours=1)), (idle, now - timedelta(hours=25))):
        up = db_session.get(Upload, uid)
        up.created_at = now - timedelta(hours=30)  # both started yesterday
        up.updated_at = updated
    db_session.commit()
    run_cleanup(db_session, app_settings, now)
    db_session.expire_all()
    assert db_session.get(Upload, busy) is not None and db_session.get(Upload, idle) is None


def test_orphan_sweep(client, db_session, app_settings, make_user, make_item):
    from uuid import uuid4

    from app.jobs import run_cleanup

    u = make_user("a@southerniot.net")
    old = time.time() - 26 * 3600

    def put(kind, sid, age=old):
        p = storage_path(app_settings.data_dir, kind, sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
        os.utime(p, (age, age))
        return p

    orphan_file, orphan_tmp = put("files", uuid4().hex), put("tmp", uuid4().hex)
    fresh_orphan = put("files", uuid4().hex, age=time.time())
    kept_sid = uuid4().hex
    kept = put("files", kept_sid)
    make_item(u, kind="file", storage_id=kept_sid, is_global=True)
    run_cleanup(db_session, app_settings, datetime.now(UTC))
    assert not orphan_file.exists() and not orphan_tmp.exists()
    assert kept.exists() and fresh_orphan.exists()  # referenced, or too new to judge
