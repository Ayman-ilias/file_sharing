# Deploy

**To install or run it on the VM, follow [RUNBOOK.md](RUNBOOK.md).**

Two containers behind the existing proxy at 10.10.8.100 (Cloudflare → 10.10.8.100 → VM port 5000), compose project `southern-iot-files`:

- `sif-web`: nginx (unprivileged, uid 10001). Serves the built frontend, proxies `/api`, and serves files through X-Accel-Redirect. **The only published port** (`PUBLIC_PORT`, default 5000). It accepts only clients in `TRUSTED_PROXIES` (default `10.10.8.100`) and itself.
- `sif-api`: the FastAPI backend (uid 10001, one uvicorn worker). Not published.

Both containers run as uid 10001, because uploads are stored with mode 0600 and nginx must be able to read them.

| File | What it is |
|---|---|
| `compose.yaml` | The two services. Always run it through `sif.sh`, which passes `--env-file $SIF_HOME/.env` |
| `sif.sh` | `up`, `down`, `status`, `logs`, `update <tag>`, `backup`, `restore <archive>` |
| `web.Dockerfile`, `../backend/Dockerfile` | Pinned images: node 22.23.4, nginx-unprivileged 1.31.7-alpine3.24, python 3.12.16-slim-trixie, uv 0.13.6 |
| `nginx/fs.conf` (+ `security-headers.conf`, `protected-headers.conf`, `40-trusted-proxies.sh`) | The nginx config |
| `.env.example` | Every setting; copied to `$SIF_HOME/.env` (mode 600) |
| `tests/` | `api-image.sh`, `stack.sh` (smoke through nginx), `browser.sh` (Chrome, zero CSP violations), `ops.sh` (sif.sh end to end). Run on the Mac; they use the Colima Linux VM |

Folder on the VM: `/opt/southern-iot/file-sharing/` = `app/` (git checkout) + `.env` + `data/` (`app.db`, `files/`, `tmp/`, `vault/`) + `backups/`.

## Hard requirements from plan 1 (code review 2026-11-02)

- **nginx drops most upstream headers on `X-Accel-Redirect`.** It keeps only Content-Type, Content-Disposition, Cache-Control, Expires, Set-Cookie and Accept-Ranges (`ngx_http_upstream_headers_in[]`, nginx source, checked 2026-11-02). So the `/protected/` location must add the rest itself:
  - `add_header X-Content-Type-Options nosniff always;`
  - `add_header X-Frame-Options DENY always;` and `add_header Referrer-Policy same-origin always;`
  - CSP for sandboxed previews from the copied type: `map $sent_http_content_type $fs_csp { ~^application/pdf ""; ~^(image|video)/ "sandbox"; default ""; }` and `add_header Content-Security-Policy $fs_csp always;`
  - Plan 5 adds an end-to-end test that downloads through nginx and checks these headers in the browser-facing response.
- Launch day: the whole office registers from one public IP, and `LOGIN_RATE_LIMIT` (default 10 per minute) counts every registration. Set it to about 100 for the first day, then back to 10.
- `SERVE_FILES` stays `false` (the default) in production: nginx sends file bytes via X-Accel-Redirect. `true` is only for `make backend-dev` and the e2e tests, where no nginx runs.
- uvicorn runs with `--no-server-header` and exactly one worker. Port 8000 is reachable only from the `web` container (it must never be published), because the API trusts `X-Real-IP`.
- Upload size and timeouts are enforced by nginx (`client_max_body_size` ≈ chunk size + margin).
