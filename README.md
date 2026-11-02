# Southern IoT Files (v2)

Internal file, text and personal-storage app for Southern IoT staff, served at `files.southerneleven.com`.

v2 replaces the single-file Flask app (`ip.py`, kept under the git tag `v1`) with a separate frontend and backend.

| Folder | What lives there |
|---|---|
| [backend/](backend/) | FastAPI service: accounts, sharing, chunked uploads, downloads, live events, encrypted My storage |
| [frontend/](frontend/) | React + TypeScript single-page app, built to static files |
| [deploy/](deploy/) | Docker Compose, nginx and Dockerfiles for the VM |
| [docs/superpowers/specs/](docs/superpowers/specs/) | The design document: what we are building and why |
| [docs/superpowers/plans/](docs/superpowers/plans/) | The build plans, one per milestone |
| [docs/design/](docs/design/) | The approved UI mockup and reference screenshots; the frontend must match them |

Start with the spec, then the roadmap in `docs/superpowers/plans/`.

## Run it locally

```
make backend-dev      # API on :8000 (needs SHARED_PASSWORD in backend/.env)
make frontend-dev     # http://localhost:5180
make backend-test frontend-test frontend-e2e
```

Status: plans 1–3 done (backend, transfers, Sharing frontend). Next: plan 4 (My storage), plan 5 (deploy).

