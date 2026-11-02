from datetime import UTC, datetime

import pytest

from tests.conftest import TEST_SHARED_PASSWORD, login


def test_register_then_login_with_shared_password(client):
    r = client.post("/api/auth/register", json={"email": "rahim@southerniot.net"})
    assert r.status_code == 201
    r = client.post("/api/auth/login",
                    json={"email": "rahim@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert r.status_code == 200 and r.json()["uses_shared_password"] is True
    assert "fs_session" in client.cookies
    me = client.get("/api/auth/me").json()
    assert me["username"] == "rahim" and me["email"] == "rahim@southerniot.net"
    assert me["is_global"] is False


def test_email_normalised(client):
    r = client.post("/api/auth/register", json={"email": " Rahim@SouthernIoT.net "})
    assert r.status_code == 201
    r = client.post("/api/auth/register", json={"email": "rahim@southerniot.net"})
    assert r.status_code == 200
    assert r.json() == {"email": "rahim@southerniot.net", "username": "rahim"}


@pytest.mark.parametrize("bad", [
    "rahim@gmail.com", "rahim@southerniot.net.evil.com", "rahim@evil-southerniot.net",
    "rahim@southerniot.net@x.com", "@southerniot.net", "rahim", "", "ra him@southerniot.net",
])
def test_foreign_domains_rejected(client, bad):
    r = client.post("/api/auth/register", json={"email": bad})
    assert r.status_code == 400 and r.json()["detail"] == "domain_not_allowed"


def test_global_email_cannot_register(client):
    r = client.post("/api/auth/register", json={"email": "Global@southerniot.net"})
    assert r.status_code == 400 and r.json()["detail"] == "reserved"


def test_global_account_logs_in_with_shared_password(client):
    r = client.post("/api/auth/login",
                    json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert r.status_code == 200 and r.json()["is_global"] is True


def test_global_account_seeded_once(client, app):
    from app.main import seed_global_user
    from app.models import User

    with app.state.session_factory() as db:
        seed_global_user(db, app.state.settings)
        assert db.query(User).filter_by(is_global=True).count() == 1


def test_wrong_password_and_unknown_user_look_the_same(client):
    client.post("/api/auth/register", json={"email": "a@southerniot.net"})
    r1 = client.post("/api/auth/login", json={"email": "a@southerniot.net", "password": "nope"})
    r2 = client.post("/api/auth/login", json={"email": "ghost@southerniot.net", "password": "nope"})
    assert r1.status_code == r2.status_code == 401 and r1.json() == r2.json()
    assert r1.json() == {"detail": "bad_credentials"}


def test_login_rate_limited(client):
    codes = [client.post("/api/auth/login",
                         json={"email": "x@southerniot.net", "password": "n"}).status_code
             for _ in range(11)]
    assert codes[:10] == [401] * 10 and codes[-1] == 429


def test_logout_invalidates_session(client):
    login(client, "b@southerniot.net")
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_me_without_session(raw_client):
    r = raw_client.get("/api/auth/me")
    assert r.status_code == 401 and r.json() == {"detail": "not_signed_in"}


def test_cookie_flags(client):
    client.post("/api/auth/register", json={"email": "c@southerniot.net"})
    r = client.post("/api/auth/login",
                    json={"email": "c@southerniot.net", "password": TEST_SHARED_PASSWORD})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie


def test_disabled_user_cannot_sign_in(client, db_session):
    from app.models import User

    client.post("/api/auth/register", json={"email": "gone@southerniot.net"})
    u = db_session.query(User).filter_by(email="gone@southerniot.net").one()
    u.disabled_at = datetime.now(UTC)
    db_session.commit()
    r = client.post("/api/auth/login",
                    json={"email": "gone@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert r.status_code == 401 and r.json() == {"detail": "bad_credentials"}


def test_disabled_user_session_rejected(client, db_session):
    from app.models import User

    login(client, "leaver@southerniot.net")
    u = db_session.query(User).filter_by(email="leaver@southerniot.net").one()
    u.disabled_at = datetime.now(UTC)
    db_session.commit()
    assert client.get("/api/auth/me").status_code == 401


def test_expired_session_rejected(client, db_session):
    from datetime import timedelta

    from app.models import AuthSession

    login(client, "old@southerniot.net")
    for s in db_session.query(AuthSession).all():
        s.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    assert client.get("/api/auth/me").status_code == 401


def test_successful_logins_are_not_rate_limited(client):
    """Review fix: the whole office shares one public IP; only failures should count."""
    client.post("/api/auth/register", json={"email": "busy@southerniot.net"})
    codes = [client.post("/api/auth/login", json={"email": "busy@southerniot.net",
                                                  "password": TEST_SHARED_PASSWORD}).status_code
             for _ in range(15)]
    assert codes == [200] * 15


def test_failures_still_limited_after_successes(client):
    client.post("/api/auth/register", json={"email": "z@southerniot.net"})
    for _ in range(3):
        client.post("/api/auth/login",
                    json={"email": "z@southerniot.net", "password": TEST_SHARED_PASSWORD})
    codes = [client.post("/api/auth/login",
                         json={"email": "z@southerniot.net", "password": "wrong"}).status_code
             for _ in range(11)]
    assert codes[-1] == 429
    blocked_good = client.post(
        "/api/auth/login", json={"email": "z@southerniot.net", "password": TEST_SHARED_PASSWORD}
    )
    assert blocked_good.status_code == 429  # while blocked, even the right password waits


def test_padded_mixed_case_email_logs_in(client):
    """Review Focus 1: same account, no second registration."""
    client.post("/api/auth/register", json={"email": "rahim@southerniot.net"})
    r = client.post("/api/auth/login",
                    json={"email": " RAHIM@SouthernIoT.net ", "password": TEST_SHARED_PASSWORD})
    assert r.status_code == 200 and r.json()["email"] == "rahim@southerniot.net"
