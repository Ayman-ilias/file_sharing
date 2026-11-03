"""Smoke test of the production stack through nginx (plan 5). Python stdlib only.

    python3 deploy/tests/smoke.py --base http://127.0.0.1:5055 --password <SHARED_PASSWORD>

Expects LOGIN_RATE_LIMIT=5 on the stack (test_real_ip counts to it). Exits 0 only if every check passes.
"""

import argparse
import hashlib
import http.cookiejar
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

SPA_CSP = (
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; "
    "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; "
    "frame-ancestors 'none'"
)
MIB = 1024 * 1024
# a 1x1 PNG
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415478da63f8cfc0f01f0005000201a5d6d1b40000000049454e44ae426082"
)
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method, path, body=None, headers=None, raw=False):
        """Returns (status, headers, body bytes). Never raises on HTTP errors."""
        h = {"X-Requested-With": "fs", **(headers or {})}
        data = body
        if body is not None and not raw:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(r, timeout=60) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def json(self, method, path, body=None, headers=None):
        st, h, b = self.req(method, path, body, headers)
        return st, (json.loads(b) if b else None)


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def sign_in(base, password, email):
    c = Client(base)
    st, _ = c.json("POST", "/api/auth/register", {"email": email})
    check(st in (200, 201), f"register {email}: {st}")
    st, _ = c.json("POST", "/api/auth/login", {"email": email, "password": password})
    check(st == 200, f"login {email}: {st}")
    return c


def send_file(c, name, data, mime):
    st, up = c.json("POST", "/api/uploads", {
        "client_key": "smoke:" + hashlib.sha1(data).hexdigest(), "name": name, "size": len(data),
        "mime": mime, "is_global": True})
    check(st == 201, f"start upload: {st} {up}")
    size = up["chunk_size"]
    for n in range(0, max(1, -(-len(data) // size))):
        st, _, b = c.req("PUT", f"/api/uploads/{up['upload_id']}/chunks/{n}",
                         data[n * size:(n + 1) * size], {"Content-Type": "application/octet-stream"},
                         raw=True)
        check(st == 204, f"chunk {n}: {st} {b[:200]!r}")
    st, item = c.json("POST", f"/api/uploads/{up['upload_id']}/complete")
    check(st in (200, 201), f"complete: {st} {item}")
    return item, size


def test_spa(a):
    c = Client(a.base)
    st, h, body = c.req("GET", "/")
    check(st == 200 and b'<div id="root">' in body, f"/ → {st}")
    check(h.get("content-security-policy") == SPA_CSP, f"CSP on / = {h.get('content-security-policy')}")
    check(h.get("cache-control") == "no-cache", f"cache-control on / = {h.get('cache-control')}")
    check(h.get("x-content-type-options") == "nosniff", "nosniff on /")
    check(h.get("x-frame-options") == "DENY", "XFO on /")
    check(re.fullmatch(r"nginx", h.get("server", "")) is not None, f"server = {h.get('server')}")
    st, h2, deep = c.req("GET", "/some/deep/link")
    check(st == 200 and deep == body, "deep link falls back to index.html")
    check(h2.get("cache-control") == "no-cache", "deep link is no-cache")
    asset = re.search(rb'src="(/assets/[^"]+\.js)"', body)
    check(asset is not None, "index.html references a /assets/*.js")
    st, h3, _ = c.req("GET", asset.group(1).decode())
    check(st == 200, f"asset → {st}")
    check("immutable" in h3.get("cache-control", ""), f"asset cache = {h3.get('cache-control')}")
    check(h3.get("content-security-policy") == SPA_CSP, "CSP kept on /assets/*")
    check(h3.get("x-content-type-options") == "nosniff", "nosniff kept on /assets/*")


def test_api_proxied(a):
    st, h, b = Client(a.base).req("GET", "/api/health")
    check(st == 200 and json.loads(b) == {"ok": True}, f"/api/health → {st} {b[:100]!r}")
    for name in ("x-frame-options", "x-content-type-options", "referrer-policy"):
        check(len(h.get_all(name) or []) == 1, f"{name} sent once on /api, got {h.get_all(name)}")


def test_upload_download(a):
    c = sign_in(a.base, a.password, "smoke1@southerniot.net")
    data = os.urandom(20 * MIB)
    item, chunk = send_file(c, "big.bin", data, "application/octet-stream")
    check(chunk <= 16 * MIB and len(data) > chunk, "the file really went in more than one chunk")
    st, h, got = c.req("GET", f"/api/items/{item['id']}/download")
    check(st == 200, f"download → {st}")
    check(hashlib.sha256(got).digest() == hashlib.sha256(data).digest(), "downloaded bytes differ")
    check(h.get("content-disposition", "").startswith("attachment"), "attachment")
    check(h.get("x-content-type-options") == "nosniff", "nosniff on download")
    check(h.get("x-frame-options") == "DENY", "XFO on download")
    check(h.get("cache-control") == "private, no-store", f"cache-control = {h.get('cache-control')}")
    st, h, part = c.req("GET", f"/api/items/{item['id']}/download", headers={"Range": "bytes=0-99"})
    check(st == 206 and part == data[:100], f"Range → {st}, {len(part)} bytes")


def test_inline_previews(a):
    c = sign_in(a.base, a.password, "smoke1@southerniot.net")
    png, _ = send_file(c, "dot.png", PNG, "image/png")
    st, h, _ = c.req("GET", f"/api/items/{png['id']}/download?inline=1")
    check(st == 200 and h.get("content-security-policy") == "sandbox", f"png CSP = {h.get('content-security-policy')}")
    pdf, _ = send_file(c, "doc.pdf", PDF, "application/pdf")
    st, h, _ = c.req("GET", f"/api/items/{pdf['id']}/download?inline=1")
    check(st == 200 and h.get("content-type", "").startswith("application/pdf"), f"pdf → {st}")
    check(h.get("content-security-policy") is None, f"pdf CSP = {h.get('content-security-policy')}")


def test_protected_is_internal(a):
    c = Client(a.base)
    for path in ("/protected/files/ab/" + "ab" * 16, "/protected/vault/ab/" + "ab" * 16,
                 "/protected/app.db", "/protected/files/../app.db"):
        st, _, _ = c.req("GET", path)
        check(st == 404, f"{path} → {st}")


def test_body_limit(a):
    c = sign_in(a.base, a.password, "smoke1@southerniot.net")
    st, _, _ = c.req("PUT", "/api/uploads/" + "0" * 32 + "/chunks/0", b"\0" * (21 * MIB),
                     {"Content-Type": "application/octet-stream"}, raw=True)
    check(st == 413, f"21 MiB body → {st}")


def test_sse(a):
    """SSE: the first frame arrives at once and the outer proxy is told not to buffer."""
    c = sign_in(a.base, a.password, "smoke1@southerniot.net")
    cookie = "; ".join(f"{k.name}={k.value}" for k in c.jar)
    u = urlsplit(a.base)
    s = socket.create_connection((u.hostname, u.port or 80), timeout=10)
    s.sendall((f"GET /api/events HTTP/1.1\r\nHost: {u.netloc}\r\nCookie: {cookie}\r\n"
               "Accept: text/event-stream\r\n\r\n").encode())
    buf = b""
    while b"retry:" not in buf:
        chunk = s.recv(4096)
        check(chunk, "SSE stream closed before the first frame")
        buf += chunk
    s.close()
    head = buf.split(b"\r\n\r\n", 1)[0].decode().lower()
    check(" 200 " in head.splitlines()[0] + " ", f"SSE status: {head.splitlines()[0]}")
    check("content-type: text/event-stream" in head, "SSE content type")
    check("x-accel-buffering: no" in head, "SSE tells the outer proxy not to buffer")


def test_real_ip(a):
    """Runs last: it uses up the login limit (5/min) for one fake IP and for this client."""
    c = Client(a.base)
    bad = {"email": "nobody@southerniot.net", "password": "wrong-password"}
    for _ in range(5):
        st, _ = c.json("POST", "/api/auth/login", bad, {"CF-Connecting-IP": "198.51.100.7"})
        check(st == 401, f"bad login → {st}")
    st, _ = c.json("POST", "/api/auth/login", bad, {"CF-Connecting-IP": "198.51.100.7"})
    check(st == 429, f"6th bad login from the same CF-Connecting-IP → {st}")
    st, _ = c.json("POST", "/api/auth/login", bad, {"CF-Connecting-IP": "198.51.100.8"})
    check(st == 401, f"another CF-Connecting-IP has its own bucket → {st}")
    # X-Forwarded-For is client-controlled: rotating it must not dodge the limit
    for i in range(6):
        st, _ = c.json("POST", "/api/auth/login", bad, {"X-Forwarded-For": f"203.0.113.{i}"})
    check(st == 429, f"rotating X-Forwarded-For dodged the limit → {st}")


TESTS = [test_spa, test_api_proxied, test_upload_download, test_inline_previews,
         test_protected_is_internal, test_body_limit, test_sse, test_real_ip]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True)
    p.add_argument("--password", required=True)
    a = p.parse_args()
    failed = 0
    for t in TESTS:
        try:
            t(a)
            print(f"PASS {t.__name__}")
        except Exception as e:  # noqa: BLE001 — report every check, then fail
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print("ALL PASS" if not failed else f"{failed} FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
