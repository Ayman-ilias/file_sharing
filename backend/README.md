# Backend

FastAPI on Python 3.12, SQLite (WAL) for metadata, files on disk under random IDs. Managed with `uv`.

```
backend/
├── pyproject.toml / uv.lock     dependencies, pinned
├── app/
│   ├── main.py                  create_app(): routers, middleware, startup jobs
│   ├── config.py                Settings from environment variables
│   ├── db.py                    engine, session, SQLite pragmas
│   ├── models.py                tables (users, sessions, items, uploads, vault, audit)
│   ├── security.py              password hashing, session tokens, CSRF check, client IP
│   ├── deps.py                  current_user, require_regular_user
│   ├── storage.py               file paths by storage ID, free-space check
│   ├── jobs.py                  hourly expiry and stale-upload cleanup
│   ├── events.py                in-process broker for live updates (SSE)
│   └── routers/                 auth, users, items, uploads, events, vault
├── migrations/                  Alembic
├── scripts/import_v1.py         one-time import of v1 uploads
└── tests/                       pytest; one regression test per 2026-11-01 audit finding
```

Built by plans 1, 2, 4 and 5 in `docs/superpowers/plans/`.

## Running

- Tests: `make backend-test` (pytest) · lint: `make backend-lint` (ruff) · dev server: `make backend-dev` (port 8000, dummy password from your shell's `SHARED_PASSWORD`).
- Always start uvicorn with `--no-server-header`: uvicorn adds `Server: uvicorn` below the ASGI layer, so the app's middleware can't remove it.
- Run exactly **one** worker: the login rate limiter and (plan 2) live events are in-process.

## Upload protocol (plan 2)

1. `POST /api/uploads` with `client_key` (a fingerprint of the file **and** its recipients), name, size, mime and recipients. The answer is `{upload_id, chunk_size, received}`. If the same user, key, size and recipients have an unfinished upload, it is resumed (200) and `received` lists the chunks already stored.
2. Send the missing chunks: `PUT /api/uploads/{id}/chunks/{n}`, with a body of exactly `chunk_size` bytes (the last one shorter). The browser sends 4 at a time per file. Repeats and any order are fine.
3. `POST /api/uploads/{id}/complete` → 201 with the item. Calling it again gives 200 with the same item. That's safe after a dropped connection.
4. **Folders:** `POST /api/batches` → `POST /api/batches/{id}/files` (≤ 500 files per call) → send each file's chunks (a file completes by itself when its last chunk lands) → `POST /api/batches/{id}/complete` → the folder item plus any failed paths.
5. **Refusals happen before any bytes:** 413 `too_large`, 507 `disk_full`, 429 `upload_quota`. Each chunk needs a `Content-Length` (fetch with a Blob sends one); chunked transfer encoding gets 411 `length_required`.
6. **Live updates:** `GET /api/events` (SSE) sends `item.created` / `item.deleted` frames and a `: ping` every 25 s. After a reconnect, refetch the list.
7. Folders download as one zip (`/api/items/{id}/zip`, exact `Content-Length`); single files inside download (and resume) on their own.
