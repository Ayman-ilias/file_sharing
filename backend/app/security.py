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
    """In-memory sliding window per key. One process (one uvicorn worker) by design.

    Idle keys are forgotten after `window_s`, and at most `max_keys` keys are kept, so memory
    stays bounded however many different client IPs show up.
    """

    def __init__(self, limit: int, window_s: int, *, clock=time.monotonic, max_keys: int = 10_000):
        self.limit = limit
        self.window_s = window_s
        self.max_keys = max_keys
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        self._last_prune = clock()

    def _trim(self, q: deque[float], now: float) -> None:
        while q and now - q[0] >= self.window_s:
            q.popleft()

    def _prune(self, now: float) -> None:
        if now - self._last_prune >= self.window_s:
            for k in [k for k, q in self._hits.items() if not q or now - q[-1] >= self.window_s]:
                del self._hits[k]
            self._last_prune = now
        while len(self._hits) > self.max_keys:  # evict the least recently used key
            oldest = min(self._hits, key=lambda k: self._hits[k][-1] if self._hits[k] else -1)
            del self._hits[oldest]

    def blocked(self, key: str) -> bool:
        """True when `key` already used up its attempts; does not count as an attempt."""
        now = self._clock()
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return False
            self._trim(q, now)
            return len(q) >= self.limit

    def record(self, key: str) -> None:
        now = self._clock()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            self._trim(q, now)
            q.append(now)
            self._prune(now)

    def hit(self, key: str) -> bool:
        """Count an attempt; False when the key was already over the limit."""
        if self.blocked(key):
            return False
        self.record(key)
        return True

    def size(self) -> int:
        return len(self._hits)


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
