import errno
import hashlib

import pytest

from app.storage import storage_path
from tests.conftest import TEST_SHARED_PASSWORD, login, put_chunk, send_all, start_upload

DATA = b"0123456789"  # 10 bytes = 3 chunks of 4 (4, 4, 2)


@pytest.fixture
def pair(chunk4, client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    return a, r


def _tmp(app_settings, uid):
    return storage_path(app_settings.data_dir, "tmp", uid)


def test_out_of_order_and_repeated_chunks_give_identical_bytes(pair, app_settings, db_session):
    from app.models import Upload

    a, r = pair
    init = start_upload(a, DATA, recipients=[r.me["id"]])
    assert init.status_code == 201, init.text
    uid = init.json()["upload_id"]
    assert init.json()["chunk_size"] == 4 and init.json()["received"] == []
    for n in (2, 0, 0, 1):
        assert put_chunk(a, uid, n, DATA[n * 4:(n + 1) * 4]).status_code == 204
    assert hashlib.sha256(_tmp(app_settings, uid).read_bytes()[:10]).digest() == \
        hashlib.sha256(DATA).digest()
    db_session.expire_all()
    up = db_session.get(Upload, uid)
    assert up.received == [0, 1, 2] and up.received_bytes == 10


def test_received_list_persists_in_a_new_session(pair, app):
    from app.models import Upload

    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    put_chunk(a, uid, 1, DATA[4:8])
    with app.state.session_factory() as s:
        assert s.get(Upload, uid).received == [1]
    assert a.get(f"/api/uploads/{uid}").json()["received"] == [1]


def test_resume_returns_received_and_rows_own_chunk_size(pair, db_session):
    from app.models import Upload

    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]], client_key="file-1").json()["upload_id"]
    put_chunk(a, uid, 0, DATA[:4])
    db_session.get(Upload, uid).chunk_size = 4  # stays the row's own, even if settings change
    again = start_upload(a, DATA, recipients=[r.me["id"]], client_key="file-1")
    assert again.status_code == 200
    assert again.json() == {"upload_id": uid, "chunk_size": 4, "received": [0]}


def test_same_file_new_recipients_is_a_new_upload(pair, make_client):
    """The 2026-11-02 bug: a re-send to other people must not resume the old upload."""
    a, r = pair
    n = login(make_client(), "nusrat@southerniot.net")
    first = start_upload(a, DATA, recipients=[r.me["id"]], client_key="same").json()
    put_chunk(a, first["upload_id"], 0, DATA[:4])
    second = start_upload(a, DATA, recipients=[n.me["id"]], client_key="same")
    assert second.status_code == 201
    assert second.json()["upload_id"] != first["upload_id"] and second.json()["received"] == []


def test_resume_needs_same_size_and_same_user(pair, make_client):
    a, r = pair
    first = start_upload(a, DATA, recipients=[r.me["id"]], client_key="k1").json()
    bigger = start_upload(a, DATA + b"x", recipients=[r.me["id"]], client_key="k1").json()
    assert bigger["upload_id"] != first["upload_id"]
    other = login(make_client(), "other@southerniot.net")
    theirs = start_upload(other, DATA, recipients=[r.me["id"]], client_key="k1").json()
    assert theirs["upload_id"] != first["upload_id"]


def test_duplicate_and_unordered_recipient_ids_resume(pair, make_client):
    a, r = pair
    n = login(make_client(), "nusrat@southerniot.net")
    first = start_upload(a, DATA, recipients=[r.me["id"], n.me["id"], r.me["id"]],
                         client_key="k").json()
    again = start_upload(a, DATA, recipients=[n.me["id"], r.me["id"]], client_key="k")
    assert again.status_code == 200 and again.json()["upload_id"] == first["upload_id"]


def test_too_large_refused_before_bytes(pair, app_settings):
    a, r = pair
    body = {"client_key": "big", "name": "big.iso", "size": app_settings.max_file_size + 1,
            "mime": "x/y", "recipient_ids": [r.me["id"]], "is_global": False, "target": "share"}
    resp = a.post("/api/uploads", json=body)
    assert resp.status_code == 413 and resp.json()["detail"] == "too_large"
    assert not list((app_settings.data_dir / "tmp").rglob("*"))


def test_disk_full_and_reservation_shrinks(pair, app_settings, monkeypatch):
    import app.routers.uploads as uploads

    a, r = pair
    monkeypatch.setattr(uploads, "free_bytes", lambda _d: app_settings.disk_margin + 15)
    first = start_upload(a, DATA, recipients=[r.me["id"]], client_key="one")
    assert first.status_code == 201  # 15 free - 0 reserved - 10 >= 0
    second = start_upload(a, DATA, recipients=[r.me["id"]], client_key="two")
    assert second.status_code == 507 and second.json()["detail"] == "disk_full"  # 15 - 10 - 10 < 0
    send_all(a, first.json()["upload_id"], DATA, 4)  # reservation of the first drops to 0
    third = start_upload(a, DATA, recipients=[r.me["id"]], client_key="three")
    assert third.status_code == 201


@pytest.fixture
def two_uploads_max(monkeypatch):
    monkeypatch.setenv("MAX_USER_UPLOADS", "2")


@pytest.fixture
def fifteen_bytes_max(monkeypatch):
    monkeypatch.setenv("MAX_USER_RESERVED", "15")


def test_per_user_upload_quota(chunk4, two_uploads_max, client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    for k in ("q1", "q2"):
        assert start_upload(a, DATA, recipients=[r.me["id"]], client_key=k).status_code == 201
    resp = start_upload(a, DATA, recipients=[r.me["id"]], client_key="q3")
    assert resp.status_code == 429 and resp.json()["detail"] == "upload_quota"


def test_per_user_reserved_bytes_quota(chunk4, fifteen_bytes_max, client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    assert start_upload(a, DATA, recipients=[r.me["id"]], client_key="r1").status_code == 201
    resp = start_upload(a, DATA, recipients=[r.me["id"]], client_key="r2")
    assert resp.status_code == 429 and resp.json()["detail"] == "upload_quota"


def test_enospc_maps_to_507_and_chunk_not_marked(pair, monkeypatch):
    import app.transfers as transfers

    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]

    def full(*_a, **_k):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(transfers.os, "pwrite", full)
    resp = put_chunk(a, uid, 0, DATA[:4])
    assert resp.status_code == 507 and resp.json()["detail"] == "disk_full"
    assert a.get(f"/api/uploads/{uid}").json()["received"] == []


def test_wrong_chunk_length_rejected(pair):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    for n, body in ((0, b"abc"), (0, b"abcde"), (2, b"xyz")):
        resp = put_chunk(a, uid, n, body)
        assert resp.status_code == 400 and resp.json()["detail"] == "bad_chunk_size", (n, body)


def test_bad_chunk_numbers(pair):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    for n in (3, -1):
        assert put_chunk(a, uid, n, b"ab").status_code in (400, 422)
    assert put_chunk(a, uid, 3, b"ab").json()["detail"] == "bad_chunk"


def test_chunk_after_cancel_is_404_not_500(pair, app_settings):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    put_chunk(a, uid, 0, DATA[:4])
    assert a.delete(f"/api/uploads/{uid}").status_code == 204
    assert not _tmp(app_settings, uid).exists()
    resp = put_chunk(a, uid, 1, DATA[4:8])
    assert resp.status_code == 404 and resp.json()["detail"] == "not_found"


def test_other_user_cannot_touch_my_upload(pair, make_client):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    for resp in (put_chunk(r, uid, 0, DATA[:4]), r.get(f"/api/uploads/{uid}"),
                 r.delete(f"/api/uploads/{uid}")):
        assert resp.status_code == 404


def test_non_hex_upload_id_is_404(pair):
    a, _ = pair
    for bad in ("..%2f..%2fapp.db", "ZZZ", "a" * 31):
        assert a.get(f"/api/uploads/{bad}").status_code == 404
        assert put_chunk(a, bad, 0, b"abcd").status_code == 404


def test_batch_fields_rejected_here(pair):
    a, r = pair
    resp = start_upload(a, DATA, recipients=[r.me["id"]], batch_id="a" * 32, relative_path="x")
    assert resp.status_code == 400 and resp.json()["detail"] == "use_batch_files"


def test_global_account_may_only_upload_global(chunk4, client, make_client):
    r = login(make_client(), "rahim@southerniot.net")
    client.post("/api/auth/login",
                json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert start_upload(client, DATA, recipients=[r.me["id"]]).status_code == 403
    assert start_upload(client, DATA, is_global=True).status_code == 201


def test_signed_out_mid_upload_then_resume(pair):
    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]], client_key="trip").json()["upload_id"]
    put_chunk(a, uid, 0, DATA[:4])
    a.post("/api/auth/logout")
    assert put_chunk(a, uid, 1, DATA[4:8]).status_code == 401
    login(a, "ayman@southerniot.net")
    again = start_upload(a, DATA, recipients=[r.me["id"]], client_key="trip")
    assert again.status_code == 200 and again.json()["received"] == [0]


def test_name_and_mime_are_cleaned(pair, db_session):
    from app.models import Upload

    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]], name="evil‮txt.exe",
                       client_key="evil", mime="text/html; charset=x").json()["upload_id"]
    up = db_session.get(Upload, uid)
    assert up.name == "eviltxt.exe" and up.mime == "application/octet-stream"
    bad = start_upload(a, DATA, recipients=[r.me["id"]], name="a/b", client_key="slash")
    assert bad.status_code == 400 and bad.json()["detail"] == "bad_path"


def test_short_pwrite_is_completed_not_ignored(pair, app_settings, monkeypatch):
    """Review fix: os.pwrite may write fewer bytes than asked; the rest must still be written."""
    import app.transfers as transfers

    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    real = transfers.os.pwrite

    def one_byte_at_a_time(fd, data, offset):
        return real(fd, bytes(data[:1]), offset)

    monkeypatch.setattr(transfers.os, "pwrite", one_byte_at_a_time)
    send_all(a, uid, DATA, 4)
    assert _tmp(app_settings, uid).read_bytes()[:10] == DATA


def test_pwrite_writing_nothing_is_disk_full(pair, monkeypatch):
    import app.transfers as transfers

    a, r = pair
    uid = start_upload(a, DATA, recipients=[r.me["id"]]).json()["upload_id"]
    monkeypatch.setattr(transfers.os, "pwrite", lambda fd, data, offset: 0)
    resp = put_chunk(a, uid, 0, DATA[:4])
    assert resp.status_code == 507 and resp.json()["detail"] == "disk_full"
    assert a.get(f"/api/uploads/{uid}").json()["received"] == []
