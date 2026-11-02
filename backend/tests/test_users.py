from datetime import UTC, datetime

from tests.conftest import TEST_SHARED_PASSWORD, login


def test_lists_other_regular_users_sorted(client, make_client, db_session):
    from app.models import User

    for name in ("rahim", "nusrat"):
        login(make_client(), f"{name}@southerniot.net")
    login(client, "ayman@southerniot.net")
    names = [u["username"] for u in client.get("/api/users").json()]
    assert names == ["nusrat", "rahim"]
    first = client.get("/api/users").json()[0]
    assert set(first) == {"id", "username", "email"}

    nusrat = db_session.query(User).filter_by(username="nusrat").one()
    nusrat.disabled_at = datetime.now(UTC)
    db_session.commit()
    assert [u["username"] for u in client.get("/api/users").json()] == ["rahim"]


def test_global_account_gets_empty_list(client, make_client):
    login(make_client(), "rahim@southerniot.net")
    client.post("/api/auth/login",
                json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert client.get("/api/users").json() == []


def test_users_needs_sign_in(raw_client):
    assert raw_client.get("/api/users").status_code == 401
