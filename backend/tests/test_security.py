from starlette.requests import Request

from app.security import (
    RateLimiter,
    client_ip,
    hash_password,
    new_session_token,
    token_hash,
    verify_password,
)


def _request(headers: dict[str, str], peer: str = "10.0.0.9") -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    return Request({"type": "http", "headers": raw, "client": (peer, 1234)})


def test_password_roundtrip():
    h = hash_password("correct horse 1")
    assert h.startswith("$argon2id$")
    assert verify_password(h, "correct horse 1")
    assert not verify_password(h, "wrong")


def test_verify_password_handles_garbage_hash():
    assert verify_password("not-a-hash", "anything") is False


def test_session_token_is_random_and_hash_is_sha256_hex():
    a, b = new_session_token(), new_session_token()
    assert a != b and len(a) >= 40
    assert len(token_hash(a)) == 64 and token_hash(a) == token_hash(a)


def test_post_without_csrf_header_rejected(raw_client):
    r = raw_client.post("/api/auth/logout")
    assert r.status_code == 403 and r.json() == {"detail": "csrf"}


def test_get_without_csrf_header_allowed(raw_client):
    assert raw_client.get("/api/health").status_code == 200


def test_security_headers(client):
    r = client.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["referrer-policy"] == "same-origin"
    assert "uvicorn" not in r.headers.get("server", "").lower()


def test_csrf_rejection_also_has_security_headers(raw_client):
    r = raw_client.delete("/api/items/x")
    assert r.status_code == 403 and r.headers["x-frame-options"] == "DENY"


def test_rate_limiter_blocks_after_limit():
    rl = RateLimiter(limit=3, window_s=60)
    assert [rl.hit("ip") for _ in range(4)] == [True, True, True, False]
    assert rl.hit("other-ip") is True


def test_client_ip_trusts_x_real_ip_only_when_configured():
    req = _request({"X-Real-IP": "203.0.113.7"})
    assert client_ip(req, trust_x_real_ip=True) == "203.0.113.7"
    assert client_ip(req, trust_x_real_ip=False) == "10.0.0.9"
    assert client_ip(_request({}), trust_x_real_ip=True) == "10.0.0.9"
