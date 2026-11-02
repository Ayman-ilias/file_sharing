from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.jobs import run_cleanup
from app.storage import storage_path

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)


def _write(data_dir, kind, sid):
    p = storage_path(data_dir, kind, sid)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x")
    return p


def test_cleanup_deletes_only_expired(db_session, app_settings, make_user, make_item):
    from app.models import Item

    u = make_user("a@southerniot.net")
    sid = uuid4().hex
    path = _write(app_settings.data_dir, "files", sid)
    old = make_item(u, kind="file", storage_id=sid, is_global=True,
                    expires_at=NOW - timedelta(minutes=1))
    fresh = make_item(u, is_global=True, expires_at=NOW + timedelta(days=1))
    old_id, fresh_id = old.id, fresh.id
    report = run_cleanup(db_session, app_settings, NOW)
    assert report.items_deleted == 1 and report.errors == 0
    db_session.expire_all()
    assert db_session.get(Item, old_id) is None and db_session.get(Item, fresh_id) is not None
    assert not path.exists()


def test_cleanup_continues_after_one_failure(db_session, app_settings, make_user, make_item,
                                             monkeypatch):
    import app.jobs as jobs
    from app.models import Item

    u = make_user("a@southerniot.net")
    bad_sid, good_sid = uuid4().hex, uuid4().hex
    _write(app_settings.data_dir, "files", bad_sid)
    good_path = _write(app_settings.data_dir, "files", good_sid)
    bad = make_item(u, kind="file", storage_id=bad_sid, is_global=True,
                    expires_at=NOW - timedelta(minutes=2))
    good = make_item(u, kind="file", storage_id=good_sid, is_global=True,
                     expires_at=NOW - timedelta(minutes=1))
    bad_id, good_id = bad.id, good.id
    real = jobs.remove_stored

    def flaky(data_dir, kind, sid):
        if sid == bad_sid:
            raise PermissionError("disk says no")
        real(data_dir, kind, sid)

    monkeypatch.setattr(jobs, "remove_stored", flaky)
    report = run_cleanup(db_session, app_settings, NOW)
    assert report.errors == 1 and report.items_deleted == 1
    db_session.expire_all()
    assert db_session.get(Item, good_id) is None and not good_path.exists()
    assert db_session.get(Item, bad_id) is not None  # kept, retried next hour


def test_cleanup_removes_stale_uploads_only(db_session, app_settings, make_user):
    from app.models import Upload

    u = make_user("a@southerniot.net")
    stale_id, recent_id, done_id = uuid4().hex, uuid4().hex, uuid4().hex
    stale_tmp = _write(app_settings.data_dir, "tmp", stale_id)
    recent_tmp = _write(app_settings.data_dir, "tmp", recent_id)
    common = dict(user_id=u.id, target="share", client_key="k", name="f", size=1, mime="x",
                  chunk_size=16)
    db_session.add_all([
        Upload(id=stale_id, created_at=NOW - timedelta(hours=25), **common),
        Upload(id=recent_id, created_at=NOW - timedelta(hours=1), **common),
        Upload(id=done_id, created_at=NOW - timedelta(days=3),
               completed_at=NOW - timedelta(days=3), **common),
    ])
    db_session.commit()
    report = run_cleanup(db_session, app_settings, NOW)
    assert report.uploads_deleted == 1
    db_session.expire_all()
    assert db_session.get(Upload, stale_id) is None and not stale_tmp.exists()
    assert db_session.get(Upload, recent_id) is not None and recent_tmp.exists()
    assert db_session.get(Upload, done_id) is not None


def test_cleanup_never_touches_vault(db_session, app_settings, make_user, make_vault_item):
    from app.models import VaultItem

    u = make_user("a@southerniot.net")
    v = make_vault_item(u)
    v.created_at = NOW - timedelta(days=400)
    db_session.commit()
    run_cleanup(db_session, app_settings, NOW)
    db_session.expire_all()
    assert db_session.get(VaultItem, v.id) is not None


def test_app_starts_and_stops_the_loop(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        assert app.state.cleanup_task is not None and not app.state.cleanup_task.done()
        c.get("/api/health")
    assert app.state.cleanup_task.done()
