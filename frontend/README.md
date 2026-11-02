# Frontend

React 19 + TypeScript + Vite. The CSS is copied verbatim from the approved mockup (same class names), so the app looks like [docs/design/mockup.html](../docs/design/mockup.html) and [docs/design/states.html](../docs/design/states.html).

## Run it

| Command | What it does |
|---|---|
| `make backend-dev` (repo root) | The API on :8000 (`SERVE_FILES=true`, because no nginx runs locally) |
| `make frontend-dev` | Vite on http://localhost:5180, `/api` proxied to :8000 (`FS_API` changes the target) |
| `make frontend-test` | Vitest (unit and component tests) + type check |
| `make frontend-e2e` | Playwright with the installed Chrome: visual parity with the mockup and end-to-end flows. Starts its own backend on :8765 with a throwaway data folder |
| `make frontend-build` | Static files in `frontend/dist/` |
| `make frontend-design` | Re-copy the CSS and icon sprite from `docs/design/` (only if the design changes) |

## Layout

```
frontend/
├── index.html                  page shell + the icon sprite (generated from the mockup)
├── public/                     logos; fonts/ = Inter, self-hosted (SIL OFL, see OFL.txt)
├── scripts/extract-design.mjs  copies the mockup's CSS and icons
├── src/
│   ├── App.tsx                 session → login page, or the shell (tabs, nudge, send card, lists, re-sign-in)
│   ├── styles/                 app.css + states.css (verbatim from the design), extra.css (touch/focus only)
│   ├── api/                    client (cookie session, X-Requested-With on writes, XHR chunk PUTs), types, useSession
│   ├── lib/                    linkify, format, fingerprint (upload keys), speed, clipboard, dropped folders
│   └── features/
│       ├── auth/               LoginPage (sign in, register), ReSignIn (session ended mid-work)
│       ├── layout/             Background, Header, TopTabs, Nudge, ProfileDrawer
│       ├── uploads/            Uploader engine (chunked, parallel, resumable, survives reload) + useUploads
│       └── sharing/            SendCard, RecipientPicker, UploadQueue, Lists, ItemCard, live events
└── e2e/                        parity.spec.ts (vs mockup.html), flows.spec.ts (real backend), mock-api.ts
```

## Rules the code keeps

- User text is never HTML: React text nodes only; links come from `linkify` (http, https, www) with `rel="noopener noreferrer"`. Lint bans `dangerouslySetInnerHTML`.
- Every write sends `X-Requested-With: fs` (a test checks a whole upload, folder, delete, cancel and logout).
- Uploads: chunk size from the server, 2 files × 4 chunks (folders: small files 6 at a time), backoff 1–16 s then Retry, pause offline or signed out, resume after a reload by re-picking the file.
- One live connection per browser (tabs elect a leader over `BroadcastChannel`).

Built by plan 3 (`docs/superpowers/plans/2026-11-02-plan-3-frontend.md`); My storage is plan 4.
