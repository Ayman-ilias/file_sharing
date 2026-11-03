# File Sharing v2 — Design

Date: 2026-11-01 · Branch: `feature/v2` · Status: draft for owner approval

## 1. Intent

Southern IoT staff use a small Flask app (`ip.py`) at `https://files.southerneleven.com` to pass files and text to each other. It is reachable from any network. v2 rebuilds it as a separate frontend and backend so that:

- people send things **to specific colleagues** (or to everyone), not just into one shared pile;
- **large files transfer fast and reliably**, with visible progress and speed;
- text is easy to reuse (one-click copy, clickable links);
- the security holes found in the 2026-11-01 audit are gone (path traversal write/delete, stored XSS, no limits, broken delete confirm).

Why now: large files (over ~50 MB) are too slow, and the app is exposed to the internet with critical vulnerabilities.

## 2. Facts that shape the design

| Fact | Source |
|---|---|
| The public domain is proxied by **Cloudflare** (orange cloud, Dhaka edge, HTTP/2 and HTTP/3 at the edge). | `dig` and response headers, 2026-11-01 |
| Cloudflare Free/Pro allow a **maximum request body of 100 MB**; bigger requests get 413. | developers.cloudflare.com/workers/platform/limits and /cache/concepts/default-cache-behavior (updated 2026-10-29) |
| Cloudflare **Proxy Read Timeout is 125 s** (error 524), and the Proxy Write Timeout is 30 s. | developers.cloudflare.com/fundamentals/reference/connection-limits (updated 2026-10-22) |
| Production is on the `rndserver` VM: Ubuntu 24.04, 11 GiB RAM, about 48 GB free disk, Docker 29 + Compose v5. v1 runs in a container on port 5000, from `/root/arif/file_sharing`. | owner's VM output, 2026-10-28 and 2026-11-01 |
| How Cloudflare reaches the VM (Cloudflare Tunnel or port forward) and the office internet bandwidth are **unknown**. | — |

Consequence: today every file is sent as **one** request. Over Cloudflare that is slow, cannot resume, and anything above 100 MB should fail. **Chunked, parallel, resumable uploads are the core of the speed work, not an extra.**

Speed ceiling: no software can beat the slowest link (the user's connection, or the VM's internet uplink and downlink). The goal is to **use the full link**: today one fragile stream is used, v2 uses several parallel chunks with retries.

## 3. Requirements (owner's decisions)

### 3.1 Accounts
- Anyone with an `@southerniot.net` email can register by **entering only the email**. Other domains are rejected. The domain check ignores case, and emails are stored in lowercase.
- **Every account starts with the same shared password** (env var `SHARED_PASSWORD`; never in the repo, docs or logs).
- **Each user can change their own login password in Profile** (current + new + repeat; at least 10 characters; stored as an Argon2id hash). Until they do, a banner on Sharing warns that anyone who knows their email can sign in as them. *(Owner decision 2026-11-01.)*
- A fixed account, **`global@southerniot.net`**, exists from first start, always uses the shared password (it **cannot be changed**), has **no My storage**, and cannot be registered, renamed or deleted.
- The **username** shown in pickers is the part of the email before the `@` (e.g. `ayman`). *(Builder's call: whether a display name can be added later.)*

### 3.2 Sending and visibility
- Every upload (file, folder, text) has recipients, chosen by **picking usernames**. Several can be picked. **"Global"** is an option.
- **Global** = visible to every user, and to the global account.
- A normal user sees: items they sent, items sent to them, and Global items.
- The **global account sees only Global items**. *(My call: it can only send to Global.)*
- **Anyone who can see an item can delete it for everyone.** *(My call: every delete is recorded in an audit log with who and when, so a vanished file can be traced.)*
- Items expire **30 days** after upload, as today.

### 3.3 Text
- A **"Copy all" button** copies the full text in one click, and the UI confirms it.
- **URLs in text are clickable** (`http(s)://…` and `www.…`), open in a new tab with `rel="noopener noreferrer"`, and are rendered safely (never as raw HTML).

### 3.4 Transfer feedback
- For each file being uploaded: **percentage, current speed (MB/s), and time left**, plus a total for the batch. Cancel and retry for each file.
- Downloads use the browser's own progress (and support resuming through Range).

### 3.5 Speed
- "Very fast" for large files from any network. Acceptance: see §8.

### 3.6 Layout decisions from the design review (2026-11-01)
- **Keep v1's layout** (centred column: logo, title and subtitle, auto-delete notice, upload card with Text/Files/Folder tabs, date groups, one card per item). Modernise only. Approved mockup: `.superpowers/brainstorm/3960-1793528610/content/design-v13-profile.html` (local, not committed).
- **Look:** full-page animated brand gradient (navy `#303289` to blue `#267dc2`, slowly drifting blurred colour blobs) plus v1-style floating bubbles, off for `prefers-reduced-motion`. White cards, Inter, line icons, no emoji.
- **Two top tabs: Sharing | My storage.** The page always opens on Sharing.
- **Sharing** splits into **Private** and **Global** sections (switch with counts). Private = sent to me, or sent by me to people. Global = sent to everyone.
- A PDF card opens the PDF **in a new browser tab** (inline, `application/pdf`). Every link inside text opens in a new tab (`rel="noopener noreferrer"`). Photos show a thumbnail, with a larger preview on hover (tap on touch screens).
- **Profile** (from the account button): change login password, change storage password.

### 3.7 My storage (personal vault)
- For each user except the global account: **200 MB** for photos, files, notes, links and passwords. Never expires. Only the owner can see it.
- **End-to-end encrypted in the browser.** A random data key encrypts every item (AES-256-GCM, WebCrypto). The data key is wrapped with a key derived from a separate **storage password** (Argon2id via WASM, or PBKDF2-SHA-256 ≥ 600k iterations). The server stores only ciphertext, the wrapped key and the KDF salt. Changing the storage password only re-wraps the data key.
- The storage password is set the first time My storage is opened. It **cannot be reset**: forgetting it loses the storage, and the UI says so plainly.
- It opens **locked**. It **locks itself after 20 minutes without activity** (owner decision), on Lock, and on logout or tab close. The key lives only in memory.
- **Quota:** 200 MB of ciphertext per user, checked before an upload starts (the client knows the size) and enforced by the server.
- **Kinds:** Note, Link (opens in a new tab), Password (hidden; reveal and copy), Photo (grid; decrypted in the browser for preview), File.
- **Honest limit, written into the UI help:** this protects stored data, the database, backups, and access by colleagues. It does not protect against someone who controls the server and changes the app code it serves.
- **Disk planning:** 200 MB × number of users must fit beside shared files (the VM has about 48 GB free).

### 3.8 Corner cases and states (review 2026-11-02)
An independent corner-case review found 30 gaps. Every one is resolved below. The screens are drawn in `docs/design/states.html`, which uses the same CSS as the mockup and is part of the approved design.

**My storage**
- Every vault item (password, note, link, photo, file) has a **⋯ menu**: Edit, Copy (password/username, note text, link address) and Delete. Files also have Rename. Photos show Download and Delete on hover or tap. The link card opens from its title only.
- **Delete is confirmed inline**, everywhere: Delete turns into a red "Delete?" for 4 s.
- **Add/Edit forms:**
  - Password: title, username, website or IP, password (show and generate), optional note.
  - Note: optional title, which defaults to the first line; empty → error.
  - Link: title, address (must look like a web address), optional note.
  - Photo and File: the file picker, then the shared upload rows.
- **First-time setup** replaces the lock screen: storage password + repeat (≥ 10 chars) + a required "can't be reset" tick box.
- **Forgot the storage password:** "Erase My storage and start again", confirmed by typing `ERASE`. It deletes every vault item and the key, and frees the 200 MB.
- **Auto-lock:** after 20 minutes without input, with a warning 60 s before. Typing and running vault uploads count as activity. An open form keeps its contents in memory until the lock, and the user is warned.
- **Quota full:** the bar turns red, "Full", and Add is disabled with the reason. A cancelled or failed vault upload frees its reserved space immediately, and stale reservations are freed after 24 h.
- **Two tabs open:** vault edits carry a version number, and a stale save gets 409 → "Changed in another tab, reload". Lock and unlock are shared between tabs (BroadcastChannel).
- **The global account has no My storage tab**, no password forms and no nudge. Its Send to is fixed to Global.

**Sharing**
- **Send to:** Global is always the first suggestion. "No match" explains that only registered colleagues appear. **Choosing Global replaces any people** (it's an everyone item, stored with no recipients). Sending to yourself is not offered; My storage is for that.
- **Re-sending the same file** to different people starts a new upload. Resume only applies when both the file fingerprint *and* the recipients match (`client_key`).
- **Upload problems:**
  - Failed → Retry keeps the received chunks.
  - Offline → Paused, and it resumes by itself.
  - Too large (> 10 GB) and Server full (507) are refused **before** any bytes are sent.
  - Signed out mid-upload → the queue pauses, and an in-page sign-in continues it.
- **Folders:** at most 5 000 files per folder upload (`MAX_BATCH_FILES`). Empty folders are dropped, with a note. Zero-byte files are allowed. File names are normalised to Unicode NFC (Mac uploads). Zips set the UTF-8 name flag. Each file inside a folder can be downloaded on its own.
- **Lists:** empty Private/Global states, skeleton loading, an error card with Try again, and an offline banner. Lists load 50 at a time (cursor), with more loaded on scroll.
- **Cards:**
  - Many recipients show "rahim, nusrat +12", with the rest in a tooltip.
  - "Expires in N days" appears in amber when it's 3 days or less.
  - Text longer than 4 lines folds, with "Show all N lines". Untitled text is named after its first line (≤ 80 chars).
- **Live:** an item deleted by someone else disappears with "rahim deleted …". Expiry deletions are pushed too. After a reconnect the list is refetched, and a 404 on download or delete removes the card quietly.
- **Delete rule kept as decided** (anyone who sees an item may delete it), now with the deleter's name shown. Owner confirmed on 2026-11-02: **in Global, anyone can delete any item**, including through the shared global login. No restriction. The audit log records the deleter.

**Accounts**
- Register success message ("Account created … sign in with the shared starting password"). Errors: wrong domain, wrong email or password, too many tries (429). A pasted full address is reduced to its name part.
- Profile shows success and errors (wrong current password, mismatch, too short). The storage section links to setup until it exists. A login-password change signs out other sessions.
- **People who leave:** the admin disables the account with a CLI command (plan 5). They can no longer sign in and drop out of the Send-to list. Their shared items stay until they expire.

**Phones:** hover-only things become taps (a photo opens a full-screen viewer with Download, Delete and Close; "Open in new tab ↗" always shows). Where folders can't be picked (iPhone), the Folder tab says to zip the folder or pick files instead.

## 4. Goals, non-goals, anti-goals

**Goals:** everything in §3; all audit findings fixed; same public URL; existing files kept.

**Non-goals:**
- email verification or password reset by email (the owner declined; per-user login passwords are now in scope via Profile)
- an email server
- anonymous or public share links (everything needs a login)
- virus scanning
- an admin panel
- a mobile app

**Anti-goals (a failure even if it works):**
- small files or texts feel slower than v1
- any existing upload is lost at cutover
- the public URL or its Cloudflare setup has to change
- a private item shows up for someone who isn't a sender or recipient (shared-password impersonation aside)
- a user-supplied name ever reaches a filesystem path

## 5. Architecture (my calls unless noted)

```
Browser (React SPA) ──HTTPS──► Cloudflare ──► VM :5000
                                               nginx ─┬─ static SPA files
                                                      ├─ /api/* ──► FastAPI (uvicorn)
                                                      └─ internal /protected/* (X-Accel-Redirect) ──► /data/files
FastAPI ──► SQLite (WAL) /data/app.db      Files ──► /data/files/<ab>/<uuid>
```

| Layer | Choice | Reason |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite, Tailwind CSS, shadcn/ui (Radix), TanStack Query, React Router | Modern and fast; builds to static files, so production needs no Node |
| Backend | Python 3.12, FastAPI, Uvicorn (**1 worker**, async), SQLAlchemy 2 + Alembic, SQLite in WAL mode | Same language as v1. One worker keeps live-update fan-out in-process; uploads are I/O-bound |
| Proxy | nginx (pinned alpine image) | `sendfile` downloads, Range/resume, X-Accel-Redirect for permission-checked downloads, gzip for assets |
| Deploy | `docker compose` with 2 services (`web` = nginx + built SPA via a multi-stage build on node:22; `api`). Pinned image versions, non-root users, named volume `/data`, host port **5000** | Replaces "pip install on every start". Same port, so the Cloudflare side is unchanged |

Repo layout in the same GitHub repo: `backend/`, `frontend/`, `deploy/` (compose, nginx.conf, env example), `docs/`. Tag `v1` before removing `ip.py`.

## 6. Key designs

### 6.1 Storage and data model
- Files are stored as `/data/files/<first 2 hex>/<uuid>`. **User-supplied names live only in the database.** This removes path traversal by construction.
- Tables:
  - `users` (id, email, username, is_global, created_at)
  - `sessions` (token hash, user_id, expires_at)
  - `items` (id, kind=file|folder|text, name, size, sender_id, is_global, created_at, expires_at)
  - `item_recipients` (item_id, user_id)
  - `folder_entries` (item_id, relative_path, size, storage_id)
  - `uploads` (upload state, see 6.3)
  - `audit_log` (actor, action, item, at)
- Text is stored in the DB up to 1 MB. Larger pasted text is rejected with a hint to upload a file. *(Builder may adjust the limit.)*

### 6.2 Auth
- `POST /api/register {email}`: checks the domain and creates the user; idempotent for existing users. **Login is separate:** `POST /api/login {email, password}`. Only registered emails can log in. *(My call: registering does not log you in automatically.)*
- The session is a random token in an `HttpOnly; Secure; SameSite=Lax` cookie, stored hashed server-side. It lasts 30 days, sliding. Logout deletes it.
- CSRF: every state-changing request must carry the header `X-Requested-With: fs` and come from the same origin (the cookie is SameSite=Lax).
- Rate-limit login and register per IP.
- **Confirmed ingress (2026-11-01):** Cloudflare → reverse proxy at **10.10.8.100** (probably Nginx Proxy Manager; inferred from headers, not verified) → VM :5000. In the 24 h v1 log, all 283 requests came from 10.10.8.100.
- nginx takes the client IP from `CF-Connecting-IP`, falling back to `X-Forwarded-For`, **only when the request comes from an address in `TRUSTED_PROXIES`** (default `10.10.8.100`).
- *(My call:)* nginx **accepts connections only from `TRUSTED_PROXIES` and localhost**, so nobody on the LAN can skip the proxy and its HTTPS. Both lists are env settings, so a direct office link can be added later.

### 6.3 Chunked, parallel, resumable upload (the speed core)
1. `POST /api/uploads` sends name, size, mime, recipients, and optional folder relative path / folder batch id. The server checks free disk (size + 2 GB margin) and the max size (env `MAX_FILE_SIZE`, default 10 GB), pre-allocates `/data/tmp/<upload_id>`, and returns `{upload_id, chunk_size}`.
2. `PUT /api/uploads/{id}/chunks/{n}` sends the raw body, at most `chunk_size`. **Default chunk = 16 MB** (well under Cloudflare's 100 MB cap and its timeouts). The server writes it at offset `n × chunk_size` with `pwrite`, so there is **no reassembly copy**. Re-sending a chunk is safe.
3. `GET /api/uploads/{id}` lists the chunks already received, for resume.
4. `POST /api/uploads/{id}/complete` verifies the size, moves the file into `/data/files`, creates the item, and notifies recipients.

Client:
- **4 chunks in flight per file, 2 files at a time** (both configurable).
- Retries with exponential backoff.
- Survives network drops. After a page reload, re-selecting the same file resumes it; the file is identified by name + size + lastModified in localStorage.
- Speed is a moving average over the last 3 s.

Stale uploads are removed after 24 h. nginx uses `client_max_body_size` ≈ chunk size + margin and `proxy_request_buffering off` on the chunk route.

*(Builder's call: a custom protocol as above vs tus; it must keep pwrite-at-offset and resume. Chunk size and concurrency get tuned with the benchmark in §8.)*

### 6.4 Downloads
- `GET /api/items/{id}/download`: FastAPI checks visibility, then responds with **X-Accel-Redirect**, and nginx serves the file with `sendfile` and **Range** support.
- Response headers: `Content-Disposition: attachment; filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-store`, so Cloudflare never caches private files.
- Folders: a **streaming ZIP** (stored, not compressed; Zip64) via zipstream-ng. The download starts immediately and uses constant memory. Single files inside a folder can also be downloaded on their own.
- Previews (inline) **only** for image/png, jpeg, gif, webp and video/mp4, with `Content-Security-Policy: sandbox`.
- **PDFs** open inline in the browser's built-in PDF viewer **without** the sandbox header, because Chromium won't show a sandboxed PDF. They keep `nosniff` and an exact `application/pdf` type. *(My call: browser PDF viewers run in their own isolated context, so the risk is low. Using pdf.js instead is out of scope.)*
- HTML, SVG and everything else are always downloaded as attachments.

### 6.5 Live updates
- `GET /api/events` is **Server-Sent Events**. It pushes item created/deleted events only to the users who can see the item.
- Replaces v1's 2-second polling. A toast says "ayman sent you report.pdf". *(Heartbeat every 25 s to stay under Cloudflare's idle limits.)*

### 6.6 Background jobs
- Hourly expiry and stale-upload cleanup. Each item is handled in its own try/except, so one failure never stops the job.

### 6.7 Security baseline
- Every 2026-11-01 audit finding gets a regression test.
- Headers: CSP (`default-src 'self'`), `frame-ancestors 'none'`, nosniff, Referrer-Policy.
- No debug mode. Server version headers hidden.
- Secrets come only from env.

## 7. Frontend (screens)

> **Superseded on 2026-11-01** by §3.6 and the final mockup in `docs/design/mockup.html`. Where this section disagrees (for example the confirm dialog or the 2-column layout), the mockup wins. Delete asks inline, as decided in the roadmap.

The owner sees mockups before the build. Content of the screens:

- **Login / Register.** Email field (with an `@southerniot.net` hint) and a password field on Login. Clear errors.
- **Main page**
  - Header with the logo, the user's name and logout.
  - **Send panel** with tabs Text / Files / Folder. Drag-and-drop anywhere on the page. A **recipient picker**: searchable list of usernames, multi-select, "Global" pinned at the top.
  - **Feed** grouped by Today / Yesterday / date.
  - Filter chips: All · Sent to me · Sent by me · Global. A search box.
  - Each item card shows: icon or thumbnail, name, `sender → recipients`, size, time, "expires in N days", and actions (Download, Copy (text), Preview, Delete).
  - Delete opens a real confirm dialog.
  - Text cards: collapsed preview with clickable links, "Copy all", expand.
- **Upload queue** (bottom-right panel): per file %, MB/s, time left, cancel/retry, plus the batch total.
- Dark mode and the Southern IoT logo. Works at phone width.

## 8. Acceptance and verification

- **Speed benchmark** (the definition of "very fast"): files of 50 MB, 500 MB and 2 GB, through `files.southerneleven.com`, from the office and from an outside network.
  - v2 upload throughput is ≥ 80 % of a raw link test (e.g. speedtest to the same region).
  - v2 is at least 2× faster than v1 at 50 MB.
  - 500 MB and 2 GB succeed (v1 is expected to fail above 100 MB).
  - Results are recorded in `docs/benchmarks.md`.
- A transfer interrupted by toggling the network resumes without starting over.
- Tests:
  - pytest (API, auth, visibility rules, the upload protocol, and one regression test per audit finding)
  - Vitest (linkify, the speed calculation)
  - Playwright end-to-end (register → login → send to a user / to Global → recipient sees it live → copy text → delete)
- A security re-test: rerun the 2026-11-01 attack set against v2 locally.

## 9. Migration and cutover

> **Superseded 2026-11-03:** the owner stopped and deleted v1 (code and uploads, no backup). v2 starts empty: no import, no spare-port test, no rollback to v1. v2 lives in `/opt/southern-iot/file-sharing`; see `deploy/RUNBOOK.md`. The text below is kept as history.

- Import script: every v1 item in `/root/arif/file_sharing/uploads` becomes a **Global item sent by the global account** (in v1 everything was visible to everyone). Names, folder structure and dates are preserved. Expiry = original date + 30 days. *(My call.)*
  - **`.txt` files** at the top level that are ≤ 1 MB and valid UTF-8 become **text items**. That matches v1, which showed every top-level `.txt` as text with a preview. Other `.txt` files become file items. *(My call.)*
  - The importer has `--mode copy` (default; keeps rollback possible) and `--mode move` (for when the old folder is too big to copy). It refuses to run if there is less free space than the copy needs plus 2 GB. The owner picks the mode at cutover, from the output of `du -sh`.
  - The importer only walks the uploads folder, so direct code edits on the VM copy don't affect it. Any change in how the VM stores files will show up in the pre-cutover diff, and the importer is adjusted then.
- Before cutover:
  1. The owner diffs the VM copy against GitHub (it may contain direct edits).
  2. Back up the uploads folder.
  3. Run v2 on a spare port (e.g. 5001) and test it.
  4. Stop v1 and start v2 on port 5000.
- Rollback = start the v1 container again; its files are untouched because the import copies them.
- **The owner deploys.** Claude never touches the VM.

## 10. Left to the builder
Library versions, exact component structure, the chunk/concurrency tuning values, the exact visual styling (after mockup approval), test layout, and whether to use tus or the custom upload protocol (within §6.3).

## 11. Open items (needed before deploy and the benchmark, not before building)

**Answered 2026-11-01** (owner's VM output):
- No `cloudflared` container on the VM, and the `cloudflared` service is inactive. So the VM itself does not run a tunnel.
- v1 uploads take **125 MB**, with 48 GB free, so the importer runs in `--mode copy`.
- *Inference, not verified:* the public response carries `x-served-by: files.southerneleven.com` and HSTS `max-age=63072000;includeSubDomains; preload`. Those match Nginx Proxy Manager's defaults, so another reverse proxy probably sits between Cloudflare and the VM.
- Who connects to VM :5000: **only 10.10.8.100** (283 of 283 requests in the last 24 h of the v1 log). The design uses this in §6.2.
- The proxy at 10.10.8.100 is an extra hop for every byte. If it buffers request bodies (nginx does by default), each 16 MB chunk lands on its disk before reaching the VM. Chunked uploads keep that cheap, but the benchmark should also be run from the LAN against the proxy, to tell proxy cost apart from internet cost. *(Builder: record the proxy's upload size and timeout settings in the deploy notes, read-only.)*

**Still open:**
- How Cloudflare reaches the VM (Tunnel or port forward) → sets `INGRESS_MODE`. If it's a port forward, whether port 5000 is also open to the internet directly.
- Size of `/root/arif/file_sharing/uploads` → sets the import mode.
- Office internet speed → sets the benchmark baseline.

Read-only VM commands for the owner (nothing is changed):
```
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -i -E 'cloudflared|tunnel' ; systemctl is-active cloudflared 2>/dev/null
du -sh /root/arif/file_sharing/uploads ; df -h /
```
