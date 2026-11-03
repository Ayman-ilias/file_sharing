"""The 15 minor review findings from plans 1 and 2 (owner: "fix all", 2026-11-02)."""

import os
import re
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.storage import storage_path
from tests.conftest import (
    TEST_SHARED_PASSWORD,
    login,
    put_chunk,
    register_files,
    send_all,
    start_batch,
    start_upload,
)

# --- plan 1 -----------------------------------------------------------------------------

def test_p1_login_always_runs_one_argon2(client, monkeypatch):
    """#1 timing: shared-password users must cost the same as unknown emails."""
    import app.routers.auth as auth

    calls = []
    real = auth.verify_password
    monkeypatch.setattr(auth, "verify_password", lambda h, p: calls.append(1) or real(h, p))
    client.post("/api/auth/register", json={"email": "t@southerniot.net"})
    client.post("/api/auth/login", json={"email": "t@southerniot.net",
                                         "password": TEST_SHARED_PASSWORD})
    assert len(calls) == 1


def test_p1_naive_cursor_is_400(client):
    """#2: a crafted cursor with a naive timestamp gave 500."""
    import base64

    login(client, "a@southerniot.net")
    raw = base64.urlsafe_b64encode(b"2026-01-01T00:00:00|abc").decode().rstrip("=")
    resp = client.get(f"/api/items?section=global&before={raw}")
    assert resp.status_code == 400 and resp.json()["detail"] == "bad_cursor"


def test_p1_500_has_security_headers(app):
    """#3: crashes bypassed the security headers."""
    from fastapi.testclient import TestClient

    @app.get("/api/__boom")
    def boom():
        raise RuntimeError("boom")

    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/__boom")
    assert r.status_code == 500 and r.json() == {"detail": "server_error"}
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"


def test_p1_delete_survives_unlink_error(client, file_item, monkeypatch, db_session):
    """#4: an unlink error after the row was deleted gave 500 and an orphan."""
    import app.routers.items as items
    from app.models import Item

    def broken(*_a, **_k):
        raise PermissionError("disk says no")

    monkeypatch.setattr(items, "remove_stored", broken)
    item_id = file_item.id
    assert client.delete(f"/api/items/{item_id}").status_code == 204
    db_session.expire_all()
    assert db_session.get(Item, item_id) is None  # the orphan sweep removes the file later


def test_p1_concurrent_register_never_500(app):
    """#5: two simultaneous registrations of one email raised IntegrityError."""
    from fastapi.testclient import TestClient

    codes = []
    with TestClient(app, headers={"X-Requested-With": "fs"}) as c:
        def go():
            codes.append(c.post("/api/auth/register",
                                json={"email": "race@southerniot.net"}).status_code)

        threads = [threading.Thread(target=go) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert sorted(set(codes)) <= [200, 201] and codes.count(201) == 1


def test_p1_password_length_capped(client):
    """#6: Argon2 ran over any length before sign-in."""
    r = client.post("/api/auth/login", json={"email": "x@southerniot.net",
                                             "password": "a" * 1025})
    assert r.status_code == 422
    login(client, "y@southerniot.net")
    r = client.post("/api/auth/password", json={"current_password": TEST_SHARED_PASSWORD,
                                                "new_password": "b" * 1025})
    assert r.status_code == 422


def test_p1_expired_sessions_purged(client, db_session, app_settings):
    """#7: expired session rows were never deleted."""
    from app.jobs import run_cleanup
    from app.models import AuthSession

    login(client, "s@southerniot.net")
    for s in db_session.query(AuthSession).all():
        s.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    run_cleanup(db_session, app_settings, datetime.now(UTC))
    assert db_session.query(AuthSession).count() == 0


def test_p1_migrations_do_not_import_app_code():
    """#8: migrations importing app.db break when the app code moves on."""
    versions = Path(__file__).resolve().parent.parent / "migrations" / "versions"
    for f in versions.glob("*.py"):
        assert not re.search(r"^\s*(import app|from app)", f.read_text(), re.M), f.name
        assert "app.db." not in f.read_text(), f.name


# --- plan 2 -----------------------------------------------------------------------------

def test_p2_upload_locks_stay_bounded():
    """#9 + #10: lock entries leaked; a dropped lock could split waiters."""
    import asyncio

    from app.transfers import UploadLocks

    locks = UploadLocks(max_idle=50)
    held = locks.get("held")

    async def hold_and_churn():
        async with held:
            locks.drop("held")
            assert locks.get("held") is held  # never replaced while someone holds it
            for i in range(500):
                locks.get(f"u{i}")

    asyncio.run(hold_and_churn())
    assert locks.size() <= 51


def test_p2_quota_check_is_atomic(chunk4, client, make_client, monkeypatch, app):
    """#11: concurrent starts could all pass the per-user count check."""
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    app.state.settings.max_user_uploads = 2
    import app.routers.uploads as uploads

    real = uploads.reserved_bytes

    def slow_reserved(*args, **kwargs):  # widen check-then-insert
        time.sleep(0.05)
        return real(*args, **kwargs)

    monkeypatch.setattr(uploads, "reserved_bytes", slow_reserved)
    codes = []

    def go(i):
        codes.append(start_upload(a, b"abcd", recipients=[r.me["id"]],
                                  client_key=f"race{i}").status_code)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert codes.count(201) == 2 and codes.count(429) == 4


def test_p2_resume_touches_updated_at(chunk4, client, make_client, db_session):
    """#12: resuming didn't refresh the idle clock."""
    from app.models import Upload

    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    uid = start_upload(a, b"abcdefgh", recipients=[r.me["id"]], client_key="t").json()["upload_id"]
    old = datetime.now(UTC) - timedelta(hours=23)
    db_session.get(Upload, uid).updated_at = old
    db_session.commit()
    start_upload(a, b"abcdefgh", recipients=[r.me["id"]], client_key="t")
    db_session.expire_all()
    assert db_session.get(Upload, uid).updated_at > old + timedelta(hours=22)


@pytest.mark.parametrize("bad", ["CON", "nul.txt", "dir/COM1.log", "trailing.", "a/LPT9",
                                 "/".join(["d"] * 33) + "/f"])
def test_p2_windows_unsafe_and_too_deep_paths(bad):
    """#13a: names Windows can't extract, and absurd depth."""
    from app.transfers import clean_relative_path

    with pytest.raises(ValueError):
        clean_relative_path(bad)


def test_p2_trailing_spaces_are_trimmed_not_refused():
    from app.transfers import clean_relative_path

    assert clean_relative_path(" a /b  ") == "a/b"


def test_p2_path_collisions_in_a_folder(chunk4, client, make_client):
    """#13b: case-only duplicates and a path used as both file and folder."""
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    bid = start_batch(a, file_count=5, recipients=[r.me["id"]]).json()["batch_id"]
    assert register_files(a, bid, [("A.txt", b"a"), ("a.txt", b"b")]).json()["detail"] == \
        "duplicate_path"
    resp = register_files(a, bid, [("docs", b"a"), ("docs/x.txt", b"b")])
    assert resp.status_code == 409 and resp.json()["detail"] == "path_conflict"
    register_files(a, bid, [("lib", b"a")])
    resp = register_files(a, bid, [("lib/x.txt", b"b")])  # against an earlier registration
    assert resp.status_code == 409 and resp.json()["detail"] == "path_conflict"


def test_p2_zip_with_missing_file_is_410(chunk4, client, make_client, app_settings):
    """#14: a stored file vanishing (e.g. expiry) made the zip route 500."""
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    bid = start_batch(a, file_count=1, recipients=[r.me["id"]]).json()["batch_id"]
    up = register_files(a, bid, [("x.bin", b"abcd")]).json()["uploads"][0]
    send_all(a, up["upload_id"], b"abcd", 4)
    item = a.post(f"/api/batches/{bid}/complete").json()["item"]
    os.remove(storage_path(app_settings.data_dir, "files", up["upload_id"]))
    resp = r.get(f"/api/items/{item['id']}/zip")
    assert resp.status_code == 410 and resp.json()["detail"] == "gone"


def test_p2_chunk_without_length_is_411(chunk4, client, make_client):
    """#15: chunked transfer encoding got a confusing 400."""
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    uid = start_upload(a, b"abcd", recipients=[r.me["id"]]).json()["upload_id"]

    def body():
        yield b"ab"
        yield b"cd"

    resp = a.put(f"/api/uploads/{uid}/chunks/0", content=body())
    assert resp.status_code == 411 and resp.json()["detail"] == "length_required"
    assert put_chunk(a, uid, 0, b"abcd").status_code == 204
