import pytest
from pydantic import ValidationError


def test_health_ok(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_missing_shared_password_fails_fast(monkeypatch):
    monkeypatch.delenv("SHARED_PASSWORD", raising=False)
    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_data_dirs_created_on_startup(client, app_settings):
    for sub in ("files", "vault", "tmp"):
        assert (app_settings.data_dir / sub).is_dir()
