# SDD ledger — plan: docs/superpowers/plans/2026-11-01-plan-1-backend-foundation.md
Spec: docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md (read; §3.8 corner cases binding). Executor: inline (executing-plans), owner said "start the development" 2026-11-02.
Baseline commit: f2584b3

## Pre-flight (shared interfaces)
- T3 test uses `raw_client`; T4 lists it among helpers. Ruling: define `raw_client` in T3 conftest — T3 needs it first — cost if wrong: none.
- T4 helper list includes `make_file_item`/`file_item` (needs `storage_path` from T8) and `make_vault_item` (T9). Ruling: add those fixtures in the tasks that first use them (T8, T9) — avoids T4 depending on later code — cost if wrong: none.
- T3 CSRF test posts to /api/auth/logout before T4 creates it. Ruling: fine — CSRF middleware answers 403 before routing; test stays — cost if wrong: test passes for the wrong reason, rechecked in T4.
- T7 list shape {items,next} (roadmap 2026-11-02) vs earlier `[Item]` wording in T7 test snippets (`.json()` used as list). Ruling: tests read `.json()["items"]` — roadmap contract is binding — cost if wrong: test edits.
Task 1: Ruling: dev test client uses httpx2 instead of httpx — Starlette 1.10 deprecates httpx for TestClient (warning) — cost if wrong: swap one dev dep
Task 1: complete (commits f2584b3..e6e5fd1, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 2: Ruling: upgrade_db(settings, engine) instead of upgrade_db(settings) — migrations must run on the app engine so WAL/foreign_keys pragmas apply (root cause of RED WAL test) — cost if wrong: one signature
Task 2: complete (commits e6e5fd1..6bf42fd, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 3: Ruling: client_ip(request, *, trust_x_real_ip) takes the flag as an argument instead of reading settings — keeps it pure/testable — cost if wrong: none. Middleware is pure ASGI (not BaseHTTPMiddleware) so SSE/zip streams in plan 2 are not buffered.
Task 3: complete (commits 6bf42fd..a619085, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 4: Ruling: logout requires a session (401 without) — Task 10 requires every non-open /api route to need a session — cost if wrong: logout without cookie returns 401 instead of 204 (harmless for the UI).
Task 4: Ruling: backend accepts only full addresses (name@domain); reducing a pasted address / adding @southerniot.net is the frontend's job (spec §3.8) — keeps one strict rule server-side — cost if wrong: one helper.
Task 4: Ruling: ruff B008 configured with extend-immutable-calls for fastapi.Depends/Query/... instead of per-line noqa — standard FastAPI pattern — cost if wrong: none.
Task 4: complete (commits a619085..78b3427, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 5: Ruling: check order global(403) → current password(401) → length(400) — never reveal policy before proving identity — cost if wrong: error order only.
Task 5: complete (commits 78b3427..a05136c, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 6: complete (commits a05136c..80e0b18, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 7: Ruling: a bad `before` cursor returns 400 `bad_cursor` (not 422) — it's a client-supplied opaque token, not a schema error — cost if wrong: status code only.
Task 7: Ruling: text body is stored exactly as sent (no NFC); only names/titles are NFC-normalised — never alter user content — cost if wrong: none.
Task 7: complete (commits 80e0b18..ca2b9d2, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 8: Ruling: storage_path(data_dir, kind, storage_id) / free_bytes(data_dir) take the data dir explicitly (plan wrote storage_path(kind, id)) — no hidden global settings — cost if wrong: one argument.
Task 8: Ruling: Content-Disposition sends only RFC 5987 `filename*=UTF-8''…` (no ASCII `filename=` fallback) — all supported browsers read filename*; avoids quoting bugs — cost if wrong: ancient clients see a generic name.
Task 8: Ruling: a folder item's /download gives 400 not_a_file; whole folders download via /zip in plan 2 — cost if wrong: none.
Task 8: Note for plan 5: nginx must keep the upstream Content-Type/Content-Disposition/CSP headers on X-Accel-Redirect responses — verify in the deploy task.
Task 8: complete (commits ca2b9d2..44d2dba, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 9: Ruling: when deleting an expired item's file fails, its row is KEPT (rollback) and retried next hour — deleting the row would orphan the file on disk forever — cost if wrong: none for users — lists already hide it via expires_at > now; only the file lingers ≤1 h (wording corrected after review).
Task 9: Ruling: tmp files of uploads live at tmp/<ab>/<id> via storage_path (roadmap wrote tmp/<id>) — one path rule for everything — cost if wrong: plan 2 must use storage_path("tmp", …), noted.
Task 9: complete (commits 44d2dba..0f8ba6d, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 10: Ruling: route discovery uses app.openapi()["paths"] — FastAPI 0.162 wraps included routers in _IncludedRouter, so app.routes misses them (the plan's loop checked 0 routes and would have passed vacuously; guard checked >= 10 added) — cost if wrong: none.
Task 10: Ruling: openapi_url=None — the public /openapi.json mapped every endpoint for anonymous visitors; tests still use app.openapi() — cost if wrong: re-enable for local dev if wanted.
Task 10: complete (commits 0f8ba6d..31e358c, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)

## Final review (fresh reviewer, opus) — "With fixes", 0 Critical
Final: fixed Important-2 rate limiter never forgot keys — test_rate_limiter_forgets_idle_keys / test_rate_limiter_caps_total_keys RED→GREEN, suite 107/107
Final: fixed Important-3 lists carried full 1 MiB text bodies — test_list_sends_a_preview_not_the_whole_text RED→GREEN (lists: 2000-char preview + text_truncated + line_count; new GET /api/items/{id}), suite 107/107
Final: fixed (re-graded Minor→Important: a reasonable user loses the safety banner while still exposed) shared password accepted as own — test_cannot_set_the_shared_password_as_own RED→GREEN, suite 107/107
Final: fixed (re-graded Minor→Important: the whole office reaches the API from one public IP; a Monday rush hits 429) successful logins counted toward the limit — test_successful_logins_are_not_rate_limited RED→GREEN, suite 107/107
Final: fixed (re-graded: plan Global Constraint) Server: uvicorn header — not testable in-process; `--no-server-header` in Makefile + README + deploy README
Final: fixed Review-Focus test gaps — test_padded_mixed_case_email_logs_in, test_hostile_names_are_plain_data[3], no-auth test tightened to == 401 (passed at once: behaviour already existed; coverage only)
Final: Ruling: Important-1 nginx drops nosniff/CSP on X-Accel-Redirect — not plan-1 code; recorded as a hard requirement in deploy/README.md for plan 5 with an e2e header test — cost if wrong: previews unsandboxed in prod if plan 5 skips it
Final: minor (deferred): login timing distinguishes shared-password users from unknown emails (register already reveals existence by contract)
Final: minor (deferred): crafted naive-timestamp cursor gives 500 instead of 400
Final: minor (deferred): 500 responses lack security headers (ServerErrorMiddleware is outside SecurityMiddleware)
Final: minor (deferred): delete commits the row before unlinking; an unlink error returns 500 and orphans the file
Final: minor (deferred): concurrent duplicate register can raise IntegrityError → 500
Final: minor (deferred): no max length on passwords before Argon2 (CPU cost; limited by rate limiter)
Final: minor (deferred): expired session rows are never purged
Final: minor (deferred): migration 0001 imports app.db.UTCDateTime (renaming it later breaks the chain)
