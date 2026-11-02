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


def login(client, email: str, password: str = TEST_SHARED_PASSWORD):
    """Register if needed, sign in, set `client.me`, and return the same client."""
    r = client.post("/api/auth/register", json={"email": email})
    assert r.status_code in (200, 201), r.text
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    client.me = r.json()
    return client


@pytest.fixture
def make_client(app, client):
    """Extra clients on the same running app, each with its own cookies."""
    made = []

    def _make():
        c = TestClient(app, headers={"X-Requested-With": "fs"})
        made.append(c)
        return c

    yield _make
    for c in made:
        c.close()


@pytest.fixture
def make_file_item(db_session, app_settings, make_item):
    """A shared file whose 3 bytes really exist under DATA_DIR/files (storage_path)."""
    from uuid import uuid4

    from app.models import User
    from app.storage import storage_path

    def _make(name="report.pdf", mime="application/pdf", sender=None, recipients=(),
              is_global=False):
        if sender is None:
            sender = db_session.query(User).filter_by(is_global=False).first()
        sid = uuid4().hex
        path = storage_path(app_settings.data_dir, "files", sid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"abc")
        return make_item(sender, kind="file", name=name, mime=mime, size=3, storage_id=sid,
                         recipients=recipients, is_global=is_global)

    return _make


@pytest.fixture
def file_item(client, db_session, make_file_item):
    """One PDF sent by the signed-in `client` user (owner@southerniot.net) to nobody else."""
    from app.models import User

    login(client, "owner@southerniot.net")
    owner = db_session.get(User, client.me["id"])
    return make_file_item(sender=owner)


@pytest.fixture
def make_vault_item(db_session):
    from uuid import uuid4

    from app.models import VaultItem

    def _make(user):
        v = VaultItem(id=uuid4().hex, user_id=user.id, meta_ct="Y2lwaGVy", size_bytes=6)
        db_session.add(v)
        db_session.commit()
        return v

    return _make


@pytest.fixture
def chunk4(monkeypatch):
    """Tiny 4-byte chunks so multi-chunk files stay small. Request it BEFORE `client`."""
    monkeypatch.setenv("CHUNK_SIZE", "4")


def start_upload(c, data: bytes = b"", *, name="f.bin", recipients=(), is_global=False,
                 client_key=None, mime="application/octet-stream", **extra):
    body = {"client_key": client_key or f"k-{name}-{len(data)}", "name": name, "size": len(data),
            "mime": mime, "recipient_ids": list(recipients), "is_global": is_global,
            "target": "share", **extra}
    return c.post("/api/uploads", json=body)


def put_chunk(c, upload_id: str, n: int, data: bytes):
    return c.put(f"/api/uploads/{upload_id}/chunks/{n}", content=data)


def send_all(c, upload_id: str, data: bytes, chunk_size: int):
    for n in range((len(data) + chunk_size - 1) // chunk_size):
        r = put_chunk(c, upload_id, n, data[n * chunk_size:(n + 1) * chunk_size])
        assert r.status_code == 204, r.text
