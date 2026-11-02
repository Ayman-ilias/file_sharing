"""Password hashing, session tokens, client IP, rate limiting, CSRF and security headers."""

import hashlib
import json
import secrets
import threading
import time
from collections import deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_hasher = PasswordHasher()  # argon2-cffi defaults = Argon2id

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_HEADER = b"x-requested-with"
CSRF_VALUE = b"fs"
SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"same-origin"),
]


def hash_password(pw: str) -> str:
    return _hasher.hash(pw)


def verify_password(hashed: str, pw: str) -> bool:
    try:
        return _hasher.verify(hashed, pw)
    except (VerificationError, InvalidHashError):
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def client_ip(request: Request, *, trust_x_real_ip: bool) -> str:
    """nginx sets X-Real-IP from CF-Connecting-IP for trusted proxies only; else use the peer."""
    if trust_x_real_ip:
        real = request.headers.get("x-real-ip", "").strip()
        if real:
            return real
    return request.client.host if request.client else "unknown"


class RateLimiter:
    """In-memory sliding window per key. One process (one uvicorn worker) by design."""

    def __init__(self, limit: int, window_s: int):
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] >= self.window_s:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            if len(self._hits) > 10_000:  # forget idle keys
                for k in [k for k, v in self._hits.items() if not v]:
                    del self._hits[k]
            return True


class SecurityMiddleware:
    """Rejects state changes without `X-Requested-With: fs` (CSRF); adds security headers."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"server"]
                headers.extend(SECURITY_HEADERS)
                message["headers"] = headers
            await send(message)

        if scope["method"] not in SAFE_METHODS:
            sent = dict(scope.get("headers") or [])
            if sent.get(CSRF_HEADER) != CSRF_VALUE:
                body = json.dumps({"detail": "csrf"}).encode()
                await send_with_headers({
                    "type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())],
                })
                await send({"type": "http.response.body", "body": body})
                return

        await self.app(scope, receive, send_with_headers)
