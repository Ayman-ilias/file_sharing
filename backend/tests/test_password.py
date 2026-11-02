from tests.conftest import TEST_SHARED_PASSWORD, login

URL = "/api/auth/password"


def _change(client, current, new):
    return client.post(URL, json={"current_password": current, "new_password": new})


def test_change_password_then_old_one_stops_working(client):
    login(client, "c@southerniot.net")
    assert _change(client, TEST_SHARED_PASSWORD, "my-own-pass-1").status_code == 204
    assert client.get("/api/auth/me").json()["uses_shared_password"] is False
    client.post("/api/auth/logout")
    old = client.post("/api/auth/login",
                      json={"email": "c@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert old.status_code == 401
    new = client.post("/api/auth/login",
                      json={"email": "c@southerniot.net", "password": "my-own-pass-1"})
    assert new.status_code == 200


def test_short_password_rejected(client):
    login(client, "d@southerniot.net")
    r = _change(client, TEST_SHARED_PASSWORD, "short")
    assert r.status_code == 400 and r.json()["detail"] == "too_short"


def test_wrong_current_password(client):
    login(client, "e@southerniot.net")
    r = _change(client, "not-it", "long-enough-pass")
    assert r.status_code == 401 and r.json()["detail"] == "bad_credentials"


def test_global_cannot_change_password(client):
    r = client.post("/api/auth/login",
                    json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert r.status_code == 200
    r = _change(client, TEST_SHARED_PASSWORD, "long-enough-pass")
    assert r.status_code == 403 and r.json()["detail"] == "global_account"


def test_other_sessions_signed_out_current_kept(client, make_client):
    login(client, "f@southerniot.net")
    other = login(make_client(), "f@southerniot.net")
    assert _change(client, TEST_SHARED_PASSWORD, "brand-new-pass-1").status_code == 204
    assert other.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me").status_code == 200


def test_password_change_is_audited(client, db_session):
    from app.models import AuditLog

    login(client, "g@southerniot.net")
    _change(client, TEST_SHARED_PASSWORD, "brand-new-pass-1")
    rows = db_session.query(AuditLog).filter_by(action="password_change").all()
    assert len(rows) == 1 and rows[0].actor_id == client.me["id"]


def test_password_never_stored_in_plain_text(client, db_session):
    from app.models import User

    login(client, "h@southerniot.net")
    _change(client, TEST_SHARED_PASSWORD, "brand-new-pass-1")
    u = db_session.query(User).filter_by(email="h@southerniot.net").one()
    db_session.refresh(u)
    assert u.password_hash.startswith("$argon2id$") and "brand-new-pass-1" not in u.password_hash
