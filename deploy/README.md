# Deploy

Two containers behind the existing proxy at 10.10.8.100 (Cloudflare → 10.10.8.100 → VM port 5000):

- `web`: nginx serving the built frontend, proxying `/api`, and serving files through X-Accel-Redirect.
- `api`: the FastAPI backend, as a non-root user.

Data lives in the volume `/data` (`app.db`, `files/`, `tmp/`, `vault/`). Secrets come from `deploy/.env`, which is never committed.

Built by plan 5. The owner deploys; nothing here touches the VM by itself.

## Hard requirements from plan 1 (code review 2026-11-02)

- **nginx drops most upstream headers on `X-Accel-Redirect`.** It keeps only Content-Type, Content-Disposition, Cache-Control, Expires, Set-Cookie and Accept-Ranges (`ngx_http_upstream_headers_in[]`, nginx source, checked 2026-11-02). So the `/protected/` location must add the rest itself:
  - `add_header X-Content-Type-Options nosniff always;`
  - `add_header X-Frame-Options DENY always;` and `add_header Referrer-Policy same-origin always;`
  - CSP for sandboxed previews from the copied type: `map $sent_http_content_type $fs_csp { ~^application/pdf ""; ~^(image|video)/ "sandbox"; default ""; }` and `add_header Content-Security-Policy $fs_csp always;`
  - Plan 5 adds an end-to-end test that downloads through nginx and checks these headers in the browser-facing response.
- `SERVE_FILES` stays `false` (the default) in production: nginx sends file bytes via X-Accel-Redirect. `true` is only for `make backend-dev` and the e2e tests, where no nginx runs.
- uvicorn runs with `--no-server-header` and exactly one worker. Port 8000 is reachable only from the `web` container (it must never be published), because the API trusts `X-Real-IP`.
- Upload size and timeouts are enforced by nginx (`client_max_body_size` ≈ chunk size + margin).
