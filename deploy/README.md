# Deploy

Two containers behind the existing proxy at 10.10.8.100 (Cloudflare → 10.10.8.100 → VM port 5000):

- `web`: nginx serving the built frontend, proxying `/api`, and serving files through X-Accel-Redirect.
- `api`: the FastAPI backend, as a non-root user.

Data lives in the volume `/data` (`app.db`, `files/`, `tmp/`, `vault/`). Secrets come from `deploy/.env`, which is never committed.

Built by plan 5. The owner deploys; nothing here touches the VM by itself.
