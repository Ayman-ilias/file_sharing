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
