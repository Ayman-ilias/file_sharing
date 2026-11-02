# Plan 1: Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested FastAPI backend with accounts, sessions, the global account, text sharing, Private/Global listing, delete with audit, safe download headers and expiry, with every 2026-11-01 audit finding pinned by a test.

**Architecture:** One FastAPI app (`app.main:create_app`) with SQLAlchemy 2 on SQLite (WAL). Files are addressed only by random storage IDs. Sessions are server-side, behind an HttpOnly cookie. Every state-changing request needs `X-Requested-With: fs`. Downloads return `X-Accel-Redirect` for nginx (wired in plan 5), so Python never streams file bytes.

**Tech Stack:** Python 3.12 (via `uv`), FastAPI, Uvicorn, SQLAlchemy 2, Alembic, pydantic-settings, argon2-cffi, pytest, httpx (TestClient), ruff. Versions: latest stable at install time, frozen in `uv.lock`.

**Spec:** [docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md](../specs/2026-11-01-file-sharing-v2-design.md) (incl. §3.8 corner cases, 2026-11-02). **Contracts:** [roadmap](2026-11-01-file-sharing-v2-roadmap.md). Table, setting and endpoint names come from there.

## Global Constraints

- Python 3.12; all commands run from `backend/` with `uv run …`.
- Only `@southerniot.net` emails register (`ALLOWED_EMAIL_DOMAIN`); emails are lowercased before any check or storage.
- `SHARED_PASSWORD` comes only from the environment. It never appears in code, tests, logs or docs. Tests use the value `test-shared-pw` set in `conftest.py`.
- A user whose `password_hash` is NULL authenticates with `SHARED_PASSWORD`. A changed password is stored as an Argon2id hash. The global account always uses `SHARED_PASSWORD` and can never change it.
- New passwords are at least 10 characters.
- Session cookie: name `fs_session`, `HttpOnly`, `SameSite=Lax`, `Secure` unless `COOKIE_SECURE=false`, 30-day sliding expiry; only the SHA-256 of the token is stored.
- Every POST/PUT/DELETE without the header `X-Requested-With: fs` gets 403 `csrf`.
- Shared items expire `ITEM_TTL_DAYS` (30) after creation; text bodies are at most `MAX_TEXT_BYTES` (1 MiB) as UTF-8.
- Response headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, and no `Server` version string.
- Commit after each task with a conventional message ending in the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit only on `feature/v2`, never push.

## Review Focus

1. **Mixed-case or padded emails** (`" Rahim@SouthernIoT.net "`) must map to the same account as `rahim@southerniot.net`, and must not register a second account. Test in task 4.
2. **Look-alike domains** (`rahim@southerniot.net.evil.com`, `rahim@evil-southerniot.net`, `rahim@southerniot.net@x.com`) are rejected. Test in task 4.
3. **The global account trying to change its password, or registering `global@…` as a normal user**, is refused with a clear error. Tests in tasks 4 and 5.
4. **A user not involved in an item** (neither sender nor recipient, and the item isn't global) can't list, download or delete it, and gets 404, not 403, so its existence doesn't leak. Tests in tasks 7 and 8.
5. **Filenames carrying HTML, quotes or path parts** (`../x`, `a"b.pdf`, `<img src=x onerror=alert(1)>.html`) are stored as plain names, never touch a path, and come back in `Content-Disposition` safely encoded; HTML and SVG are never served inline. Tests in tasks 8 and 10.

---

### Task 1: Project setup, settings and health check

**Files:**
- Create: `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/main.py`, `backend/tests/__init__.py`, `backend/tests/conftest.py`, `backend/tests/test_health.py`, root `Makefile`

**Interfaces:**
- Produces: `Settings` (pydantic-settings; every field and default from the roadmap's Settings table; `shared_password: SecretStr` is required). `get_settings() -> Settings` (lru-cached). `create_app(settings: Settings | None = None) -> FastAPI`. The fixture `client` (a `TestClient` with default header `X-Requested-With: fs`, `DATA_DIR` = pytest `tmp_path`, `SHARED_PASSWORD=test-shared-pw`, `COOKIE_SECURE=false`) and the fixture `app_settings`.

- [ ] **Step 1: Initialise the project.** `cd backend && uv init --app --python 3.12 --name fs-backend`, then `uv add fastapi uvicorn[standard] sqlalchemy alembic pydantic-settings argon2-cffi` and `uv add --dev pytest httpx ruff`. Add `[tool.pytest.ini_options] testpaths=["tests"]` and `[tool.ruff] line-length=100`. Root `Makefile` targets: `backend-test` (`cd backend && uv run pytest -q`), `backend-lint` (`cd backend && uv run ruff check .`), `backend-dev` (`cd backend && uv run uvicorn app.main:create_app --factory --reload --port 8000`).
- [ ] **Step 2: Write the failing tests** in `tests/test_health.py`:

```python
def test_health_ok(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True}

def test_missing_shared_password_fails_fast(monkeypatch):
    monkeypatch.delenv("SHARED_PASSWORD", raising=False)
    import pytest
    from pydantic import ValidationError
    from app.config import Settings
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
```

- [ ] **Step 3: Run** `uv run pytest tests/test_health.py -q`. Expected: FAIL (`app.main` not found).
- [ ] **Step 4: Implement** `Settings`, `get_settings`, and `create_app` with `GET /api/health`. `create_app` stores the settings on `app.state.settings` and creates `DATA_DIR/{files,vault,tmp}` on startup.
- [ ] **Step 5: Run** `uv run pytest -q && uv run ruff check .`. Expected: all pass, ruff clean.
- [ ] **Step 6: Commit** `feat(backend): project setup, settings and health check`.

### Task 2: Database, models and first migration

**Files:**
- Create: `backend/app/db.py`, `backend/app/models.py`, `backend/migrations/` (Alembic env + `0001_initial.py`), `backend/alembic.ini`, `backend/tests/test_db.py`

**Interfaces:**
- Consumes: `Settings.data_dir`.
- Produces: `make_engine(settings) -> Engine` (SQLite at `DATA_DIR/app.db`; on connect: `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`). `SessionLocal`. The FastAPI dependency `get_db() -> Iterator[Session]`. ORM classes `User, AuthSession, Item, ItemRecipient, FolderEntry, Upload, AuditLog, VaultKey, VaultItem`, matching the roadmap's tables exactly (column names and nullability). `upgrade_db(settings)` runs Alembic to head; `create_app` calls it on startup.

- [ ] **Step 1: Write the failing tests:**

```python
def test_tables_exist_and_wal(client, app_settings):
    import sqlite3
    con = sqlite3.connect(app_settings.data_dir / "app.db")
    names = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    assert {"users","sessions","items","item_recipients","folder_entries","uploads",
            "audit_log","vault_keys","vault_items"} <= names
    assert con.execute("pragma journal_mode").fetchone()[0] == "wal"

def test_deleting_item_cascades_recipients(db_session, make_user, make_item):
    ...  # create an item with one recipient, delete the item, assert item_recipients is empty
```

- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the models, the engine pragmas, and an Alembic migration generated with `uv run alembic revision --autogenerate -m initial`, then reviewed by hand. Add the fixtures `db_session`, `make_user(email, *, is_global=False)` and `make_item(sender, *, kind="text", recipients=(), is_global=False, **cols)` to `conftest.py`.
- [ ] **Step 4: Run** `uv run pytest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): database models and initial migration`.

### Task 3: Security primitives

**Files:**
- Create: `backend/app/security.py`, `backend/tests/test_security.py`
- Modify: `backend/app/main.py` (middleware)

**Interfaces:**
- Produces:
  - `hash_password(pw: str) -> str` and `verify_password(hash: str, pw: str) -> bool` (argon2-cffi `PasswordHasher` defaults = Argon2id).
  - `new_session_token() -> str` (`secrets.token_urlsafe(32)`) and `token_hash(token: str) -> str` (sha256 hex).
  - `client_ip(request) -> str`: `X-Real-IP` when `TRUST_X_REAL_IP`, else the peer.
  - `RateLimiter(limit: int, window_s: int).hit(key: str) -> bool` (in-memory sliding window; True = allowed).
  - Middleware: CSRF check (403 `{"detail":"csrf"}` for POST/PUT/PATCH/DELETE without `X-Requested-With: fs`) and the security headers from Global Constraints.

- [ ] **Step 1: Write the failing tests:**

```python
def test_password_roundtrip():
    h = hash_password("correct horse 1"); assert h.startswith("$argon2id$")
    assert verify_password(h, "correct horse 1") and not verify_password(h, "wrong")

def test_post_without_csrf_header_rejected(raw_client):   # raw_client has no default headers
    r = raw_client.post("/api/auth/logout")
    assert r.status_code == 403 and r.json() == {"detail": "csrf"}

def test_security_headers(client):
    r = client.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "server" not in {k.lower() for k in r.headers} or "uvicorn" not in r.headers.get("server","").lower()

def test_rate_limiter_blocks_after_limit():
    rl = RateLimiter(limit=3, window_s=60)
    assert [rl.hit("ip") for _ in range(4)] == [True, True, True, False]
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the functions and middleware. Run Uvicorn with `server_header=False` (record this for plan 5).
- [ ] **Step 4: Run** `uv run pytest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): password hashing, sessions, CSRF and security headers`.

### Task 4: Register, login, logout, me, and the global account

**Files:**
- Create: `backend/app/deps.py`, `backend/app/routers/__init__.py`, `backend/app/routers/auth.py`, `backend/tests/test_auth.py`
- Modify: `backend/app/main.py` (router; seed the global user on startup)

**Interfaces:**
- Consumes: task 3 helpers, `User`, `AuthSession`.
- Produces:
  - `normalize_email(raw: str) -> str` (strip + lowercase), raising `ValueError("domain_not_allowed")` unless the address matches `^[a-z0-9._%+-]+@<domain>$` with `<domain>` = `ALLOWED_EMAIL_DOMAIN` escaped.
  - `current_user` dependency (401 `not_signed_in`; extends `expires_at` when fewer than 29 days remain).
  - `require_regular_user` dependency (403 `global_account` for the global user).
  - Schema `Me`.
  - `seed_global_user(db, settings)`, which is idempotent.
  - The login limiter: 10 attempts per minute per client IP, shared by register and login.
  - Test helpers in `conftest.py`, used by every later task:
    - `login(client, email, password="test-shared-pw") -> TestClient`: registers if needed, logs in, sets `client.me` to the `Me` dict, and returns the same client.
    - `make_client() -> TestClient`: a second client on the same app, with its own cookies.
    - `raw_client`: no default headers.
    - `make_file_item(name=…, mime=…, sender=…, recipients=(), is_global=False) -> Item`: writes 3 bytes to `storage_path`.
    - `file_item`: one PDF sent by the logged-in `client` user.
    - `make_vault_item(user) -> VaultItem`.

- [ ] **Step 1: Write the failing tests** (`login(client, email, password="test-shared-pw")` is a conftest helper that registers if needed and logs in):

```python
def test_register_then_login_with_shared_password(client):
    assert client.post("/api/auth/register", json={"email": "rahim@southerniot.net"}).status_code == 201
    r = client.post("/api/auth/login", json={"email": "rahim@southerniot.net", "password": "test-shared-pw"})
    assert r.status_code == 200 and r.json()["uses_shared_password"] is True
    assert "fs_session" in client.cookies
    assert client.get("/api/auth/me").json()["username"] == "rahim"

def test_email_normalised(client):
    client.post("/api/auth/register", json={"email": " Rahim@SouthernIoT.net "})
    r = client.post("/api/auth/register", json={"email": "rahim@southerniot.net"})
    assert r.status_code == 200   # already exists, same account

@pytest.mark.parametrize("bad", ["rahim@gmail.com", "rahim@southerniot.net.evil.com",
    "rahim@evil-southerniot.net", "rahim@southerniot.net@x.com", "@southerniot.net"])
def test_foreign_domains_rejected(client, bad):
    r = client.post("/api/auth/register", json={"email": bad})
    assert r.status_code == 400 and r.json()["detail"] == "domain_not_allowed"

def test_global_email_cannot_register(client):
    r = client.post("/api/auth/register", json={"email": "global@southerniot.net"})
    assert r.status_code == 400 and r.json()["detail"] == "reserved"

def test_global_account_logs_in_with_shared_password(client):
    r = client.post("/api/auth/login", json={"email": "global@southerniot.net", "password": "test-shared-pw"})
    assert r.status_code == 200 and r.json()["is_global"] is True

def test_wrong_password_and_unknown_user_look_the_same(client):
    client.post("/api/auth/register", json={"email": "a@southerniot.net"})
    r1 = client.post("/api/auth/login", json={"email": "a@southerniot.net", "password": "nope"})
    r2 = client.post("/api/auth/login", json={"email": "ghost@southerniot.net", "password": "nope"})
    assert r1.status_code == r2.status_code == 401 and r1.json() == r2.json()

def test_login_rate_limited(client):
    codes = [client.post("/api/auth/login", json={"email":"x@southerniot.net","password":"n"}).status_code
             for _ in range(11)]
    assert codes[-1] == 429

def test_logout_invalidates_session(client):
    login(client, "b@southerniot.net"); client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
```

- [ ] **Step 2: Run.** Expected: FAIL.
Add these to the Step 1 tests: `test_disabled_user_cannot_sign_in` (set `disabled_at` → login gives 401 `bad_credentials`, same body as a wrong password) and `test_disabled_user_session_rejected` (disable while signed in → `/api/auth/me` gives 401).

- [ ] **Step 3: Implement** the router and dependencies. Compare the shared password with `hmac.compare_digest`. On an unknown user, still run `verify_password` against a fixed dummy hash, so the timing doesn't reveal which emails exist.
- [ ] **Step 4: Run** `uv run pytest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): register, login, sessions and the global account`.

### Task 5: Change password

**Files:**
- Modify: `backend/app/routers/auth.py`
- Create: `backend/tests/test_password.py`

**Interfaces:**
- Produces: `POST /api/auth/password` (contract in the roadmap). On success: set `password_hash`, write `audit_log(action="password_change")`, and **delete the user's other sessions**, keeping the current one.

- [ ] **Step 1: Write the failing tests:**

```python
def test_change_password_then_old_one_stops_working(client):
    login(client, "c@southerniot.net")
    r = client.post("/api/auth/password", json={"current_password": "test-shared-pw", "new_password": "my-own-pass-1"})
    assert r.status_code == 204
    assert client.get("/api/auth/me").json()["uses_shared_password"] is False
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"email":"c@southerniot.net","password":"test-shared-pw"}).status_code == 401
    assert client.post("/api/auth/login", json={"email":"c@southerniot.net","password":"my-own-pass-1"}).status_code == 200

def test_short_password_rejected(client):
    login(client, "d@southerniot.net")
    r = client.post("/api/auth/password", json={"current_password":"test-shared-pw","new_password":"short"})
    assert r.status_code == 400 and r.json()["detail"] == "too_short"

def test_wrong_current_password(client): ...   # 401 bad_credentials
def test_global_cannot_change_password(client): ...   # 403 global_account
def test_other_sessions_signed_out(client, make_client): ...   # second client logged in as the same user gets 401 after the change
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): users can change their own password`.

### Task 6: User list for the recipient picker

**Files:**
- Create: `backend/app/routers/users.py`, `backend/tests/test_users.py`

**Interfaces:**
- Produces: `GET /api/users` → other regular users `[{id, username, email}]` sorted by username. It excludes the caller, the global account and disabled users. The global account gets `[]` (it can only send to Global).

- [ ] **Step 1: Write the failing test.** Register `rahim`, `nusrat` and `ayman`; log in as `ayman`; assert `[u["username"] for u in r.json()] == ["nusrat", "rahim"]`. Disable `nusrat` → the list becomes `["rahim"]`. Also assert the global account gets `[]`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): list colleagues for the recipient picker`.

### Task 7: Text items and Private/Global listing

**Files:**
- Create: `backend/app/routers/items.py`, `backend/app/schemas.py`, `backend/tests/test_items.py`

**Interfaces:**
- Consumes: `current_user`, `Item`, `ItemRecipient`.
- Produces:
  - Schemas `Item` (roadmap shape) and `TextItemIn {title: str | None (≤ 200 chars), body: str, recipient_ids: list[int], is_global: bool}`.
  - `visible_items_query(user) -> Select` (the visibility rule; expired items excluded), reused by plan 2.
  - `POST /api/items/text` and `GET /api/items?section=private|global`. **private** = not global, and the caller is the sender or a recipient. **global** = `is_global`. The global account asking for `private` gets `[]`.
  - Rules:
    - A missing or blank title becomes the first non-empty line of the body, stripped and cut to 80 characters. Titles and names are normalised to Unicode NFC.
  - `is_global` true → `recipient_ids` are ignored and no recipient rows are stored (Global replaces people).
  - `GET /api/items` returns `{items: [Item], next}`, newest first. `limit` defaults to 50 (1–200; else 422). `before` is an opaque cursor of `created_at` + `id`, so equal timestamps never skip or repeat an item. `next` is null on the last page.
    - `recipient_ids` must name existing, enabled, regular users, not the sender. Unknown, disabled, global or self → 400 `unknown_recipient`.
    - An empty recipient list with `is_global` false → 400 `no_recipients`.
    - The global account may only post with `is_global` true (else 403 `global_account`).
    - Size = UTF-8 byte length. Over 1 MiB → 400 `too_large`. Whitespace-only → 400 `empty`.

- [ ] **Step 1: Write the failing tests:**

```python
def test_private_text_visible_to_sender_and_recipient_only(client, make_client):
    a = login(client, "ayman@southerniot.net"); r = login(make_client(), "rahim@southerniot.net")
    n = login(make_client(), "nusrat@southerniot.net")
    item = a.post("/api/items/text", json={"title":"cfg","body":"x","recipient_ids":[r.me["id"]],"is_global":False}).json()
    assert [i["id"] for i in a.get("/api/items?section=private").json()] == [item["id"]]
    assert [i["id"] for i in r.get("/api/items?section=private").json()] == [item["id"]]
    assert n.get("/api/items?section=private").json() == []
    assert a.get("/api/items?section=global").json() == []

def test_global_text_in_everyones_global_section(client, make_client): ...
def test_global_account_sees_only_global(client, make_client): ...
def test_text_limits(client): ...   # 1 MiB + 1 byte → too_large; "   " → empty; no recipients and not global → no_recipients
def test_untitled_text_named_after_first_line(client, make_client): ...   # body "\n\n  Gateway IP: 10.10.8.51\nmore" → name "Gateway IP: 10.10.8.51"; a 200-char first line → 80 chars
def test_global_drops_people(client, make_client): ...   # is_global with recipient_ids=[rahim] → item.recipients == [] and it is in everyone's global section, nobody's private
def test_pagination_has_no_gaps_or_repeats(client, make_client, db_session): ...   # 120 items, 7 sharing one created_at; walk pages of 50 via next → 120 unique ids in order, last next is None
def test_nfc_names(client, make_client): ...   # title in NFD ("Cafe\u0301") comes back NFC ("Caf\u00e9")
def test_cannot_send_to_self_or_disabled(client, make_client): ...   # 400 unknown_recipient
def test_expired_items_hidden(client, db_session): ...   # set expires_at in the past → not listed
def test_html_in_title_kept_as_plain_text(client): ...   # title "<b>x</b>" comes back byte-identical (escaping is the frontend's job)
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): text items with Private and Global sections`.

### Task 8: Delete with audit, downloads and folder entries

**Files:**
- Modify: `backend/app/routers/items.py`
- Create: `backend/app/storage.py`, `backend/tests/test_downloads.py`

**Interfaces:**
- Produces:
  - `storage_path(kind: Literal["files","vault"], storage_id: str) -> Path`, which raises `ValueError` unless `storage_id` matches `^[0-9a-f]{32}$`.
  - `accel_path(kind, storage_id) -> str` = `/protected/<kind>/<ab>/<id>`.
  - `free_bytes() -> int`.
  - `DELETE /api/items/{id}`: visible → delete the row and its files on disk (folder entries too), write `audit_log(action="delete", item_name=…)`, return 204. Not visible → 404.
  - `GET /api/items/{id}/download[?inline=1]` and `GET /api/items/{id}/entries[/{entry_id}/download]`. The response body is empty, with these headers:
    - `X-Accel-Redirect`;
    - `Content-Type` = the stored mime, except `application/octet-stream` for anything that will be an attachment;
    - `Content-Disposition` = `attachment; filename*=UTF-8''<percent-encoded>`, or `inline` + the same `filename*` when inline is allowed;
    - `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
  - Inline is allowed only when `inline=1` and the mime is one of `image/png, image/jpeg, image/gif, image/webp, video/mp4` (then also `Content-Security-Policy: sandbox`) or `application/pdf` (no sandbox header). HTML, SVG and everything else are always attachments.
  - Text items have no download: 400 `not_a_file`.

- [ ] **Step 1: Write the failing tests** (files are created with the `make_item(..., kind="file", storage_id=…, mime=…)` fixture, which writes a small file to `storage_path`):

```python
def test_download_returns_accel_header_not_bytes(client, file_item):
    r = client.get(f"/api/items/{file_item.id}/download")
    assert r.status_code == 200 and r.content == b""
    assert r.headers["x-accel-redirect"] == f"/protected/files/{file_item.storage_id[:2]}/{file_item.storage_id}"
    assert r.headers["cache-control"] == "private, no-store"

@pytest.mark.parametrize("mime,inline_ok", [("application/pdf", True), ("image/png", True),
    ("text/html", False), ("image/svg+xml", False), ("application/zip", False)])
def test_inline_only_for_safe_types(client, make_file_item, mime, inline_ok): ...

def test_filename_with_quotes_and_unicode_encoded(client, make_file_item):
    it = make_file_item(name='রিপোর্ট "final".pdf', mime="application/pdf")
    cd = client.get(f"/api/items/{it.id}/download").headers["content-disposition"]
    assert cd.startswith("attachment; filename*=UTF-8''") and '"' not in cd.split("''",1)[1]

def test_outsider_gets_404_for_download_and_delete(client, make_client, file_item): ...
def test_delete_removes_file_and_writes_audit(client, file_item, db_session): ...
def test_storage_path_rejects_non_hex_ids():
    for bad in ["../etc/passwd", "/abs", "ab", "g"*32]:
        with pytest.raises(ValueError): storage_path("files", bad)
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): delete with audit and safe download headers`.

### Task 9: Expiry job

**Files:**
- Create: `backend/app/jobs.py`, `backend/tests/test_jobs.py`
- Modify: `backend/app/main.py` (lifespan starts the hourly loop)

**Interfaces:**
- Produces: `run_cleanup(db, settings, now: datetime) -> CleanupReport(items_deleted: int, uploads_deleted: int, errors: int)`. It deletes items whose `expires_at <= now` and their files, plus uploads not completed within 24 h and their tmp files. Each item is handled in its own `try/except`, so one failure is counted and logged and the loop continues. `start_cleanup_loop(app)` runs `run_cleanup` every 3600 s in an asyncio task, cancelled at shutdown. **Vault rows are never touched.**

- [ ] **Step 1: Write the failing tests:**

```python
def test_cleanup_deletes_only_expired(db_session, app_settings, make_item): ...   # one expired, one fresh → items_deleted == 1, fresh remains
def test_cleanup_continues_after_one_failure(db_session, app_settings, make_item, monkeypatch): ...   # make deleting one file raise → errors == 1, the other expired item still deleted
def test_cleanup_never_touches_vault(db_session, app_settings, make_vault_item): ...
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(backend): hourly expiry and stale-upload cleanup`.

### Task 10: Security regression suite for the 2026-11-01 audit

**Files:**
- Create: `backend/tests/test_audit_regressions.py`

**Interfaces:**
- Consumes: everything above. No production code changes are expected. Any failure here is a bug to fix in the owning module, within this task.

- [ ] **Step 1: Write the tests**, one per v1 finding that applies to plan 1's surface. Each test's docstring names the v1 finding.

```python
def test_v1_no_auth__every_api_route_needs_a_session(raw_client, app):
    """v1: no login on any route."""
    open_routes = {"/api/health", "/api/auth/register", "/api/auth/login"}
    for route in app.routes:
        if getattr(route, "path", "").startswith("/api") and route.path not in open_routes:
            for m in route.methods - {"HEAD", "OPTIONS"}:
                r = raw_client.request(m, route.path.replace("{id}", "x").replace("{entry_id}", "x"),
                                       headers={"X-Requested-With": "fs"})
                assert r.status_code in (401, 422), (m, route.path, r.status_code)

def test_v1_traversal_delete__ids_are_not_paths(client): ...   # DELETE /api/items/..%2f..%2fapp.db → 404, and DATA_DIR/app.db still exists
def test_v1_inline_html__never_served_inline(client, make_file_item): ...   # text/html with ?inline=1 → attachment + octet-stream
def test_v1_csrf__cross_site_post_rejected(raw_client): ...   # no X-Requested-With → 403
def test_v1_huge_text__rejected(client): ...   # 1 MiB + 1 → 400 too_large
```

- [ ] **Step 2: Run** `uv run pytest -q`. Expected: all PASS (fix the owning module if not).
- [ ] **Step 3: Run the full gate:** `uv run pytest -q && uv run ruff check .`. Expected: 0 failures, ruff clean.
- [ ] **Step 4: Commit** `test(backend): regression tests for the 2026-11-01 security audit`.

---

## Done when

- `make backend-test` and `make backend-lint` pass.
- `make backend-dev` starts the server. `curl localhost:8000/api/health` gives `{"ok":true}`, and the register → login → text → list → delete round trip works with curl, using `-H 'X-Requested-With: fs'` and a cookie jar.
- No secret value appears anywhere in the repo (`git grep -n "$SHARED_PASSWORD"` finds nothing, run with the real value exported).
