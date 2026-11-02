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
