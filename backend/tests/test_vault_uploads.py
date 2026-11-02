from datetime import timedelta

import pytest

from app.db import utcnow
from app.storage import storage_path
from tests.conftest import TEST_SHARED_PASSWORD, put_chunk, start_upload
from tests.vault_helpers import b64, owner, start_vault, vault_blob


@pytest.fixture
def small_vault(monkeypatch, chunk4):
    monkeypatch.setenv("VAULT_QUOTA", str(300_000))


def test_vault_upload_roundtrip(chunk4, client, app_settings, db_session):
    from app.models import Item, Upload

    gen = owner(client)
    blob = vault_blob(client, b"0123456789", gen)
    assert storage_path(app_settings.data_dir, "vault", blob).read_bytes() == b"0123456789"
    assert not storage_path(app_settings.data_dir, "files", blob).exists()
    assert db_session.query(Item).count() == 0
    assert db_session.get(Upload, blob).item_id is None


def test_vault_upload_stores_no_name_or_mime(chunk4, client, db_session):
    from app.models import Upload

    gen = owner(client)
    blob = vault_blob(client, b"0123456789", gen)
    up = db_session.get(Upload, blob)
    assert (up.name, up.mime, up.target) == ("blob", "application/octet-stream", "vault")


def test_vault_complete_idempotent(chunk4, client):
    gen = owner(client)
    r = start_vault(client, 4, gen)
    uid = r.json()["upload_id"]
    put_chunk(client, uid, 0, b"abcd")
    first = client.post(f"/api/uploads/{uid}/complete")
    again = client.post(f"/api/uploads/{uid}/complete")
    assert (first.status_code, again.status_code) == (201, 200)
    assert first.json() == again.json() == {"blob_id": uid, "size": 4}


def test_vault_upload_never_resumes_other_ciphertext(chunk4, client):
    gen = owner(client)
    share = start_upload(client, b"0123", client_key="same", is_global=True)
    vault = start_vault(client, 4, gen, client_key="same")
    assert vault.status_code == 201 and vault.json()["upload_id"] != share.json()["upload_id"]


def test_vault_upload_refused_over_quota_before_bytes(small_vault, client, db_session):
    from app.models import Upload

    gen = owner(client)
    r = start_vault(client, 300_000 - 65536 + 1, gen)
    assert r.status_code == 507 and r.json()["detail"] == "vault_full"
    assert db_session.query(Upload).count() == 0


def test_vault_quota_counts_reserved_and_unattached(small_vault, client):
    gen = owner(client)
    start_vault(client, 100_000, gen)  # reserved: 100,000 + 65,536
    vault_blob(client, b"0123456789", gen)  # unattached: 10 + 65,536
    assert client.get("/api/vault").json()["used_bytes"] == 100_000 + 10 + 2 * 65_536


def test_cancel_vault_upload_frees_quota(small_vault, client):
    gen = owner(client)
    uid = start_vault(client, 100_000, gen).json()["upload_id"]
    assert client.delete(f"/api/uploads/{uid}").status_code == 204
    assert client.get("/api/vault").json()["used_bytes"] == 0


def test_delete_unattached_vault_upload(chunk4, client, app_settings):
    gen = owner(client)
    blob = vault_blob(client, b"0123456789", gen)
    assert client.delete(f"/api/uploads/{blob}").status_code == 204
    assert not storage_path(app_settings.data_dir, "vault", blob).exists()
    assert client.get("/api/vault").json()["used_bytes"] == 0


def test_attached_blob_cannot_be_deleted_as_upload(chunk4, client):
    gen = owner(client)
    blob = vault_blob(client, b"0123456789", gen)
    client.post("/api/vault/items", json={"meta_ct": b64(9), "blob_id": blob, "key_gen": gen})
    assert client.delete(f"/api/uploads/{blob}").status_code == 409


def test_attach_over_quota_is_refused_and_blob_can_be_freed(small_vault, client):
    gen = owner(client)
    blob = vault_blob(client, b"0123456789", gen)
    big = client.post(
        "/api/vault/items",
        json={
            "meta_ct": "A" * 300_000,  # 300,010 > 300,000
            "blob_id": blob,
            "key_gen": gen,
        },
    )
    assert big.status_code in (413, 507)
    assert client.delete(f"/api/uploads/{blob}").status_code == 204


def test_vault_upload_rejects_recipients(chunk4, client, make_client):
    gen = owner(client)
    r = start_vault(client, 4, gen, recipient_ids=[1])
    assert r.status_code == 400 and r.json()["detail"] == "bad_target"
    r = start_vault(client, 4, gen, is_global=True)
    assert r.status_code == 400 and r.json()["detail"] == "bad_target"


def test_vault_upload_before_setup_404(chunk4, client):
    from tests.conftest import login

    login(client, "nosetup@southerniot.net")
    r = start_vault(client, 4, "0" * 16)
    assert r.status_code == 404 and r.json()["detail"] == "not_initialized"


def test_vault_upload_with_old_key_gen_409(chunk4, client):
    owner(client)
    r = start_vault(client, 4, "0" * 16)
    assert r.status_code == 409 and r.json()["detail"] == "key_changed"


def test_global_account_cannot_upload_to_vault(chunk4, client):
    client.post(
        "/api/auth/login",
        json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD},
    )
    r = start_vault(client, 4, "0" * 16)
    assert r.status_code == 403 and r.json()["detail"] == "global_account"


def test_idle_vault_upload_cancelled_when_new_one_starts(small_vault, client, db_session):
    from app.models import Upload

    gen = owner(client)
    old = start_vault(client, 150_000, gen).json()["upload_id"]
    db_session.get(Upload, old).updated_at = utcnow() - timedelta(minutes=6)  # the tab was reloaded
    db_session.commit()
    new = start_vault(client, 150_000, gen)
    assert new.status_code == 201
    db_session.expire_all()
    assert db_session.get(Upload, old) is None


def test_recent_vault_upload_is_not_cancelled(small_vault, client, db_session):
    from app.models import Upload

    gen = owner(client)
    live = start_vault(client, 100_000, gen).json()["upload_id"]  # another tab, still sending
    start_vault(client, 10, gen)
    db_session.expire_all()
    assert db_session.get(Upload, live) is not None


def test_release_held_spares_active_upload(small_vault, client, db_session):
    from app.models import Upload

    gen = owner(client)
    quiet = start_vault(client, 100_000, gen).json()["upload_id"]
    active = start_vault(client, 10_000, gen).json()["upload_id"]
    db_session.get(Upload, quiet).updated_at = utcnow() - timedelta(seconds=40)
    db_session.commit()
    assert client.get("/api/vault").json()["held_bytes"] == 100_000 + 65_536
    r = client.post("/api/vault/release-held")
    assert r.status_code == 200 and r.json() == {"released_bytes": 100_000 + 65_536}
    db_session.expire_all()
    assert db_session.get(Upload, quiet) is None and db_session.get(Upload, active) is not None


def test_unattached_blob_swept_after_24h(chunk4, client, app_settings, db_session):
    from app.jobs import run_cleanup
    from app.models import Upload

    gen = owner(client)
    blob = vault_blob(client, b"0123456789", gen)
    db_session.get(Upload, blob).updated_at = utcnow() - timedelta(hours=25)
    db_session.commit()
    run_cleanup(db_session, app_settings, utcnow())
    db_session.expire_all()
    assert db_session.get(Upload, blob) is None
    assert not storage_path(app_settings.data_dir, "vault", blob).exists()


def test_attached_blob_survives_cleanup(chunk4, client, app_settings, db_session):
    from app.jobs import run_cleanup
    from app.models import Upload

    gen = owner(client)
    blob = vault_blob(client, b"0123456789", gen)
    client.post("/api/vault/items", json={"meta_ct": b64(9), "blob_id": blob, "key_gen": gen})
    db_session.get(Upload, blob).updated_at = utcnow() - timedelta(days=40)
    db_session.commit()
    run_cleanup(db_session, app_settings, utcnow() + timedelta(days=40))
    assert storage_path(app_settings.data_dir, "vault", blob).exists()


def test_orphan_sweep_covers_vault(chunk4, client, app_settings, db_session):
    import os

    from app.jobs import sweep_orphans

    gen = owner(client)
    kept = vault_blob(client, b"0123456789", gen)
    stray = storage_path(app_settings.data_dir, "vault", "ab" + "0" * 30)
    stray.parent.mkdir(parents=True, exist_ok=True)
    stray.write_bytes(b"x")
    old = (utcnow() - timedelta(days=2)).timestamp()
    os.utime(stray, (old, old))
    os.utime(storage_path(app_settings.data_dir, "vault", kept), (old, old))
    sweep_orphans(db_session, app_settings, utcnow() - timedelta(days=1))
    assert not stray.exists()
    assert storage_path(app_settings.data_dir, "vault", kept).exists()


def test_erase_during_complete_leaves_no_file(
    chunk4, client, app_settings, db_session, monkeypatch
):
    """Erase takes the upload locks: a running complete finishes, then erase removes it all."""
    import time
    from concurrent.futures import ThreadPoolExecutor

    import app.routers.uploads as uploads_router
    from app.models import Upload
    from tests.vault_helpers import OWN

    gen = owner(client)
    uid = start_vault(client, 4, gen).json()["upload_id"]
    put_chunk(client, uid, 0, b"abcd")
    real = uploads_router.finalize_file

    def slow_finalize(*args, **kwargs):
        time.sleep(0.4)  # the erase arrives while the file is being moved
        return real(*args, **kwargs)

    monkeypatch.setattr(uploads_router, "finalize_file", slow_finalize)
    # one client from two threads: one event loop, like production (one uvicorn worker)
    with ThreadPoolExecutor(2) as pool:
        done = pool.submit(client.post, f"/api/uploads/{uid}/complete")
        time.sleep(0.1)
        erase = pool.submit(
            client.post, "/api/vault/erase", json={"confirm": "ERASE", "login_password": OWN}
        )
        assert done.result().status_code == 201
        assert erase.result().status_code == 204
    db_session.expire_all()
    assert db_session.get(Upload, uid) is None
    assert not storage_path(app_settings.data_dir, "vault", uid).exists()
    assert not storage_path(app_settings.data_dir, "tmp", uid).exists()
