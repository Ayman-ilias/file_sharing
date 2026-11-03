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
│       ├── sharing/            SendCard, RecipientPicker, UploadQueue, Lists, ItemCard, live events
│       └── vault/              My storage: crypto, VaultStore (key in memory), screens, encrypted photos/files
└── e2e/                        parity.spec.ts (vs mockup.html), flows.spec.ts (real backend), mock-api.ts
```

## Rules the code keeps

- User text is never HTML: React text nodes only; links come from `linkify` (http, https, www) with `rel="noopener noreferrer"`. Lint bans `dangerouslySetInnerHTML`.
- Every write sends `X-Requested-With: fs` (a test checks a whole upload, folder, delete, cancel and logout).
- Uploads: chunk size from the server, 2 files × 4 chunks (folders: small files 6 at a time), backoff 1–16 s then Retry, pause offline or signed out, resume after a reload by re-picking the file.
- One live connection per browser (tabs elect a leader over `BroadcastChannel`).

## My storage encryption (`src/features/vault/crypto.ts`)

- **Keys:**
  - The storage password (NFC-normalised) goes through PBKDF2-SHA-256 with 600 000 rounds and a 16-byte salt, giving a key-encryption key.
  - A random AES-256-GCM data key is wrapped with it.
  - The data key, once unwrapped, is non-extractable and lives only in `VaultStore`'s memory.
- **Changing the password** re-wraps the same data key.
- **Formats** (all versioned):
  - wrapped key and item metadata: `0x01 ‖ iv(12) ‖ AES-GCM(…)`; metadata uses AAD `fsv1:meta`;
  - files: `"FSV1" ‖ uint32 segment size ‖ 8-byte nonce prefix ‖ segments of 4 MiB`, with IV = prefix ‖ segment index and AAD `fsv1:blob:<i>:<end|more>`. Truncated, reordered, extended or foreign blobs fail. The metadata stores the prefix, so blobs can't be swapped between items.
- **Behaviour:**
  - auto-lock after 20 minutes idle (a deadline, also checked after sleep), with a 60 s warning;
  - lock on `pagehide`;
  - lock, unlock, activity, erase and password changes are shared between open tabs (`BroadcastChannel("fs-vault")`, per user);
  - a newly opened tab starts locked.
- **Uploads:** files are checked against the free space first, then encrypted one at a time just before their own upload. They are never saved for after a reload. Photos carry a small encrypted JPEG thumbnail.
- **Limits** (spec §3.7, shown on the lock screen): this protects the database, backups and colleagues. It does not protect against someone who takes over the server and changes the app it sends.

Built by plans 3 and 4 (`docs/superpowers/plans/2026-11-02-plan-3-frontend.md`, `2026-11-02-plan-4-my-storage.md`).
