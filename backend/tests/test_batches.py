from datetime import UTC, datetime, timedelta

import pytest

from app.storage import storage_path
from tests.conftest import login, put_chunk, register_files, send_all, start_batch

FILES = [("app.hex", b"0123456789"), ("config/gw.json", b"{}"), ("empty.txt", b"")]


@pytest.fixture
def pair(chunk4, client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    return a, r


def _upload_all(a, batch_id, files):
    reg = register_files(a, batch_id, files)
    assert reg.status_code == 201, reg.text
    by_path = {u["relative_path"]: u for u in reg.json()["uploads"]}
    for path, data in files:
        send_all(a, by_path[path]["upload_id"], data, 4)
    return by_path


def test_folder_round_trip(pair):
    a, r = pair
    bid = start_batch(a, name="firmware-v3.2", file_count=3,
                      recipients=[r.me["id"]]).json()["batch_id"]
    _upload_all(a, bid, FILES)
    done = a.post(f"/api/batches/{bid}/complete")
    assert done.status_code == 201, done.text
    item, failed = done.json()["item"], done.json()["failed"]
    assert failed == [] and item["kind"] == "folder" and item["file_count"] == 3
    assert item["size"] == 12 and item["name"] == "firmware-v3.2"
    entries = r.get(f"/api/items/{item['id']}/entries").json()
    assert [e["relative_path"] for e in entries] == ["app.hex", "config/gw.json", "empty.txt"]
    assert r.get(f"/api/items/{item['id']}/entries/{entries[1]['id']}/download").status_code == 200


def test_batch_files_complete_by_themselves(pair, db_session, app_settings):
    from app.models import Upload

    a, r = pair
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    uid = _upload_all(a, bid, [("one.bin", b"abcdefgh")])["one.bin"]["upload_id"]
    db_session.expire_all()
    up = db_session.get(Upload, uid)
    assert up.completed_at is not None and up.storage_id == uid
    assert storage_path(app_settings.data_dir, "files", uid).read_bytes() == b"abcdefgh"


def test_partial_batch_reports_failed(pair):
    a, r = pair
    bid = start_batch(a, file_count=3, recipients=[r.me["id"]]).json()["batch_id"]
    reg = register_files(a, bid, [("a.txt", b"aaaa"), ("b.txt", b"bbbb"), ("c.txt", b"cccccccc")])
    ups = {u["relative_path"]: u["upload_id"] for u in reg.json()["uploads"]}
    put_chunk(a, ups["a.txt"], 0, b"aaaa")
    put_chunk(a, ups["b.txt"], 0, b"bbbb")
    put_chunk(a, ups["c.txt"], 0, b"cccc")  # 1 of 2 chunks only
    done = a.post(f"/api/batches/{bid}/complete").json()
    assert done["failed"] == ["c.txt"] and done["item"]["file_count"] == 2


def test_batch_complete_retry_returns_same_item_and_failed(pair):
    a, r = pair
    bid = start_batch(a, file_count=2, recipients=[r.me["id"]]).json()["batch_id"]
    reg = register_files(a, bid, [("a.txt", b"aaaa"), ("b.txt", b"bbbb")])
    put_chunk(a, reg.json()["uploads"][0]["upload_id"], 0, b"aaaa")
    first = a.post(f"/api/batches/{bid}/complete").json()
    again = a.post(f"/api/batches/{bid}/complete")
    assert again.status_code == 200 and again.json() == first and first["failed"] == ["b.txt"]


def test_empty_batch_refused(pair):
    a, r = pair
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    register_files(a, bid, [("x.bin", b"abcd")])
    resp = a.post(f"/api/batches/{bid}/complete")
    assert resp.status_code == 400 and resp.json()["detail"] == "empty_batch"


def test_duplicate_completed_path_and_replaced_unfinished(pair):
    a, r = pair
    bid = start_batch(a, file_count=2, recipients=[r.me["id"]]).json()["batch_id"]
    _upload_all(a, bid, [("done.txt", b"abcd")])
    other = {"files": [{"relative_path": "done.txt", "size": 9, "mime": "x/y",
                        "client_key": "different-file"}]}
    dup = a.post(f"/api/batches/{bid}/files", json=other)  # a DIFFERENT file at a finished path
    assert dup.status_code == 409 and dup.json()["detail"] == "duplicate_path"
    first = register_files(a, bid, [("edit.txt", b"aaaa")]).json()["uploads"][0]
    body = {"files": [{"relative_path": "edit.txt", "size": 8, "mime": "x/y",
                       "client_key": "edited"}]}
    second = a.post(f"/api/batches/{bid}/files", json=body).json()["uploads"][0]
    assert second["upload_id"] != first["upload_id"]
    assert a.get(f"/api/uploads/{first['upload_id']}").status_code == 404


def test_same_request_duplicate_paths_refused(pair):
    a, r = pair
    bid = start_batch(a, file_count=3, recipients=[r.me["id"]]).json()["batch_id"]
    resp = register_files(a, bid, [("x.txt", b"a"), ("x.txt", b"b")])
    assert resp.status_code == 409 and resp.json()["detail"] == "duplicate_path"


def test_registration_resumes(pair):
    a, r = pair
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    first = register_files(a, bid, [("big.bin", b"abcdefgh")]).json()["uploads"][0]
    put_chunk(a, first["upload_id"], 0, b"abcd")
    again = register_files(a, bid, [("big.bin", b"abcdefgh")]).json()["uploads"][0]
    assert again["upload_id"] == first["upload_id"] and again["received"] == [0]


def test_batch_full_and_closed(pair):
    a, r = pair
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    _upload_all(a, bid, [("a.txt", b"abcd")])
    full = register_files(a, bid, [("b.txt", b"abcd")])
    assert full.status_code == 409 and full.json()["detail"] == "batch_full"
    a.post(f"/api/batches/{bid}/complete")
    closed = register_files(a, bid, [("c.txt", b"abcd")])
    assert closed.status_code == 409 and closed.json()["detail"] == "batch_closed"


def test_batch_limits(client, make_client, app_settings):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    assert start_batch(a, file_count=0, recipients=[r.me["id"]]).json()["detail"] == "empty"
    too_many = start_batch(a, file_count=app_settings.max_batch_files + 1, recipients=[r.me["id"]])
    assert too_many.json()["detail"] == "too_many_files"
    assert start_batch(a, recipients=[]).json()["detail"] == "no_recipients"
    many = register_files(a, start_batch(a, file_count=600, recipients=[r.me["id"]])
                          .json()["batch_id"], [(f"f{i}", b"a") for i in range(501)])
    assert many.status_code == 422  # at most 500 files per registration call


@pytest.mark.parametrize("bad", ["../x", "/etc/x", "a//b", "C:\\x", "a/../b"])
def test_bad_paths_refused(pair, bad):
    a, r = pair
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    resp = register_files(a, bid, [(bad, b"abcd")])
    assert resp.status_code == 400 and resp.json()["detail"] == "bad_path"


def test_nfd_and_bidi_paths_cleaned(pair):
    a, r = pair
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    reg = register_files(a, bid, [("Cafe\u0301/a\u202Eb.txt", b"abcd")]).json()
    assert reg["uploads"][0]["relative_path"] == "Caf\u00e9/ab.txt"


def test_another_users_batch_is_404_everywhere(pair, make_client):
    a, r = pair
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    assert register_files(r, bid, [("x", b"a")]).status_code == 404
    assert r.post(f"/api/batches/{bid}/complete").status_code == 404
    assert r.post("/api/batches/ZZ/complete").status_code == 404


def test_global_account_batches_only_global(chunk4, client, make_client):
    from tests.conftest import TEST_SHARED_PASSWORD

    r = login(make_client(), "rahim@southerniot.net")
    client.post("/api/auth/login",
                json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert start_batch(client, recipients=[r.me["id"]]).status_code == 403
    assert start_batch(client, is_global=True).status_code == 201


def test_stale_batch_cleanup_removes_completed_files_too(pair, db_session, app_settings):
    from app.jobs import run_cleanup
    from app.models import Batch, Upload

    a, r = pair
    bid = start_batch(a, file_count=2, recipients=[r.me["id"]]).json()["batch_id"]
    ups = _upload_all(a, bid, [("a.txt", b"abcd")])
    done_file = storage_path(app_settings.data_dir, "files", ups["a.txt"]["upload_id"])
    assert done_file.exists()
    old = datetime.now(UTC) - timedelta(hours=25)
    db_session.get(Batch, bid).updated_at = old
    for up in db_session.query(Upload).filter_by(batch_id=bid):
        up.updated_at = old
    db_session.commit()
    run_cleanup(db_session, app_settings, datetime.now(UTC))
    db_session.expire_all()
    assert db_session.get(Batch, bid) is None and not done_file.exists()
    assert db_session.query(Upload).filter_by(batch_id=bid).count() == 0


def test_batch_complete_waits_for_a_chunk_in_flight(pair, app_settings, monkeypatch):
    """Review fix: completing a batch while a file's last chunk is being recorded must not 500
    or leave an orphan; the file ends up either in the folder or in `failed`, consistently."""
    import threading
    import time

    import app.transfers as transfers

    a, r = pair
    bid = start_batch(a, file_count=2, recipients=[r.me["id"]]).json()["batch_id"]
    ups = _upload_all(a, bid, [("done.txt", b"abcd")])
    slow = register_files(a, bid, [("slow.bin", b"abcdefgh")]).json()["uploads"][0]
    put_chunk(a, slow["upload_id"], 0, b"abcd")
    real_now = transfers.utcnow

    def slow_now():  # widen the window inside the chunk bookkeeping
        time.sleep(0.3)
        return real_now()

    monkeypatch.setattr(transfers, "utcnow", slow_now)
    results = {}

    def last_chunk():
        results["put"] = put_chunk(a, slow["upload_id"], 1, b"efgh").status_code

    t = threading.Thread(target=last_chunk)
    t.start()
    time.sleep(0.1)  # the chunk is now inside its bookkeeping
    done = a.post(f"/api/batches/{bid}/complete")
    t.join()
    assert done.status_code == 201, done.text
    assert results["put"] in (204, 404, 409)
    body = done.json()
    names_in_folder = done.json()["item"]["file_count"]
    assert names_in_folder + len(body["failed"]) == 2
    stored = storage_path(app_settings.data_dir, "files", slow["upload_id"])
    if "slow.bin" in body["failed"]:
        assert not stored.exists()  # no orphan
    else:
        assert stored.exists() and names_in_folder == 2
    assert ups  # keeps the first file's registration referenced


def test_retrying_registration_after_files_finished_is_not_a_conflict(pair):
    """Review fix: a lost response + retry (or a page reload mid-folder) must not 409."""
    a, r = pair
    bid = start_batch(a, file_count=2, recipients=[r.me["id"]]).json()["batch_id"]
    files = [("empty.txt", b""), ("a.bin", b"abcdefgh")]
    first = register_files(a, bid, files).json()["uploads"]
    by_path = {u["relative_path"]: u for u in first}
    send_all(a, by_path["a.bin"]["upload_id"], b"abcdefgh", 4)
    again = register_files(a, bid, files)
    assert again.status_code == 201, again.text
    by_path2 = {u["relative_path"]: u for u in again.json()["uploads"]}
    assert by_path2["a.bin"]["upload_id"] == by_path["a.bin"]["upload_id"]
    assert by_path2["a.bin"]["received"] == [0, 1] and by_path2["empty.txt"]["received"] == []
    assert a.post(f"/api/batches/{bid}/complete").json()["item"]["file_count"] == 2


def test_chunks_keep_a_batch_alive(pair, db_session, app_settings):
    """Review fix: a slow single file inside a folder must not be cleaned up mid-transfer."""
    from app.jobs import run_cleanup
    from app.models import Batch

    a, r = pair
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    up = register_files(a, bid, [("huge.bin", b"abcdefgh")]).json()["uploads"][0]
    db_session.get(Batch, bid).updated_at = datetime.now(UTC) - timedelta(hours=25)
    db_session.commit()
    put_chunk(a, up["upload_id"], 0, b"abcd")  # still uploading
    run_cleanup(db_session, app_settings, datetime.now(UTC))
    db_session.expire_all()
    assert db_session.get(Batch, bid) is not None
