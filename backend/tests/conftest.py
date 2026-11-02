import pytest
from fastapi.testclient import TestClient

TEST_SHARED_PASSWORD = "test-shared-pw"


@pytest.fixture
def app_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("SHARED_PASSWORD", TEST_SHARED_PASSWORD)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("COOKIE_SECURE", "false")
    from app.config import Settings

    return Settings(_env_file=None)


@pytest.fixture
def app(app_settings):
    from app.main import create_app

    return create_app(app_settings)


@pytest.fixture
def client(app):
    with TestClient(app, headers={"X-Requested-With": "fs"}) as c:
        yield c


@pytest.fixture
def db_session(client, app):
    """A SQLAlchemy session on the app's database (the app has run its migrations)."""
    session = app.state.session_factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def make_user(db_session):
    from app.models import User

    def _make(email: str, *, is_global: bool = False) -> User:
        user = User(email=email, username=email.split("@")[0], is_global=is_global)
        db_session.add(user)
        db_session.commit()
        return user

    return _make


@pytest.fixture
def make_item(db_session, app_settings):
    from datetime import UTC, datetime, timedelta
    from uuid import uuid4

    from app.models import Item, ItemRecipient

    def _make(sender, *, kind="text", recipients=(), is_global=False, **cols):
        now = datetime.now(UTC)
        defaults = dict(
            id=uuid4().hex, kind=kind, name=cols.pop("name", "item"), size=0,
            mime="text/plain", sender_id=sender.id, is_global=is_global,
            created_at=now, expires_at=now + timedelta(days=app_settings.item_ttl_days),
        )
        defaults.update(cols)
        item = Item(**defaults)
        db_session.add(item)
        for r in recipients:
            db_session.add(ItemRecipient(item_id=item.id, user_id=r.id))
        db_session.commit()
        return item

    return _make


@pytest.fixture
def raw_client(app):
    """A client without the X-Requested-With header (a cross-site browser request)."""
    with TestClient(app) as c:
        yield c
