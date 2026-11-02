import base64
import os

import pytest

from tests.conftest import TEST_SHARED_PASSWORD, login

OWN = "own-login-pass-1"


def b64(n: int) -> str:
    return base64.b64encode(os.urandom(n)).decode()


def key_body(**over):
    body = {"salt": b64(16), "iterations": 600_000, "wrapped_key": b64(61)}
    body.update(over)
    return body


def owner(client, email="vowner@southerniot.net"):
    """A user who has set their own login password (My storage needs it)."""
    login(client, email)
    r = client.post(
        "/api/auth/password", json={"current_password": TEST_SHARED_PASSWORD, "new_password": OWN}
    )
    assert r.status_code == 204, r.text
    return client


def setup_vault(client):
    body = key_body()
    assert client.post("/api/vault/setup", json=body).status_code == 204
    return body


def test_status_before_setup(client):
    owner(client)
    r = client.get("/api/vault")
    assert r.status_code == 200
    assert r.json() == {
        "initialized": False,
        "salt": None,
        "iterations": None,
        "wrapped_key": None,
        "key_gen": None,
        "kdf": "pbkdf2-sha256",
        "used_bytes": 0,
        "quota_bytes": 209715200,
        "item_count": 0,
        "held_bytes": 0,
    }


def test_setup_then_status(client):
    owner(client)
    body = setup_vault(client)
    st = client.get("/api/vault").json()
    assert st["initialized"] is True
    assert (st["salt"], st["iterations"], st["wrapped_key"]) == (
        body["salt"],
        600_000,
        body["wrapped_key"],
    )
    assert len(st["key_gen"]) == 16


def test_setup_twice_409(client):
    owner(client)
    setup_vault(client)
    r = client.post("/api/vault/setup", json=key_body())
    assert r.status_code == 409 and r.json()["detail"] == "already_initialized"


def test_setup_needs_own_login_password(client):
    login(client, "shared@southerniot.net")  # still on the shared starting password
    r = client.post("/api/vault/setup", json=key_body())
    assert r.status_code == 403 and r.json()["detail"] == "own_password_required"
    assert client.get("/api/vault").json()["initialized"] is False


def test_key_change_needs_previous(client):
    owner(client)
    first = setup_vault(client)
    gen = client.get("/api/vault").json()["key_gen"]
    new = key_body()
    bad = client.put("/api/vault/key", json={**new, "previous_wrapped_key": b64(61)})
    assert bad.status_code == 409 and bad.json()["detail"] == "stale_key"
    ok = client.put("/api/vault/key", json={**new, "previous_wrapped_key": first["wrapped_key"]})
    assert ok.status_code == 204
    st = client.get("/api/vault").json()
    assert (st["salt"], st["wrapped_key"]) == (new["salt"], new["wrapped_key"])
    assert st["key_gen"] == gen  # same data key, only re-wrapped


def test_key_change_before_setup_404(client):
    owner(client)
    r = client.put("/api/vault/key", json={**key_body(), "previous_wrapped_key": b64(61)})
    assert r.status_code == 404 and r.json()["detail"] == "not_initialized"


def test_erase_requires_word_and_login_password(client):
    owner(client)
    setup_vault(client)
    assert (
        client.post("/api/vault/erase", json={"confirm": "erase", "login_password": OWN}).json()[
            "detail"
        ]
        == "confirm_required"
    )
    wrong = client.post(
        "/api/vault/erase", json={"confirm": "ERASE", "login_password": "nope-nope-nope"}
    )
    assert wrong.status_code == 401 and wrong.json()["detail"] == "bad_credentials"
    assert client.get("/api/vault").json()["initialized"] is True


def test_erase_removes_items_blobs_uploads_key(client, app_settings, db_session, make_vault_item):
    from app.models import AuditLog, Upload, User, VaultItem
    from app.storage import storage_path

    owner(client)
    setup_vault(client)
    user = db_session.get(User, client.me["id"])
    item = make_vault_item(user)
    blob = storage_path(app_settings.data_dir, "vault", item.id)
    blob.parent.mkdir(parents=True, exist_ok=True)
    blob.write_bytes(b"ct")
    item.blob_id = item.id
    db_session.add(
        Upload(
            id="a" * 32,
            user_id=user.id,
            target="vault",
            client_key="vault:x",
            name="blob",
            size=10,
            mime="application/octet-stream",
            chunk_size=4,
            received=[0],
            received_bytes=4,
            recipient_ids=[],
            is_global=False,
        )
    )
    db_session.commit()
    tmp = storage_path(app_settings.data_dir, "tmp", "a" * 32)
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(b"part")

    r = client.post("/api/vault/erase", json={"confirm": "ERASE", "login_password": OWN})
    assert r.status_code == 204
    db_session.expire_all()
    assert db_session.query(VaultItem).count() == 0
    assert db_session.query(Upload).filter_by(target="vault").count() == 0
    assert not blob.exists() and not tmp.exists()
    assert client.get("/api/vault").json()["initialized"] is False
    assert db_session.query(AuditLog).filter_by(actor_id=user.id, action="vault_erase").count() == 1


def test_key_change_is_audited(client, db_session):
    from app.models import AuditLog

    owner(client)
    first = setup_vault(client)
    client.put("/api/vault/key", json={**key_body(), "previous_wrapped_key": first["wrapped_key"]})
    assert db_session.query(AuditLog).filter_by(action="vault_key_change").count() == 1


def test_vault_forbidden_for_global_account(client):
    r = client.post(
        "/api/auth/login",
        json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD},
    )
    assert r.status_code == 200
    calls = [
        ("get", "/api/vault", None),
        ("post", "/api/vault/setup", key_body()),
        ("put", "/api/vault/key", {**key_body(), "previous_wrapped_key": b64(61)}),
        ("post", "/api/vault/erase", {"confirm": "ERASE", "login_password": "x"}),
    ]
    for method, path, body in calls:
        r = getattr(client, method)(path, json=body) if body else getattr(client, method)(path)
        assert r.status_code == 403 and r.json()["detail"] == "global_account", path


@pytest.mark.parametrize(
    "over",
    [
        {"iterations": 100_000},
        {"iterations": 6_000_000},
        {"salt": b64(8)},
        {"salt": "not base64!"},
        {"wrapped_key": b64(10)},
        {"wrapped_key": b64(300)},
    ],
)
def test_setup_rejects_weak_or_bad_values(client, over):
    owner(client)
    assert client.post("/api/vault/setup", json=key_body(**over)).status_code == 422


def test_vault_needs_csrf_header(client, make_client):
    owner(client)
    bare = make_client()
    bare.cookies = client.cookies
    r = bare.post("/api/vault/setup", json=key_body(), headers={"X-Requested-With": ""})
    assert r.status_code == 403
