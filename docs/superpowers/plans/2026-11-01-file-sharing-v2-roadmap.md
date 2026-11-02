# File Sharing v2: Roadmap and Shared Contracts

**Spec:** [docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md](../specs/2026-11-01-file-sharing-v2-design.md)
**Approved UI (final, must match exactly):** [docs/design/mockup.html](../../design/mockup.html) (main screens) + [docs/design/states.html](../../design/states.html) (every other state and action, added 2026-11-02), with screenshots in [docs/design/reference/](../../design/reference/)
**Branch:** `feature/v2`. v1 is preserved as the local tag `v1`. Never commit to `main`, never push without the owner's say-so.

The spec covers five subsystems. Each gets its own plan, and each plan ends with software that runs and is tested on its own. Plan 1 is written in full now. Plans 2–5 are written at the start of their milestone, against the code that exists by then, and use the contracts below unchanged.

## Milestones

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | [Backend foundation](2026-11-01-plan-1-backend-foundation.md) | Settings, DB and migrations, accounts (register, login, sessions, change password, global account), user list, text items, Private/Global listing, delete with audit, download headers, expiry job, security regression tests | — |
| 2 | Transfers | Chunked parallel resumable uploads (16 MiB chunks), folders, streaming zip, live events (SSE), disk-space checks | 1 |
| 3 | Frontend: Sharing, login, profile | The mockup rebuilt in React, wired to plans 1–2: animated background, top tabs, upload card with progress, Private/Global, item cards, photo peek, PDF and links in a new tab, login and register, profile drawer, password nudge; Playwright screenshot checks | 1, 2 |
| 4 | My storage | Client-side encrypted vault (AES-256-GCM, PBKDF2-SHA-256 600 000 iterations), storage password, 200 MB quota, 20-minute auto-lock, notes, links, passwords, photos and files | 1, 2, 3 |
| 5 | Deploy, import, benchmark | nginx and compose, Dockerfiles (non-root, pinned), `import_v1.py`, benchmark through `files.southerneleven.com`, security re-test (rerun the 2026-11-01 attack set), cutover runbook for the owner | 1–4 |

## Tooling (verified on the Mac, 2026-11-01)

| Tool | Version | Use |
|---|---|---|
| uv | 0.13.6 | Python env and lock; `uv python install 3.12` (3.12 matches the Docker image; the Mac's default 3.15 is not used) |
| Node / npm | 26.13 / 11.20 | Frontend dev and build; the Docker build stage pins the same major |
| Google Chrome | installed | Playwright uses its own browsers (`npx playwright install chromium`) |

## Shared contracts (all plans use these names unchanged)

### Data on disk (`DATA_DIR`, default `./data` locally, `/data` in Docker)

```
DATA_DIR/app.db            SQLite, WAL mode
DATA_DIR/files/<ab>/<id>   shared file contents; <id> = uuid4 hex, <ab> = first 2 chars
DATA_DIR/vault/<ab>/<id>   encrypted My storage blobs (ciphertext only)
DATA_DIR/tmp/<upload_id>   uploads in progress
```

No user-supplied name is ever part of a path.

### Settings (environment variables, `app/config.py`)

| Variable | Default | Meaning |
|---|---|---|
| `SHARED_PASSWORD` | (required, no default) | Starting password for every account and the fixed password of the global account |
| `ALLOWED_EMAIL_DOMAIN` | `southerniot.net` | Only this domain may register |
| `GLOBAL_EMAIL` | `global@southerniot.net` | The fixed global account |
| `DATA_DIR` | `./data` | Where the DB and files live |
| `COOKIE_SECURE` | `true` | `false` only for local http dev |
| `SESSION_DAYS` | `30` | Sliding session lifetime |
| `ITEM_TTL_DAYS` | `30` | Shared items expire after this |
| `MAX_FILE_SIZE` | `10737418240` (10 GiB) | Largest single shared file |
| `MAX_TEXT_BYTES` | `1048576` (1 MiB) | Largest text item |
| `MAX_BATCH_FILES` | `5000` | Most files in one folder upload |
| `CHUNK_SIZE` | `16777216` (16 MiB) | Upload chunk size |
| `DISK_MARGIN` | `2147483648` (2 GiB) | Free space that must remain after an upload |
| `VAULT_QUOTA` | `209715200` (200 MiB) | My storage limit per user (ciphertext bytes) |
| `TRUST_X_REAL_IP` | `true` | Read the client IP from nginx's `X-Real-IP`; nginx sets it from `CF-Connecting-IP` only for `TRUSTED_PROXIES` |

### Tables (`app/models.py`)

| Table | Columns |
|---|---|
| `users` | id (int pk), email (unique, lowercase), username (unique: email local part), password_hash (nullable: null = still on the shared password), is_global (bool), disabled_at (nullable), created_at |
| `sessions` | token_hash (pk, sha256 hex), user_id, created_at, expires_at |
| `items` | id (uuid hex pk), kind (`file`/`folder`/`text`), name, size (bytes), mime, sender_id, is_global, text_body (nullable), storage_id (nullable), file_count (folders), created_at, expires_at |
| `item_recipients` | item_id, user_id (pk pair) |
| `folder_entries` | id, item_id, relative_path, size, storage_id, mime |
| `uploads` | id, user_id, target (`share`/`vault`), client_key (fingerprint of file + recipients; resume only on an exact match), name, size, mime, chunk_size, received (JSON list of chunk numbers), received_bytes, batch_id, relative_path, recipient_ids (JSON, sorted), is_global, storage_id (= id once stored), item_id (set on completion: retries return it), created_at, updated_at (idle check), completed_at |
| `batches` | id, user_id, name, file_count (expected), recipient_ids (JSON, sorted; [] when global), is_global, created_at, updated_at, completed_at, item_id (plan 2) |
| `audit_log` | id, actor_id, action (`delete`/`password_change`/`vault_erase`/`user_disabled`), item_id, item_name, at |
| `vault_keys` | user_id (pk), salt (b64), iterations, wrapped_key (b64), updated_at |
| `vault_items` | id (uuid hex), user_id, meta_ct (b64: encrypted JSON of kind, title, fields), blob_id (nullable), size_bytes (ciphertext), version (int, +1 on each update), created_at, updated_at |

Visibility rule, used everywhere: a user sees an item if they are its sender, or a recipient, or it is global. The global account sees only global items. A global item never has recipient rows (choosing Global replaces people). Disabled users cannot sign in and are not listed, but their items stay until they expire. Names are stored in Unicode NFC.

### HTTP API (JSON under `/api`; every POST/PUT/DELETE must carry the header `X-Requested-With: fs`)

| Method and path | Plan | Request → response |
|---|---|---|
| `POST /api/auth/register` | 1 | `{email}` → 201 `{email, username}`; 200 if already registered; 400 `domain_not_allowed`; 400 `reserved` for the global email |
| `POST /api/auth/login` | 1 | `{email, password}` → 200 `Me` + cookie `fs_session`; 401 `bad_credentials`; 429 `too_many_attempts` after 10 **failed** logins per client IP per minute (successful logins don't count: the office shares one IP) |
| `POST /api/auth/logout` | 1 | → 204, cookie cleared |
| `GET /api/auth/me` | 1 | → `Me` = `{id, email, username, is_global, uses_shared_password}` |
| `POST /api/auth/password` | 1 | `{current_password, new_password}` → 204; 400 `too_short` (< 10 chars) / `same_as_shared`; 401 `bad_credentials`; 403 `global_account` |
| `GET /api/users` | 1 | → `[{id, username, email}]` of other regular users, sorted by username |
| `GET /api/items?section=private\|global[&before=<cursor>][&limit=50]` | 1 | → `{items: [Item], next: cursor\|null}` newest first, not expired; limit 1–200 |
| `POST /api/items/text` | 1 | `{title?, body, recipient_ids, is_global}` → 201 `Item` (no title → first non-empty line, ≤ 80 chars; `is_global` → recipients dropped); 400 `no_recipients` / `too_large` / `empty` / `unknown_recipient` |
| `GET /api/items/{id}` | 1 | → `Item` with the full text; 404 if not visible |
| `DELETE /api/items/{id}` | 1 | → 204; 404 if not visible |
| `GET /api/items/{id}/download[?inline=1]` | 1 | → 200 with `X-Accel-Redirect: /protected/files/<ab>/<id>` and safe headers (see plan 1, task 8) |
| `GET /api/items/{id}/entries` | 1 | folder → `[{id, relative_path, size}]` |
| `GET /api/items/{id}/entries/{entry_id}/download` | 1 | as download |
| `GET /api/items/{id}/zip` | 2 | streamed zip (stored, Zip64) |
| `POST /api/uploads` | 2 | `{client_key, name, size, mime, recipient_ids, is_global, target, batch_id?, relative_path?}` → `{upload_id, chunk_size, received}` (an unfinished upload with the same `client_key` is resumed); 413 `too_large`; 507 `disk_full`; 413 `quota_exceeded` (vault). Zero-byte files are allowed |
| `PUT /api/uploads/{id}/chunks/{n}` | 2 | raw body → 204 |
| `GET /api/uploads/{id}` | 2 | → `{received: [n…]}` |
| `POST /api/uploads/{id}/complete` | 2 | → `Item` (share) or `{blob_id}` (vault) |
| `DELETE /api/uploads/{id}` | 2 | cancel → 204 |
| `POST /api/batches` / `POST /api/batches/{id}/complete` | 2 | `{name, file_count, recipient_ids, is_global}` → `{batch_id}` (400 `too_many_files` over `MAX_BATCH_FILES` = 5000) / folder `Item` + `failed: [relative_path]` |
| `GET /api/events` | 2 | SSE: `item.created` `{item}`, `item.deleted` `{id, by: username\|null}` (null = expired); heartbeat every 25 s; the client refetches the list after a reconnect |
| `GET /api/vault` | 4 | → `{initialized, salt, iterations, wrapped_key, used_bytes, quota_bytes}` |
| `POST /api/vault/setup` / `PUT /api/vault/key` | 4 | `{salt, iterations, wrapped_key}` → 204; 409 `already_initialized` / 404 `not_initialized` |
| `POST /api/vault/erase` | 4 | `{confirm: "ERASE"}` → 204 (deletes all vault items, blobs and the key) |
| `GET/POST /api/vault/items`, `PUT/DELETE /api/vault/items/{id}` | 4 | ciphertext only; PUT carries `version` → 409 `stale_version` |
| `GET /api/vault/items/{id}/blob` | 4 | ciphertext via X-Accel-Redirect |
| (all `/api/vault/*`) | 4 | 403 `global_account` for the global account |

`Item` = `{id, kind, name, size, mime, sender: {id, username}, recipients: [{id, username}], is_global, text_body (text items only), text_truncated, line_count (text only), file_count (folders only), created_at, expires_at}`. Times are ISO 8601 UTC. **Lists carry at most the first 2000 characters of a text** (`text_truncated: true`). `GET /api/items/{id}` returns the whole item; the card's "Show all N lines" calls it (code review 2026-11-02).

### Frontend contract

- The CSS and class names come from `docs/design/mockup.html` unchanged. Components output the same markup.
- Screenshot parity: Playwright renders the app with fixture data identical to the mockup's sample data, with `reducedMotion: 'reduce'` (no bubbles or drift), and compares against references re-captured from the mockup under the same settings. Tolerance: `maxDiffPixelRatio: 0.01`.
- One gap in the mockup is decided here: **Delete** asks inline. The bin icon turns into a red "Delete?" button for 4 seconds, and a second click deletes. No modal.
