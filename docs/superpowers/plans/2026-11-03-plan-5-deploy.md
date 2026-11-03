# Plan 5 — Deploy (Docker, nginx, runbook) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package v2 as two pinned, non-root containers behind one published port (5000), with an ops script, backups and a copy-paste runbook, so the owner can bring `files.southerneleven.com` back up.

**Architecture:** `sif-web` (nginx, unprivileged) serves the built SPA, proxies `/api/*` to `sif-api`, and streams files from the shared data folder through `X-Accel-Redirect`. `sif-api` (uvicorn, one worker) is reachable only on the compose network. Code is a git checkout in `/opt/southern-iot/file-sharing/app`; data, backups and `.env` live beside it, outside the checkout.

**Tech Stack:** Docker Compose v2, `python:3.12-slim` + uv, `node:22` build stage, `nginxinc/nginx-unprivileged` (alpine), bash, Python stdlib for the smoke test, Playwright (existing) for the browser check.

**Spec:** `docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md` (§5, §6.2–6.4, §6.7, §8, §9); hard requirements in `deploy/README.md`; settings table in `docs/superpowers/plans/2026-11-01-file-sharing-v2-roadmap.md`.

## Decisions taken 2026-11-03 (owner) that override the spec

- **No v1 import.** The owner deleted v1 and its uploads (no backup). v2 starts empty. Spec §9's importer, spare-port test and rollback are dropped.
- **Folder:** `/opt/southern-iot/file-sharing/` = `app/` (git checkout), `data/`, `backups/`, `.env` (mode 600). Compose project `southern-iot-files`, containers `sif-web` and `sif-api`.
- **One published port:** 5000 → `sif-web`. Nothing else is published.
- **Benchmark and full security re-test happen after go-live** (the site is down; they need the real Cloudflare path). This plan ships the scripts and the checklist; results go to `docs/benchmarks.md` later.

## Global Constraints

- Host port `PUBLIC_PORT` (default `5000`) is the only published port. `sif-api` has no `ports:`.
- Both containers run as **uid:gid 10001:10001**. Reason: uploads are written with mode `0600` (`backend/app/transfers.py:96`), so nginx must be the same user to read them for `X-Accel-Redirect`.
- uvicorn: `--factory app.main:create_app --host 0.0.0.0 --port 8000 --workers 1 --no-server-header`.
- Images pinned by exact tag (no `latest`, no floating major): `python:3.12.x-slim-bookworm`, `node:22.x-bookworm-slim`, `nginxinc/nginx-unprivileged:1.x.y-alpine` — the implementer picks the newest patch at build time and writes it in the file.
- `SERVE_FILES=false` and `COOKIE_SECURE=true` in production. `SHARED_PASSWORD` only in `.env`, never in git, never printed.
- `/protected/` is `internal;` and adds `X-Content-Type-Options nosniff`, `X-Frame-Options DENY`, `Referrer-Policy same-origin`, and `Content-Security-Policy` via `map $sent_http_content_type $fs_csp { ~^application/pdf ""; ~^(image|video)/ "sandbox"; default ""; }` (deploy/README.md).
- nginx accepts only clients in `TRUSTED_PROXIES` (default `10.10.8.100`) and `127.0.0.1`; others get 403. `X-Real-IP` = `CF-Connecting-IP`, else first `X-Forwarded-For`, else `$remote_addr`, and only for trusted clients.
- `client_max_body_size 20m` (16 MiB chunk + margin); `proxy_request_buffering off` on `/api/uploads/`; `proxy_buffering off` and `proxy_read_timeout 1h` on `/api/events`.
- SPA headers: `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, plus nosniff, `X-Frame-Options DENY`, `Referrer-Policy same-origin`, `server_tokens off`. `index.html` gets `Cache-Control: no-cache`; `/assets/*` (hashed) get `Cache-Control: public, max-age=31536000, immutable`. Unknown paths fall back to `index.html`.

## Review Focus

1. **Docker hides the proxy's IP** (userland proxy / NAT): every request would get 403 and the site stays down. → Task 2 smoke run reports the client IP nginx saw; runbook step checks the access log for `10.10.8.100` and says how to fix `TRUSTED_PROXIES`.
2. **Data folder owned by root on first start:** the API can't create `files/ vault/ tmp/` and restarts forever. → `sif.sh up` creates `data/` and `backups/` and `chown 10001:10001`; Task 4 test starts from a root-owned empty folder.
3. **A file uploaded through nginx can't be downloaded** (permissions, wrong alias path, headers dropped). → Task 2 smoke uploads in 2 chunks through nginx, downloads, compares sha256, checks Range 206 and the security headers.
4. **CSP blocks the real app** (blob thumbnails, fonts, inline styles) — only visible in a browser. → Task 3 Playwright run against the nginx stack fails on any CSP console error.
5. **A redeploy/update loses data or the session secret** (data inside the checkout, `git clean`, `down -v`). → data is a bind mount outside `app/`; Task 4 test runs `sif.sh update` and checks a previously sent item is still there.

## Corner-case review (2026-11-03, independent opus reviewer) — binding changes

These override the task text below where they differ.

1. **(Critical) Compose reads `PUBLIC_PORT`/`TRUSTED_PROXIES` only from the shell or `--env-file`.** `sif.sh` always runs `docker compose --env-file "$SIF_HOME/.env" -p southern-iot-files -f "$APP/deploy/compose.yaml"`. `web` gets `TRUSTED_PROXIES` through interpolation of that env file. `ops.sh` sets `TRUSTED_PROXIES` only in `.env` and checks the 403. Runbook: `.env` values are `$`-expanded, so the password must avoid `$` or be single-quoted.
2. **nginx as uid 10001 can't write `conf.d`** (the image's envsubst step fails silently and the stock config runs). Don't use the templates mechanism: copy a finished `default.conf`, and the entrypoint script writes only `/tmp/trusted.geo` (included from the config). `rm` the stock `default.conf`. `test_api_proxied` proves `/api/health` is JSON through nginx.
3. **`add_header` inheritance:** security headers live in `deploy/nginx/security-headers.conf` and are `include`d in every location that sets its own `add_header`. `location = /index.html` sets `no-cache`. `test_spa` checks the CSP on `/assets/*.js` too. `/api/` does not add X-Frame-Options / nosniff / Referrer-Policy (the API sends them; no duplicates).
4. **SSE behind the outer proxy:** `/api/events` adds `add_header X-Accel-Buffering no always;` and `proxy_http_version 1.1`. Post-go-live check through the real path is in the runbook.
5. **Client IP:** `X-Real-IP` = `CF-Connecting-IP` when the client is trusted and the header is present, else `$remote_addr`. Never the first `X-Forwarded-For` hop (client-controlled). Ruling: `CF-Connecting-IP` is trusted because the proxy fronts Cloudflare; the runbook asks the owner to confirm the proxy host only takes traffic from Cloudflare (otherwise someone on the LAN can rotate the header to dodge the login limit). Cost if wrong: a weaker login rate limit, not an open door (the password is still required).
6. **Backups:** restore = `down` → remove `app.db-wal`, `app.db-shm` → extract → `chown -R 10001:10001 data` → `up`. Keep the newest 14 archives **and** at most 5 GiB in total (oldest deleted first). `backups/` is mode 700. The runbook says these stay on the same disk and shows an off-VM `scp` step.
7. **Test on real Linux semantics:** `stack.sh` and `ops.sh` run inside the Colima VM (`colima ssh`) with `SIF_HOME` on a VM-local folder (`/tmp/...`), so ownership and the 0600 shared-uid reads behave as on the VM.
8. **`web` healthcheck:** `wget -qO- http://127.0.0.1:8080/api/health` (IPv4, not `localhost`).
9. **Folder zips:** `location ~ ^/api/items/[^/]+/zip$` with `proxy_buffering off`.
10. **`/protected/`:** two internal locations, `/protected/files/` → `/data/files/` and `/protected/vault/` → `/data/vault/`. Nothing else under `/data` (the DB) is reachable even internally.
11. **`TRUSTED_PROXIES` validation:** the entrypoint script checks every entry against an IPv4/IPv6 address or CIDR pattern; a bad one exits non-zero with a clear message naming it.
12. **Runbook:** check the proxy host allows ≥ 20m bodies and > 60 s read timeout; Cloudflare Rocket Loader and Email Obfuscation off; "if `web` won't start, read `sif.sh logs api` first".
13. **Pinning:** `uv` copied from `ghcr.io/astral-sh/uv:0.13.6`; `WORKDIR /app` (done in Task 1).

---

### Task 1: API image

**Files:**
- Create: `backend/Dockerfile`, `backend/.dockerignore`
- Test: `deploy/tests/api-image.sh`

**Interfaces:**
- Produces: image built from context `backend/`; listens on 8000; `DATA_DIR=/data`; runs as 10001; healthcheck `GET /api/health`.

- [ ] **Step 1: Write the failing test** `deploy/tests/api-image.sh` (bash, `set -euo pipefail`): build `sif-api:test` from `backend/`; assert `docker run --rm --entrypoint id sif-api:test -u` prints `10001`; assert `python -c "import pytest"` fails inside the image (no dev deps); run the container with `SHARED_PASSWORD=dummy-test-pass COOKIE_SECURE=false` and a `--tmpfs /data:uid=10001,gid=10001`, wait ≤ 30 s, and assert `docker exec … python -c "urllib.request.urlopen('http://127.0.0.1:8000/api/health')"` returns `{"ok": true}`; assert the response has no `server` header; always remove the container (trap).
- [ ] **Step 2: Run it** — `bash deploy/tests/api-image.sh` → FAIL (no Dockerfile).
- [ ] **Step 3: Write `backend/Dockerfile`**: multi-stage; builder copies `pyproject.toml uv.lock`, runs `uv sync --frozen --no-dev --no-install-project` into `/app/.venv`; final stage copies the venv, `app/`, `migrations/`, `alembic.ini`; `useradd -u 10001`; `ENV DATA_DIR=/data PYTHONUNBUFFERED=1 PATH=/app/.venv/bin:$PATH`; `USER 10001:10001`; `HEALTHCHECK` with python urllib; `CMD` per Global Constraints. `.dockerignore`: `.venv data* tests .env* __pycache__ .pytest_cache .ruff_cache`.
- [ ] **Step 4: Run it** → PASS. Also `make backend-test` → all green (nothing in the app changed).
- [ ] **Step 5: Commit** `feat(deploy): API image (non-root, pinned, one worker)`.

### Task 2: Web image, nginx and compose, proven by a smoke test

**Files:**
- Create: `deploy/web.Dockerfile` (context = repo root), `deploy/nginx/default.conf.template`, `deploy/nginx/40-trusted-proxies.sh`, `deploy/compose.yaml`, `deploy/.env.example`, `.dockerignore` (root)
- Test: `deploy/tests/smoke.py` (stdlib only), `deploy/tests/stack.sh`

**Interfaces:**
- Consumes: Task 1 image build (`build: ../backend`).
- Produces: compose project `southern-iot-files`; services `web` (`container_name: sif-web`) and `api` (`container_name: sif-api`); env `SIF_HOME` (folder holding `data/`, `backups/`, `.env`; default `../..` relative to `deploy/`), `PUBLIC_PORT` (default 5000), `TRUSTED_PROXIES` (space-separated IPs/CIDRs, default `10.10.8.100`). `smoke.py --base URL` exits 0 only if every check passes, and prints the client IP the API saw.

- [ ] **Step 1: Write the failing test.** `deploy/tests/stack.sh` makes a temp `SIF_HOME` (data/ backups/ .env with `SHARED_PASSWORD=smoke-pass-12345 COOKIE_SECURE=false LOGIN_RATE_LIMIT=1000`), runs `docker compose -f deploy/compose.yaml -p sif-smoke up -d --build` with `PUBLIC_PORT=5055 TRUSTED_PROXIES=0.0.0.0/0`, waits for health, runs `python3 deploy/tests/smoke.py --base http://127.0.0.1:5055`, then restarts with `TRUSTED_PROXIES=203.0.113.9` and asserts `GET /` → 403; always `down -v` and removes the temp folder. `smoke.py` checks, each a named function printing PASS/FAIL:
  - `test_spa`: `/` → 200, HTML with `<div id="root">`, CSP header equals the Global Constraints value, `Cache-Control: no-cache`, no `Server` version; `/some/deep/link` → same HTML; one `/assets/*.js` → `immutable`.
  - `test_api_proxied`: `/api/health` → `{"ok": true}`.
  - `test_upload_download`: register + login `smoke1@southerniot.net`; send a 20 MiB random file to Global in 2 chunks (`CHUNK_SIZE` from the start response); download → sha256 equal; headers include `content-disposition: attachment`, `x-content-type-options: nosniff`, `x-frame-options: DENY`, `cache-control: private, no-store`; `Range: bytes=0-99` → 206 and 100 bytes.
  - `test_inline_image_sandboxed`: upload a tiny PNG, `?inline=1` → `content-security-policy: sandbox`; a PDF `?inline=1` → no CSP header.
  - `test_protected_is_internal`: `GET /protected/files/ab/<any 32 hex>` → 404.
  - `test_body_limit`: a 21 MiB PUT to a chunk URL → 413 from nginx.
  - `test_sse`: open `/api/events` with the session cookie, receive the first bytes within 30 s (`event: ping` or a comment), response not buffered (`content-type: text/event-stream`).
  - `test_real_ip`: print the IP nginx forwarded (from a header the smoke can read, e.g. by sending `CF-Connecting-IP: 198.51.100.7` and confirming the login rate limiter keys on it: 11 bad logins with `LOGIN_RATE_LIMIT=10` from that header → 429, then one from another header value → 401 not 429). For this test `stack.sh` starts with `LOGIN_RATE_LIMIT=10` in a second short run, or smoke.py takes `--rate-limit 1000` and skips; implementer picks one and ledgers it.
- [ ] **Step 2: Run it** — `colima start` (if not running), `bash deploy/tests/stack.sh` → FAIL (no compose file).
- [ ] **Step 3: Implement.**
  - `deploy/web.Dockerfile`: stage `node:22.x` runs `npm ci && npm run build` in `frontend/`; final `nginxinc/nginx-unprivileged:…-alpine`, copies `dist/` to `/usr/share/nginx/html`, the template to `/etc/nginx/templates/`, the script to `/docker-entrypoint.d/` (executable). `USER 10001` is set in compose (`user: "10001:10001"`); nginx temp/pid paths must be writable by that uid (the unprivileged image uses `/tmp`; `chmod`/`chown` what it needs in the Dockerfile).
  - `40-trusted-proxies.sh` writes `/tmp/trusted.geo` (`127.0.0.1 1;` plus one `<entry> 1;` per `TRUSTED_PROXIES` item); the template uses `geo $fs_trusted { default 0; include /tmp/trusted.geo; }` and `if ($fs_trusted = 0) { return 403; }` in the server block.
  - `default.conf.template`: `listen 8080`; locations `/` (SPA, `try_files $uri /index.html`), `/assets/`, `/api/` (proxy to `http://api:8000`, `proxy_set_header X-Real-IP $fs_real_ip`, Host, no buffering for uploads), `/api/events` (SSE settings), `/protected/` (`internal; alias /data/;` + headers + `sendfile on`). Security headers per Global Constraints with `always`.
  - `compose.yaml`: `name: southern-iot-files`; `api`: `build: ../backend`, `env_file: ${SIF_HOME:-../..}/.env`, `environment: DATA_DIR=/data`, volumes `${SIF_HOME:-../..}/data:/data` and `${SIF_HOME:-../..}/backups:/backups`, `user: "10001:10001"`, `restart: unless-stopped`, healthcheck; `web`: build from root with `deploy/web.Dockerfile`, `ports: ["${PUBLIC_PORT:-5000}:8080"]`, `environment: TRUSTED_PROXIES=${TRUSTED_PROXIES:-10.10.8.100}`, volume `${SIF_HOME:-../..}/data:/data:ro`, `depends_on: api: condition: service_healthy`, `user: "10001:10001"`, `restart: unless-stopped`. Both: `logging` json-file `max-size: 10m, max-file: 3`.
  - `.env.example`: every roadmap setting with its default commented, `SHARED_PASSWORD=` empty, `LOGIN_RATE_LIMIT=100` with the comment "launch day; set back to 10 after a week", `PUBLIC_PORT=5000`, `TRUSTED_PROXIES=10.10.8.100`.
- [ ] **Step 4: Run it** → every smoke check PASS, 403 run PASS.
- [ ] **Step 5: Commit** `feat(deploy): nginx web image, compose, smoke test through nginx`.

### Task 3: Browser check through nginx (CSP, real app)

**Files:**
- Create: `frontend/e2e/deploy.spec.ts`, `frontend/playwright.deploy.config.ts`
- Modify: `deploy/tests/stack.sh` (add `--browser` option that runs this spec before `down`)

**Interfaces:**
- Consumes: the stack from Task 2 at `DEPLOY_BASE_URL` (no webServer in this config).

- [ ] **Step 1: Write the failing test** `deploy.spec.ts`: collect `page.on('console')` errors and `securitypolicyviolation` events; register + log in `browser1@southerniot.net` (shared password from `DEPLOY_SHARED_PASSWORD`), send text "hello from nginx" to Global, see it in the Global list; upload `logo.png` to Global and see its photo thumbnail; open Profile → set own login password; open My storage → create the vault with `storage-pass-123` → add a note → it shows. Final assertion: zero CSP violations and zero console errors. (http://127.0.0.1 is a secure context, so WebCrypto works.)
- [ ] **Step 2: Run** `bash deploy/tests/stack.sh --browser` → FAIL (spec runs against nothing / config missing).
- [ ] **Step 3: Implement** the config (`baseURL: process.env.DEPLOY_BASE_URL`, `testMatch: deploy.spec.ts`, Chrome channel) and fix whatever the run shows in `default.conf.template` (CSP only loosened with a ledger ruling naming the blocked resource).
- [ ] **Step 4: Run** → PASS; `npm test` and the existing `npx playwright test` still green (the main config must not pick up `deploy.spec.ts`: add it to `testIgnore`).
- [ ] **Step 5: Commit** `test(deploy): browser run through nginx with zero CSP violations`.

### Task 4: Ops script and backups

**Files:**
- Create: `deploy/sif.sh`
- Test: `deploy/tests/ops.sh`

**Interfaces:**
- Produces: `sif.sh <command>` run from anywhere; `SIF_HOME` = the folder above `app/` (derived from the script's own path: `deploy/` → `app/` → home). Commands:
  - `up` — refuses if `.env` is missing, has no `SHARED_PASSWORD`, or is not mode 600; creates `data/ backups/`, `chown -R 10001:10001` them; `docker compose … up -d --build`; waits for both healthy (≤ 120 s) and prints `UP on port <PUBLIC_PORT>`.
  - `down` — `docker compose … down` (never `-v`).
  - `status` — `ps` + the health JSON fetched **inside** `sif-web` (host `curl localhost` is not a trusted client).
  - `logs [web|api]` — `logs --tail 200 -f`.
  - `update <git-ref>` — `git -C app fetch --tags`, refuses on a dirty checkout, `checkout <ref>`, then `up`; prints old → new commit.
  - `backup` — inside `sif-api`: SQLite online backup (`sqlite3.Connection.backup`) of `/data/app.db` to `/backups/tmp`, then `tar czf /backups/sif-<UTC yyyy-mm-dd-HHMM>.tar.gz` of that db copy + `/data/vault`; keeps the newest 14 archives; prints the path and size. Shared files in `data/files` are not backed up (they expire in 30 days) — stated in the runbook.
- [ ] **Step 1: Write the failing test** `ops.sh`: temp home with `app/` = a `git worktree` of HEAD, `.env` mode 644 → `sif.sh up` exits non-zero with "chmod 600"; fix to 600, root-owned empty `data/` (use `sudo -n` only if available, else skip that sub-check and say so) → `up` → `UP`; send a text item via smoke helpers; `sif.sh backup` → archive exists and contains `app.db` and `vault/`; `sif.sh update HEAD` → still `UP` and the text item still listed; `down`; cleanup.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (bash, `set -euo pipefail`, `shellcheck`-clean). **Step 4: Run** → PASS, `shellcheck deploy/*.sh deploy/nginx/*.sh deploy/tests/*.sh` clean (if shellcheck is missing, say so; don't install without asking).
- [ ] **Step 5: Commit** `feat(deploy): sif.sh ops script with backups`.

### Task 5: Runbook and docs

**Files:**
- Create: `deploy/RUNBOOK.md`
- Modify: `deploy/README.md`, `README.md`, `docs/superpowers/plans/2026-11-01-file-sharing-v2-roadmap.md` (plan 5 ✔, §9 superseded note), `docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md` (§9: one line "superseded 2026-11-03: v1 deleted, no import")

- [ ] **Step 1: Write `RUNBOOK.md`** with exact, copy-paste commands for the VM (root shell), in order: prerequisites check (`docker compose version`, `git --version`, `df -h /`, `ss -ltnp | grep :5000` empty); `mkdir -p /opt/southern-iot/file-sharing && cd` there; `git clone --branch v2.0.0 https://github.com/Ayman-ilias/file_sharing.git app`; create `.env` from `app/deploy/.env.example` (`install -m 600`), edit `SHARED_PASSWORD`; `app/deploy/sif.sh up`; verify (`sif.sh status`; open the site; `sif.sh logs web` shows requests from `10.10.8.100` — if it shows a 172.x/other IP with 403, put that IP into `TRUSTED_PROXIES` in `.env` and `sif.sh up`); the nightly backup cron line (`15 2 * * * /opt/southern-iot/file-sharing/app/deploy/sif.sh backup >> /opt/southern-iot/file-sharing/backups/backup.log 2>&1`); after a week set `LOGIN_RATE_LIMIT=10` and `sif.sh up`; update procedure (`sif.sh update v2.0.1`); restore procedure from a backup archive; "what never to run" (`down -v`, `rm -r data`, `git clean -fdx` in app). After go-live checklist: benchmark (spec §8) and the 2026-11-01 attack set, results to `docs/benchmarks.md`.
- [ ] **Step 2: Verify** every command in the runbook was exercised by Tasks 2–4 locally (list them; any not exercised gets a ledger note).
- [ ] **Step 3: Commit** `docs(deploy): runbook for the VM`.

### Final

- [ ] Full verification: `make backend-test backend-lint frontend-test`, `npx playwright test`, `bash deploy/tests/api-image.sh`, `bash deploy/tests/stack.sh --browser`, `bash deploy/tests/ops.sh`.
- [ ] Fresh whole-branch review of the plan-5 range (most capable model).
- [ ] With the owner's OK: push `feature/v2`, tag `v2.0.0` on it and push the tag (the runbook clones that tag).

## Final review (2026-11-03, fresh opus reviewer) — outcome

0 critical, 3 important, 7 minor. Fixed, each with a test where one fits:
- Runbook 403 advice could open port 5000 to the LAN (adding a Docker-gateway `172.x` address) → runbook says stop and ask; port published on IPv4 only (`0.0.0.0:`) so IPv6 can't arrive as the gateway.
- Backup aborted on a file deleted mid-walk and left `.tmp-`/`.part` files → per-file add skipping vanished files, `try/finally`, stale leftovers (> 1 day) deleted (`ops.sh` "stale backup temp files removed", red before the fix).
- `update <branch>` could check out a stale local branch → tags first, else `origin/<branch>` (`ops.sh` updates to a tag and checks the tested code stayed).
- `TRUSTED_PROXIES` validator accepted `300.1.1.1`, `/99`, `:`, `::::` → octet and prefix checks (`stack.sh` validator test, red before the fix).
- nginx kept a stale `api` address after `api` was recreated → `depends_on.api.restart: true`.
- Runbook: buildx check, what to do if 5000 is taken, compose "v5 is fine", cron line added once, `backup.log`, restore notes (expired files, `before-restore-*` = undo).
- amd64 (the VM's likely CPU): both images build for linux/amd64 and the API's dependencies import there.
- Ruling: `sif.sh up` chowns only the top of `data/` and `backups/` (not `-R`) — the API creates everything inside as 10001 and a recursive chown over many GB on each start is slow; restore does `chown -R`. Cost if wrong: files copied in by hand as root would be unreadable until `chown -R 10001:10001 data`.
- Still open: the `v2.0.0` tag the runbook clones must be pushed (needs the owner's OK).
