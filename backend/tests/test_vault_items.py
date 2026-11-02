from concurrent.futures import ThreadPoolExecutor

import pytest

from app.storage import storage_path
from app.vault import META_ALLOWANCE
from tests.conftest import login
from tests.vault_helpers import b64, owner, vault_blob


@pytest.fixture
def small_vault(monkeypatch, chunk4):
    """A 300 KB vault so quota edges are cheap to reach. Request it BEFORE `client`."""
    monkeypatch.setenv("VAULT_QUOTA", str(300_000))


def post_item(c, gen, meta=None, **extra):
    return c.post("/api/vault/items", json={"meta_ct": meta or b64(90), "key_gen": gen, **extra})


def test_create_list_update_delete(client):
    gen = owner(client)
    made = post_item(client, gen)
    assert made.status_code == 201
    item = made.json()
    assert item["version"] == 1 and item["blob_id"] is None and item["size_bytes"] == 120
    assert [i["id"] for i in client.get("/api/vault/items").json()] == [item["id"]]
    new_meta = b64(60)
    up = client.put(
        f"/api/vault/items/{item['id']}", json={"meta_ct": new_meta, "version": 1, "key_gen": gen}
    )
    assert up.status_code == 200 and up.json()["version"] == 2 and up.json()["meta_ct"] == new_meta
    assert client.delete(f"/api/vault/items/{item['id']}").status_code == 204
    assert client.get("/api/vault/items").json() == []


def test_stale_version_409_returns_current(client):
    gen = owner(client)
    item = post_item(client, gen).json()
    client.put(
        f"/api/vault/items/{item['id']}", json={"meta_ct": b64(9), "version": 1, "key_gen": gen}
    )
    stale = client.put(
        f"/api/vault/items/{item['id']}", json={"meta_ct": b64(9), "version": 1, "key_gen": gen}
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == "stale_version" and stale.json()["current"]["version"] == 2


def test_item_write_with_old_key_gen_409(client):
    gen = owner(client)
    r = post_item(client, "0" * 16)
    assert r.status_code == 409 and r.json()["detail"] == "key_changed"
    item = post_item(client, gen).json()
    r = client.put(
        f"/api/vault/items/{item['id']}",
        json={"meta_ct": b64(9), "version": 1, "key_gen": "f" * 16},
    )
    assert r.status_code == 409 and r.json()["detail"] == "key_changed"


def test_items_before_setup_404(client):
    login(client, "nosetup@southerniot.net")
    r = post_item(client, "0" * 16)
    assert r.status_code == 404 and r.json()["detail"] == "not_initialized"


def test_other_users_item_404(chunk4, client, make_client):
    gen = owner(client)
    blob = vault_blob(client, b"ciphertext", gen)
    item = post_item(client, gen, blob_id=blob).json()
    other = make_client()
    gen2 = owner(other, "other@southerniot.net")
    assert other.get(f"/api/vault/items/{item['id']}/blob").status_code == 404
    assert (
        other.put(
            f"/api/vault/items/{item['id']}",
            json={"meta_ct": b64(9), "version": 1, "key_gen": gen2},
        ).status_code
        == 404
    )
    assert other.delete(f"/api/vault/items/{item['id']}").status_code == 404
    assert post_item(other, gen2, blob_id=blob).status_code == 404  # someone else's blob


def test_attach_blob_once(chunk4, client):
    gen = owner(client)
    blob = vault_blob(client, b"ciphertext", gen)
    first = post_item(client, gen, blob_id=blob)
    assert first.status_code == 201 and first.json()["blob_id"] == blob
    assert first.json()["size_bytes"] == 10 + len(first.json()["meta_ct"])
    assert post_item(client, gen, blob_id=blob).status_code == 404


def test_meta_only_counts_toward_quota(small_vault, client):
    gen = owner(client)
    assert post_item(client, gen, meta=b64(150_000)).status_code == 201  # 200,000 chars
    full = post_item(client, gen, meta=b64(80_000))
    assert full.status_code == 507 and full.json()["detail"] == "vault_full"
    assert client.get("/api/vault").json()["used_bytes"] == 200_000


def test_edit_near_full_uses_delta(small_vault, client):
    gen = owner(client)
    item = post_item(client, gen, meta=b64(210_000)).json()  # 280,000 of 300,000
    r = client.put(
        f"/api/vault/items/{item['id']}",
        json={"meta_ct": b64(210_003), "version": 1, "key_gen": gen},
    )
    assert r.status_code == 200


def test_parallel_item_posts_respect_quota(small_vault, client, make_client):
    gen = owner(client)
    clients = [client] + [make_client() for _ in range(5)]
    for c in clients[1:]:
        c.cookies = client.cookies
    with ThreadPoolExecutor(6) as pool:
        codes = list(pool.map(lambda c: post_item(c, gen, meta=b64(60_000)).status_code, clients))
    assert codes.count(201) == 3 and codes.count(507) == 3  # 3 × 80,000 fits in 300,000, 4 don't


def test_delete_frees_quota_and_file(chunk4, client, app_settings):
    gen = owner(client)
    blob = vault_blob(client, b"ciphertext", gen)
    item = post_item(client, gen, blob_id=blob).json()
    path = storage_path(app_settings.data_dir, "vault", blob)
    assert path.exists()
    client.delete(f"/api/vault/items/{item['id']}")
    assert not path.exists()
    assert client.get("/api/vault").json()["used_bytes"] == 0


def test_blob_download_headers(chunk4, client):
    gen = owner(client)
    blob = vault_blob(client, b"ciphertext", gen)
    item = post_item(client, gen, blob_id=blob).json()
    r = client.get(f"/api/vault/items/{item['id']}/blob")
    assert r.status_code == 200 and r.content == b""
    assert r.headers["x-accel-redirect"] == f"/protected/vault/{blob[:2]}/{blob}"
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["cache-control"] == "private, no-store"


def test_blob_served_directly_with_serve_files(chunk4, client, app_settings):
    gen = owner(client)
    blob = vault_blob(client, b"ciphertext", gen)
    item = post_item(client, gen, blob_id=blob).json()
    app_settings.serve_files = True
    assert client.get(f"/api/vault/items/{item['id']}/blob").content == b"ciphertext"


def test_item_count_cap(client, db_session, monkeypatch):
    import app.routers.vault as vault_router

    monkeypatch.setattr(vault_router, "MAX_ITEMS", 2)
    gen = owner(client)
    assert post_item(client, gen).status_code == 201
    assert post_item(client, gen).status_code == 201
    r = post_item(client, gen)
    assert r.status_code == 409 and r.json()["detail"] == "too_many_items"


def test_meta_size_cap(client):
    gen = owner(client)
    r = client.post("/api/vault/items", json={"meta_ct": "A" * 1_400_001, "key_gen": gen})
    assert r.status_code == 413


def test_status_counts_items(client):
    gen = owner(client)
    post_item(client, gen)
    st = client.get("/api/vault").json()
    assert st["item_count"] == 1 and st["used_bytes"] == 120


def test_meta_allowance_is_64k():
    assert META_ALLOWANCE == 65536
