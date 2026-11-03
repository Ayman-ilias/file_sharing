# Plan 3: Frontend (Sharing, Login, Profile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The approved design, built as the real app and wired to the plan 1–2 backend:
- the login/register page;
- the animated shell with Sharing | My storage tabs;
- sending text, files and folders, with fast chunked uploads and visible progress;
- the Private and Global lists, with live updates;
- the profile drawer;
- every state in `states.html`.

My storage's insides are plan 4.

**Architecture:**
- **Stack:** a React + TypeScript single-page app built with Vite.
- **Styling:** plain CSS **copied verbatim** from `docs/design/mockup.html` (plus the extra component CSS from `states.html`). Components output the **same markup and class names**, so the app can't drift from the design.
- **Data:** server state comes through a small `api` client (cookie session, `X-Requested-With: fs` on writes).
- **Uploads:** a standalone `Uploader` engine (no React inside) does chunked, parallel, resumable uploads, and the UI subscribes to its progress.
- **Live updates:** one `EventSource` keeps the lists live.
- **Dev setup:** Vite proxies `/api` to uvicorn on :8000. Production serving is nginx (plan 5).

**Tech Stack:**
- React, React DOM, TypeScript and Vite.
- Vitest, Testing Library and jsdom for unit and component tests.
- Playwright (`@playwright/test`) driving the **installed Google Chrome** (`channel: "chrome"`), so no browser download, for flows and screenshot checks.
- `pixelmatch` + `pngjs` for comparing screenshots against the mockup.
- Versions: latest stable at install time, frozen in `package-lock.json`.

**Spec:** [docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md](../specs/2026-11-01-file-sharing-v2-design.md) §3.1–3.6, §3.8 (corner cases and states), §7 superseded by the mockup.
**Design (binding):** [docs/design/mockup.html](../../design/mockup.html) and [docs/design/states.html](../../design/states.html).
**Contracts:** [roadmap](2026-11-01-file-sharing-v2-roadmap.md) (API rows marked ✔ exist).
**Backend notes for clients:** `backend/README.md` § Upload protocol.

## Global Constraints

- **The look is the mockup's look.** Copy CSS, class names, texts, icons (inline SVG `<symbol>` set) and spacing from `mockup.html`/`states.html`. Don't restyle, rename or "improve" them. If something must differ, record it in the ledger with the reason.
- **Fonts:** Inter from Google Fonts (as in the mockup). **Colours:** navy `#303289`, blue `#267dc2`.
- **The page always opens on Sharing → Private.**
- **The global account** (`me.is_global`) never sees the My storage tab, the password nudge or the password forms. Its Send to is fixed to "Global (everyone)".
- **Never render user text as HTML.** `dangerouslySetInnerHTML` is banned (a lint rule plus a test). Links in text come from `linkify` as `<a href rel="noopener noreferrer" target="_blank">` and only for `http:`, `https:` and `www.` addresses.
- **Sending:** choosing **Global replaces the people**. You can't send to yourself. The recipient list comes from `GET /api/users`.
- **Uploads:**
  - chunk size = the server's `chunk_size`;
  - **4 chunks in flight per file, 2 files at a time**;
  - retries with exponential backoff (1 s, 2 s, 4 s, 8 s, 16 s, then "Failed — Retry");
  - pause on `offline` or 401 and continue on `online` / after signing in;
  - `client_key` = SHA-256 of `name|size|lastModified|sorted recipients|is_global`, as hex, cut to 64 characters;
  - "complete" is retried until it answers 200/201.
- **Lists:** 50 per page, the next page on scroll (IntersectionObserver).
  - **Live:** `item.created` inserts into the matching section; `item.deleted` removes and shows a "<who> deleted '<name>'" toast; after an EventSource error or reconnect, refetch page 1.
  - The **counts** on the Private/Global switch are the number of loaded items, shown as "50+" when more pages exist. **Ruling:** the API has no count endpoint.
- **Delete** confirms inline: the bin becomes a red "Delete?" for 4 s, and a second click deletes.
- **Text items** show their first 4 lines; "Show all N lines" loads `GET /api/items/{id}`. "Copy" copies the **full** text: it fetches it first when `text_truncated`.
- **PDFs** open in a new tab (`/download?inline=1`). **Photos** show a thumbnail (`/download?inline=1`) with a hover peek (`@media (hover: hover)`); a tap opens the full-screen viewer (`states.html` §10).
- **Accessibility:** buttons are `<button>`, inputs have labels or `aria-label`, focus is visible, and the background animation is off under `prefers-reduced-motion: reduce`.
- Commit after each task with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit on `feature/v2`, and push the branch at the end of the plan (the owner OK'd backup pushes, 2026-11-02).

## Review Focus

1. **A dropped connection or closed laptop lid mid-upload** must resume where it stopped, without re-sending finished chunks and without a duplicate item. Tests in task 6.
2. **A recipient whose text contains `javascript:` links, HTML tags or a 1 MiB body** sees plain, safe text; only http/https/www become links; the page stays fast. Tests in tasks 5 and 8.
3. **The global account and a regular user** see different shells (no My storage, no nudge, Send to fixed). Test in task 4.
4. **Two tabs open**, each sending and deleting, stay consistent through live events, with no duplicates and no ghosts. Test in task 8.
5. **Screens match the approved mockup** at desktop (1300 px) and phone (390 px) widths within 1 % of pixels. Test in task 9.

---

### Task 1: Project setup and the design CSS

**Files:**
- Create: `frontend/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
- Create: `src/styles/app.css` (the mockup's `<style>` block, verbatim) and `src/styles/states.css` (the component CSS added in `states.html`, without its `.gal/.fr/.cap/.gsec/.ggrid` gallery rules)
- Create: `src/icons.tsx` (the mockup's and states.html's `<symbol>` sprite as one component, plus `<Icon name>`)
- Create: `src/test/setup.ts`, `frontend/vitest.config.ts`
- Modify: root `Makefile` (`frontend-dev`, `frontend-test`, `frontend-build`)
- Copy: `public/mark.png` and `public/logo-full.png` already exist

**Interfaces:**
- Produces: `<Icon name="i-…" size={n} />`; the CSS files imported once in `main.tsx`; the Vite dev proxy `/api` → `http://127.0.0.1:8000`.

- [ ] **Step 1:** `npm create vite@latest frontend -- --template react-ts` (into the existing folder, keeping the README and `public/`). Then `npm i -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom`.
- [ ] **Step 2: Write the failing tests** in `src/styles/design.test.ts`:
  - `app.css` contains `.seg-btn`, `.top-tabs`, `.vault-lock`, `.peek`, `--navy: #303289`;
  - `states.css` contains `.menu`, `.dd`, `.skel`, `.lightbox`, and doesn't contain `.gal`;
  - `icons.tsx` defines every `id="i-…"` used in `mockup.html` and `states.html` (parsed from those files).
- [ ] **Step 3: Run** `npm test`. Expected: FAIL.
- [ ] **Step 4: Implement** by extracting with a small script (`scripts/extract-design.mjs`, committed) so the copy is exact and repeatable.
- [ ] **Step 5: Run** `npm test && npx tsc --noEmit && npm run build`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(frontend): project setup and design CSS`.

### Task 2: API client, types and session

**Files:** `src/api/client.ts`, `src/api/types.ts`, `src/api/session.ts` (+ tests)

**Interfaces:**
- Produces:
  - `api.get<T>(path)`, `api.send<T>(method, path, body?)` (JSON), `api.put(path, blob)`. Every write sends `X-Requested-With: fs`.
  - Errors throw `ApiError {status, detail, extra}`. A 401 fires `window` event `"fs:signed-out"`.
  - Types: `Me`, `UserRef`, `User`, `Item`, `ItemPage`, `EntryOut`, `UploadStarted`, `BatchFilesOut`.
  - `useSession()` → `{me, loading, refresh, logout}` (loads `/api/auth/me` once; 401 → `me = null`).
- [ ] **Step 1: Write the failing tests** (mocked `fetch`):
  - writes carry the CSRF header and `credentials: "same-origin"`;
  - a 409 body `{detail:"missing_chunks", missing:[1]}` becomes `ApiError` with `extra.missing`;
  - a 401 fires `fs:signed-out`;
  - `useSession` gives `me = null` on 401.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `feat(frontend): API client and session`.

### Task 3: Login and register

**Files:** `src/features/auth/LoginPage.tsx` (+ test)

**Interfaces:**
- Produces: `<LoginPage onSignedIn={(me) => …} />`, built from the mockup's login card (`.lpage/.lcard/.email`) on the full-page gradient.
- Behaviour:
  - The email field takes the name part; a pasted full address keeps only the name (and a non-company domain shows the domain error).
  - Register → "Account created for …" message on the Sign in view.
  - Error texts exactly as in `states.html` §8 (`domain_not_allowed`, `bad_credentials`, `too_many_attempts`).
- [ ] **Step 1: Write the failing tests:**
  - pasting `tanvir@southerniot.net` leaves `tanvir`;
  - pasting `x@gmail.com` shows "Only @southerniot.net emails can register.";
  - register then sign in calls the right endpoints in order;
  - each error code maps to its sentence.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS). **Step 5: Commit** `feat(frontend): login and register`.

### Task 4: Shell, tabs, nudge and profile

**Files:** `src/features/layout/{Background,Header,TopTabs,Nudge,ProfileDrawer}.tsx`, `src/App.tsx` (+ tests)

**Interfaces:**
- Consumes: `useSession`.
- Produces:
  - `<Background/>` (the gradient `.bg` with blobs plus 15 generated bubbles; none under reduced motion);
  - `<Header me onProfile onLogout/>`;
  - `<TopTabs value onChange showStorage/>`;
  - `<Nudge show onSetOwn/>`;
  - `<ProfileDrawer me open onClose/>`: change login password, with errors and success exactly as `states.html` §9. The storage section shows the "Set up My storage" link (wired in plan 4). The global note is shown only to the global account.
- [ ] **Step 1: Write the failing tests:**
  - a regular user sees both tabs and the nudge while `uses_shared_password`;
  - the global account sees only Sharing, no nudge, and no password forms;
  - a successful password change hides the nudge (`refresh()`);
  - `too_short`, `bad_credentials`, mismatch and `same_as_shared` show their messages;
  - the drawer closes on overlay click and on Escape.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): shell, tabs, nudge and profile`.

### Task 5: Small libraries

**Files:** `src/lib/{linkify,format,fingerprint,speed}.ts` (+ tests)

**Interfaces:**
- Produces:
  - `linkify(text) -> Array<string | {href, text}>`: http/https/www only; trailing punctuation `.,)!?` excluded; `www.x` → `https://www.x`.
  - `formatBytes(n)` ("18.4 MB", "1.80 GB").
  - `relativeTime(date, now)` ("2 min ago", "4:10 PM", "Oct 12").
  - `dayGroup(date, now)` ("Today", "Yesterday", "Oct 30").
  - `expiresSoon(expires, now)` (≤ 3 days → "expires in N days").
  - `clientKey({name,size,lastModified}, recipientIds, isGlobal) -> Promise<string>` (WebCrypto SHA-256).
  - `class SpeedMeter {add(bytes, t); bytesPerSec(t); eta(remaining, t)}` (3 s moving window).
- [ ] **Step 1: Write the failing tests:**
  - `javascript:alert(1)`, `data:…` and `<a href=…>` text are never links;
  - `http://x.y/path).` links exactly `http://x.y/path`;
  - `clientKey` differs when only the recipients differ (the 2026-11-02 resume bug, client side);
  - the speed and ETA maths over a fake clock.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): text, format, key and speed helpers`.

### Task 6: Upload engine

**Files:** `src/features/uploads/{Uploader.ts,Uploader.test.ts,useUploads.ts}`

**Interfaces:**
- Consumes: `api`, `clientKey`, `SpeedMeter`.
- Produces:
  - `new Uploader({api, maxFiles: 2, maxChunks: 4})` with `addFiles(files, target)`, `addFolder(files /* with webkitRelativePath */, target)`, `retry(id)`, `cancel(id)`, `onChange(cb)`.
  - `target = {recipientIds, isGlobal}`.
  - Each job is `{id, name, size, sent, state: "queued"|"sending"|"paused"|"failed"|"done", reason?, speed, eta, item?}`.
  - `useUploads()` is the React hook over the singleton.
- Behaviour:
  - Files: start (resume when `received` is non-empty), PUT the missing chunks as `Blob.slice` with ≤ 4 in flight, then complete.
  - Folders: `POST /api/batches`, register in groups of 500 (`relative_path` = `webkitRelativePath` minus the top folder), chunks, then batch complete.
  - 413/507/429 → `failed` with reason `too_large`/`disk_full`/`upload_quota` (text as in `states.html` §5).
  - `offline` → `paused`; `online` → continue.
  - `fs:signed-out` → `paused` ("Please sign in again"); after sign-in, continue.
- [ ] **Step 1: Write the failing tests** (fake `api`, fake timers):

```ts
test("never more than 4 chunk PUTs in flight per file and 2 files at once")
test("resume skips chunks the server already has")          // start returns received [0,1] → only 2..n PUT
test("a failed chunk retries with backoff, then fails with Retry")  // 1,2,4,8,16 s then state failed
test("complete is retried after a network error and the job ends done once")  // 2nd complete 200 → one item
test("offline pauses and online continues without re-sending done chunks")
test("signed-out pauses; sign-in continues")
test("413/507/429 become failed with the right reason and nothing is sent")
test("folder: registers in groups of 500 and completes the batch; failed paths shown")
test("cancel calls DELETE and drops the job")
```

- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): chunked parallel resumable upload engine`.

### Task 7: The send card

**Files:** `src/features/sharing/{SendCard,RecipientPicker,TextForm,DropZone,UploadQueue}.tsx` (+ tests)

**Interfaces:**
- Consumes: `api` (`/api/users`, `/api/items/text`), `useUploads`, `me`.
- Produces: `<SendCard me/>`, matching `mockup.html`'s `.card.upload` and `states.html` §4 (picker) and §5 (queue rows).
- Behaviour:
  - Global is first in the suggestions; "No colleague called …" when nothing matches; choosing Global replaces the chips; the global account has a fixed Global chip.
  - Text: the title is optional; a character counter; over 1 MiB shows "Too long — send it as a file".
  - **Files:** one picker or drop; each file becomes a queue row.
  - **Folder:** a `webkitdirectory` input. Where it isn't supported (iOS), the message from `states.html` §10.
  - Send is disabled until there are recipients and content.
  - After a text send, the form clears and the new item appears through the live event.
- [ ] **Step 1: Write the failing tests:**
  - picking Global removes the person chips;
  - Send stays disabled with no recipients;
  - the global account can't remove its Global chip;
  - a text send posts `{title?, body, recipient_ids, is_global}`;
  - a 1 MiB + 1 text shows the error and doesn't post;
  - queue rows show %, "x of y", MB/s and time left, and Retry on failure.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): send card with recipient picker and upload queue`.

### Task 8: Lists, cards and live updates

**Files:** `src/features/sharing/{Lists,SectionSwitch,ItemCard,TextBody,PhotoPeek,Lightbox,FolderEntries,DeleteButton,Toasts}.tsx`, `src/features/sharing/useItems.ts`, `src/features/sharing/useEvents.ts` (+ tests)

**Interfaces:**
- Consumes: `api`, `linkify`, `format`.
- Produces:
  - `useItems(section)` → `{items, loadMore, hasMore, state: "loading"|"ready"|"error", refetch}`.
  - `useEvents(onCreated, onDeleted, onReconnect)`, with one `EventSource('/api/events')` for the app.
  - The card markup is exactly the mockup's `.card.item` / `.row` / `.ficon` / `.meta` / `.btns` / `.preview` / `.inside` / `.peek`.
- Behaviour:
  - Private/Global switch, date groups;
  - empty/loading/error/offline states (`states.html` §6);
  - many recipients "+N" with a tooltip; "expires in N days" in amber when ≤ 3 days;
  - text: 4-line fold, "Show all", Copy (full text), safe links;
  - PDF opens in a new tab; photo thumbnail + peek + tap lightbox; video plays inline (`<video controls>`, inline URL);
  - folder: expand entries (`GET /entries`), single-file download, "Download all" = zip;
  - inline delete confirm;
  - a deleted-by-someone-else toast.
- [ ] **Step 1: Write the failing tests:**
  - a text with `<script>` and `javascript:alert(1)` renders as plain text, with only the http link as an `<a>`, and `container.innerHTML` has no `<script`;
  - "Show all" fetches the full item; Copy copies the full text even when truncated;
  - `item.created` for the other section is ignored; for this section, inserted once even if it also arrives by refetch (dedupe by id);
  - `item.deleted` removes the card and shows "rahim deleted …";
  - an EventSource error → refetch page 1;
  - delete asks inline, and a second click within 4 s deletes;
  - a PDF opens with `target="_blank"` to `…/download?inline=1`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): lists, item cards and live updates`.

### Task 9: Visual parity and end-to-end flows

**Files:** `frontend/playwright.config.ts`, `frontend/e2e/{parity.spec.ts,flows.spec.ts,fixtures.ts}`, `frontend/e2e/mock-api.ts`

**Interfaces:**
- Playwright `channel: "chrome"`, `reducedMotion: "reduce"`, viewports 1300×1000 and 390×844.
- **Parity:** `mock-api.ts` answers `/api/*` with the mockup's exact sample data (ayman, rahim, the Gateway config text, firmware-v3.2, Site-Survey-Report.pdf, BOQ-final.xlsx, the Global items). The test opens `docs/design/mockup.html` (with the bubbles script disabled) and the app at the same view, screenshots both, and compares with `pixelmatch`; the differing pixels must be < 1 %. Views:
  - Sharing/Private;
  - Sharing/Global;
  - profile drawer;
  - login;
  - phone Sharing.
- **Flows**, against the real backend (`webServer`: uvicorn with a temp `DATA_DIR` and a dummy password, plus `vite preview` with the proxy):
  - register two users → A sends text to B → B sees it **live** → B copies it → B deletes it → A sees it vanish;
  - A uploads a 20 MB file to Global → progress reaches 100 % → B downloads it, same SHA-256;
  - A uploads a 3-file folder → B downloads the zip;
  - A changes their password → the nudge disappears.
- [ ] **Step 1: Write the specs.** **Step 2: Run** `npx playwright test`. Expected: FAIL until the earlier tasks are done, then PASS. Fix parity diffs by correcting the markup, **never by loosening the threshold**.
- [ ] **Step 3: Commit** `test(frontend): visual parity with the mockup and end-to-end flows`.

### Task 10: Build, docs, push

**Files:** `frontend/README.md`, root `README.md`, roadmap (mark plan 3 done)

- [ ] **Step 1:** `npm run build`: no type errors, and the bundle size is recorded in the ledger.
- [ ] **Step 2:** Run the whole check: `make backend-test && make frontend-test && cd frontend && npx playwright test`. Expected: all pass.
- [ ] **Step 3: Commit** `docs: frontend usage; plan 3 done`, then `git push origin feature/v2`.

---

## Corner-case review additions (2026-11-02, binding; they extend the tasks above)

The review found 7 critical and 17 other issues. Each line names the task it extends. The tests named here are added to that task's Step 1.

**Task 6: upload engine**
- **Never read files into memory:** a chunk body is `file.slice(a, b)` passed straight to `fetch`. Test: the body is a `Blob`, and `arrayBuffer`/`text` are never called.
- **Folders show one row**: "1,204 of 5,000 files · 38 MB/s · 2 min left", expandable to **failed files only**. Files smaller than one chunk run **6 at a time**; bigger files run 2 at a time with 4 chunks each. Test: 5,000 mock files render ≤ 1 folder row, and at most 6 small files are in flight.
- **Reload or closed tab:**
  - Unfinished jobs (name, size, key, relative path, targets, upload or batch id) are saved in `localStorage` (`fs.pending`).
  - After a reload they show "Interrupted — choose the file again to continue". Re-picking a file whose key matches resumes without re-sending finished chunks.
  - A `beforeunload` warning is shown while anything is sending.
  - Test: re-pick → only the missing chunks are PUT.
- **`clientKey`:**
  - SHA-256 of `name|size|lastModified|webkitRelativePath|sha256(first 64 KiB)|sha256(last 64 KiB)|recipient ids sorted numerically|is_global`.
  - When `lastModified` is falsy, a random per-pick suffix is added (no resume, no wrong-file match).
  - The same key already queued in this tab → "Already sending".
  - Tests: two files with the same name, size and `lastModified 0` get different keys; changed recipients → a different key.
- **Server answers (one test per row):**

  | Answer | Action |
  |---|---|
  | chunk 409 `already_complete` | `GET /api/uploads/{id}` → done (`item_id`) |
  | chunk/GET 404 | start a fresh upload once, then failed |
  | 401 | pause, "Please sign in again" |
  | 507 / 413 / 429 (start or mid-way) | failed, with the `states.html` §5 sentence; a folder continues with its other files |
  | `NotReadableError` / `NotFoundError` | failed: "File changed or moved — choose it again" (no retry) |
  | batch complete `failed[]` | the row ends "Done · N failed", with Retry for just those |

- **Timing:** `SpeedMeter` uses `performance.now()`. On `online` and `visibilitychange` → visible, retry at once (skip the remaining backoff), and reset the meter after a pause.
- **Engine test environment:** Uploader and `clientKey` tests run in the Vitest **node** environment (real Blob, File, crypto.subtle). The fake api counts concurrency and holds promises pending, so the "≤ 4 in flight" assertion can fail.

**Task 8: lists and live updates**
- **One live connection per browser:** tabs elect a leader through `BroadcastChannel("fs-events")`; only the leader opens the EventSource and re-broadcasts events. If the leader goes, another takes over within 3 s. Test with two fake tabs.
- **Reconnects:**
  - Back off 1 s → 30 s with jitter.
  - Refetching page 1 is debounced to once per 5 s.
  - On EventSource `error`, call `/api/auth/me`: 401 → the signed-out flow, no reconnect loop.
  - A watchdog reconnects if nothing (not even the `ping` event) arrives for 60 s. (The backend sends `event: ping`; an SSE comment would be invisible to EventSource.)
  - Refetch on `visibilitychange` → visible and on `online`.
- **Pagination + live updates:**
  - Live inserts are prepended and never move the cursor.
  - Deleted ids are kept as tombstones, so a later page can't bring them back. Test: delete, then `loadMore` returns that id → not shown.
- **An open item deleted elsewhere:**
  - An `item.deleted` for the open item closes its lightbox or expanded text.
  - A 404 on download, delete or "Show all" removes the card quietly. Tests for both.
- **Counts:** the exact number only when `!hasMore`, otherwise "50+".
- **Toasts:** "rahim sent you 'x'" on `item.created` from someone else (spec §6.5), and "rahim deleted 'x'" on delete. Both are plain text.

**Security (tasks 2, 7, 8)**
- **XSS fixture:** `<img src=x onerror=alert(1)>` and `javascript:alert(1)` in every user field (item name, folder paths, sender/recipient usernames, text, toast) → rendered as text. No `onerror` attribute is found in the DOM. URLs are built only from ids with `encodeURIComponent`. Names are never linkified.
- **CSRF:** one test spies on `fetch` across a full upload, a folder, a delete, a cancel and logout, and asserts `X-Requested-With: fs` on every non-GET request. The Uploader uses `api`, never its own `fetch`.
- **Every `target="_blank"` carries `rel="noopener noreferrer"`** (test over all rendered anchors).
- **Copy:**
  - Use `navigator.clipboard.writeText`.
  - Fall back to a hidden textarea + `document.execCommand("copy")` when not in a secure context (http on a LAN IP).
  - On failure, show "Copy failed — select the text".
  - Test both paths.

**Task 4/7/8: a design checklist.** Every `states.html` section (§1–§10) and every `mockup.html` region has a component and a render test:
- the page title and subtitle, the auto-delete notice;
- the Text/Files/Folder tabs;
- date-group headers;
- folder expand with "Download all";
- "Open in new tab ↗";
- the lightbox (Download / Delete / Close);
- toasts;
- the iPhone folder message;
- the in-page **re-sign-in** (`LoginPage` in modal mode, which must not unmount the Uploader).

Vault menus are plan 4.

**Task 9: making parity reliable**
- **Fonts:** Inter is self-hosted (OFL, woff2 in `public/fonts/`). In tests the Google Fonts URL is routed to it for both the mockup and the app, followed by `await document.fonts.ready`.
- **Motion and time:**
  - freeze the clock with `page.clock`;
  - remove `.bubbles` and `.bg i` in both pages;
  - mask relative-time nodes (`[data-time]`).
- **Comparison:** `pixelmatch` threshold 0.1 per pixel, ≤ 1 % of the area. If it fails, fix the markup; never loosen the threshold.
- **Long names:** a fixture with a 200-character name without spaces and 15 recipients; no horizontal scroll at 390 px.
- **E2E:** the server uses `CHUNK_SIZE=1048576`, waits for `/api/health`, and gets a fresh `DATA_DIR` each run. Add one flow that goes offline mid-upload (`context.setOffline(true)`) and then online → it completes with the same SHA-256.

**Task 4: phones**
- Detect folder support with `'webkitdirectory' in document.createElement('input')`; when it's missing, show the fallback message. File inputs keep `multiple` and no `accept` filter.
- Render the bubbles only when `(hover: hover)` and the screen is wider than 640 px, and pause them while the tab is hidden. They're off under reduced motion.
