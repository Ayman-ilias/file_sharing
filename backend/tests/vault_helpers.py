"""Shared helpers for the My storage tests."""

import base64
import os

from tests.conftest import TEST_SHARED_PASSWORD, login, put_chunk

OWN = "own-login-pass-1"


def b64(n: int) -> str:
    return base64.b64encode(os.urandom(n)).decode()


def key_body(**over):
    body = {"salt": b64(16), "iterations": 600_000, "wrapped_key": b64(61)}
    body.update(over)
    return body


def owner(client, email="vowner@southerniot.net"):
    """A user with their own login password and a set-up vault; returns its key_gen."""
    login(client, email)
    r = client.post(
        "/api/auth/password", json={"current_password": TEST_SHARED_PASSWORD, "new_password": OWN}
    )
    assert r.status_code == 204, r.text
    assert client.post("/api/vault/setup", json=key_body()).status_code == 204
    return client.get("/api/vault").json()["key_gen"]


def start_vault(c, size: int, key_gen: str, **over):
    body = {
        "client_key": "vault:" + os.urandom(8).hex(),
        "name": "secret-salary.xlsx",
        "size": size,
        "mime": "application/vnd.ms-excel",
        "recipient_ids": [],
        "is_global": False,
        "target": "vault",
        "key_gen": key_gen,
        **over,
    }
    return c.post("/api/uploads", json=body)


def vault_blob(c, data: bytes, key_gen: str, chunk: int = 4) -> str:
    """Upload ciphertext bytes to the vault; returns the blob id."""
    r = start_vault(c, len(data), key_gen)
    assert r.status_code == 201, r.text
    uid = r.json()["upload_id"]
    for n in range((len(data) + chunk - 1) // chunk):
        assert put_chunk(c, uid, n, data[n * chunk : (n + 1) * chunk]).status_code == 204
    done = c.post(f"/api/uploads/{uid}/complete")
    assert done.status_code == 201, done.text
    return done.json()["blob_id"]
