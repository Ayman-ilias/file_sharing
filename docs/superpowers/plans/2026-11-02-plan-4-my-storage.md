# My storage (encrypted vault) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each regular user gets a 200 MB personal vault for passwords, notes, links, photos and files. Everything is encrypted in the browser, and the server only ever stores ciphertext.

**Architecture:**
- **Backend:** a new `/api/vault` router (key, items, blobs, erase). Vault files reuse the plan-2 chunk protocol with `target: "vault"` and are stored under `DATA_DIR/vault/`.
- **Frontend:** a `features/vault` module:
  - a WebCrypto layer (`crypto.ts`);
  - a vault state hook (`useVault`) that keeps the data key in memory only, auto-locks, and shares lock/unlock between tabs over BroadcastChannel;
  - the screens from `mockup.html#view-storage` and `states.html` §1–3, §9.

**Tech Stack:** FastAPI + SQLAlchemy (plans 1–2), React 19 + TS + Vite (plan 3), WebCrypto (AES-256-GCM, PBKDF2-SHA-256), Vitest, Playwright.

**Spec:** [docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md](../specs/2026-11-01-file-sharing-v2-design.md) §3.7, §3.8 (My storage), §4 anti-goals.
**Design (binding):** [mockup.html](../../design/mockup.html) `#view-storage`, the Profile drawer's storage section; [states.html](../../design/states.html) §1, §2, §3 and §9.
**Contracts:** [roadmap](2026-11-01-file-sharing-v2-roadmap.md): the `vault_keys` and `vault_items` tables, and the `/api/vault/*` rows. Plan 3's [ledger](2026-11-02-plan-3-ledger.md) for frontend conventions.

## Global Constraints

- **Server sees ciphertext only.** Titles, usernames, passwords, notes, link addresses, file names, mime types and file bytes are all encrypted in the browser. The server stores `meta_ct`, `blob` bytes, `salt`, `iterations` and `wrapped_key`, nothing else about content.
- **Crypto:**
  - data key: random AES-256-GCM;
  - key-encryption key: PBKDF2-SHA-256, **600 000 iterations**, 16-byte random salt;
  - every encryption uses a fresh random 12-byte IV;
  - the data key is non-extractable once unwrapped, and lives only in memory (never in localStorage, sessionStorage or IndexedDB).
- **Storage password:** ≥ 10 characters. It **cannot be reset**; the UI says so plainly (copy from `states.html` §3).
- **Quota:** `VAULT_QUOTA` = 209 715 200 bytes (200 MiB) of ciphertext per user. It counts:
  - items (blob + `meta_ct` length);
  - completed but not yet attached vault uploads;
  - bytes reserved by unfinished vault uploads.
- **Auto-lock:**
  - after **20 minutes** without activity, with a warning toast **60 s** before;
  - activity = key presses, pointer and wheel events in the page, and running vault uploads;
  - it also locks on Lock, on logout, and on tab close (memory only).
- **The global account has no My storage.** Every `/api/vault/*` route answers 403 `global_account`.
- **Two tabs:**
  - vault edits carry `version`, and a stale save gets 409 `stale_version` → "Changed in another tab — reloaded.";
  - lock, unlock, erase and a password change are shared over `BroadcastChannel("fs-vault")`.
- **The look is the mockup's look.** Classes and copy come from `mockup.html` / `states.html` (`.vault-lock`, `.vault-head`, `.q-bar`, `.kinds`, `.add-menu`, `.vgroup`, `.vgrid`, `.vcard`, `.secret`, `.photos`, `.ph`, `.menu`, `.confirm-del`, `.modal-h`, `.erase-box`, `.tick`, `.full-tag`, `.empty`). Any difference is ledgered.
- **Links:** only `http`/`https` open, always with `target="_blank" rel="noopener noreferrer"`. A bare `grafana.southerniot.net` is saved as `https://grafana.southerniot.net`.
- Commit after each task with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push `feature/v2` at the end of the plan.

## Review Focus

1. **A wrong storage password, or a tampered/garbled ciphertext** (DB edited, truncated blob) shows a clear message and never shows garbage, crashes the page, or locks the user out of erase. Tests: Task 3 (tamper, truncation), Task 5 (wrong password).
2. **Locking while a form is open or a vault upload is running.** The upload still finishes and its item is saved, and the open form's text is not silently lost: the warning toast explains, and the form closes only at the lock. Tests: Task 4, Task 7.
3. **Two tabs editing the same item** never silently overwrite each other: 409 → reload message and the latest version shown. Tests: Task 2 (server), Task 4 (client).
4. **The quota edge:**
  - an upload that would pass 200 MB is refused before any byte is sent;
  - a cancelled or failed vault upload frees its space immediately;
  - an unattached blob is freed after 24 h.

  Tests: Task 2 and Task 7.
5. **Erase or a password change while another tab is unlocked:** the other tab locks and never writes with the old key. Tests: Task 4.

---

## File structure

```
backend/app/routers/vault.py        key status, setup, key change, erase, items CRUD, blob download
backend/app/routers/uploads.py      + target "vault": quota check, complete → {blob_id, size}
backend/app/vault.py                quota maths (used_bytes), blob removal helpers
backend/app/jobs.py                 + unattached vault blobs (24 h) and vault/ orphans
backend/tests/test_vault.py, test_vault_uploads.py

frontend/src/features/vault/
  crypto.ts          KDF, wrap/unwrap, meta and blob encryption (segments)
  api.ts             typed /api/vault calls + types VaultStatus, VaultItemOut, VaultMeta
  useVault.ts        state machine, key in memory, auto-lock, BroadcastChannel, CRUD
  VaultView.tsx      chooses Setup / Lock / Open
  VaultSetup.tsx, VaultLock.tsx, EraseDialog.tsx, AutoLockToast.tsx
  VaultOpen.tsx      head + quota bar, kinds filter, Add menu, groups
  cards.tsx          PasswordCard, NoteCard, LinkCard, PhotoTile, FileRow, ItemMenu
  ItemForm.tsx       Password / Note / Link / Rename forms (modal)
  vaultFiles.ts      encrypt + upload a photo/file, download/decrypt, photo URLs
frontend/src/features/layout/ProfileDrawer.tsx   storage section: setup link / change storage password
frontend/src/features/uploads/Uploader.ts        + addVaultFile(), target vault, not persisted
frontend/e2e/vault.spec.ts, parity additions
```

---

### Task 1: Vault key endpoints (backend)

**Files:** `backend/app/routers/vault.py`, `backend/app/vault.py`, `backend/app/main.py` (include router), `backend/tests/test_vault.py`

**Interfaces:**
- Produces:
  - `GET /api/vault` → `{initialized: bool, salt: str|null, iterations: int|null, wrapped_key: str|null, used_bytes: int, quota_bytes: int, item_count: int}`. `item_count` lets the erase dialog say what will go without decrypting.
  - `POST /api/vault/setup {salt, iterations, wrapped_key}` → 204; 409 `already_initialized`.
  - `PUT /api/vault/key {salt, iterations, wrapped_key, previous_wrapped_key}` → 204; 404 `not_initialized`; 409 `stale_key` when `previous_wrapped_key` isn't the stored one (another tab changed it).
  - `POST /api/vault/erase {confirm: "ERASE"}` → 204. It deletes every vault item, every blob file, the user's vault uploads (finished or not, plus their tmp files) and the key, and writes an `audit_log` row `vault_erase`. Anything else in `confirm` → 400 `confirm_required`.
  - `app.vault.used_bytes(db, user_id) -> int`: the sum of `vault_items.size_bytes` + completed vault uploads with `item_id IS NULL` + `size - received_bytes` of unfinished vault uploads.
- Validation:
  - `salt` is base64 of exactly 16 bytes;
  - `iterations` is in 600 000 … 5 000 000;
  - `wrapped_key` is base64, 40–200 bytes decoded;
  - anything else → 422.

- [ ] **Step 1: Write the failing tests** in `test_vault.py`:
  - `test_status_before_setup` (`initialized` false, `quota_bytes` 209715200);
  - `test_setup_then_status`;
  - `test_setup_twice_409`;
  - `test_key_change_needs_previous` (wrong previous → 409 `stale_key`; right → 204, new values returned by GET);
  - `test_key_change_before_setup_404`;
  - `test_erase_requires_word`;
  - `test_erase_removes_items_blobs_uploads_key` (files on disk gone, audit row present);
  - `test_vault_forbidden_for_global_account` (every `/api/vault` route → 403);
  - `test_setup_rejects_weak_iterations_and_bad_salt`;
  - `test_vault_needs_csrf_header` (POST without `X-Requested-With` → 403).
- [ ] **Step 2: Run** `cd backend && uv run pytest -q tests/test_vault.py`. Expected: FAIL (404s).
- [ ] **Step 3: Implement** with the `require_regular_user` dependency on the router.
- [ ] **Step 4: Run** the whole backend suite and `uv run ruff check .`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(backend): vault key, status and erase`.

### Task 2: Vault items, blobs and vault uploads (backend)

**Files:** `backend/app/routers/vault.py`, `backend/app/routers/uploads.py`, `backend/app/jobs.py`, `backend/app/vault.py`, `backend/tests/test_vault_items.py`, `backend/tests/test_vault_uploads.py`; remove `test_vault_target_not_yet_supported`.

**Interfaces:**
- Consumes: `used_bytes` (Task 1); plan 2's upload code (`_create`, `finalize_file`, `upload_locks`).
- Produces:
  - `GET /api/vault/items` → `[VaultItemOut]`, where `VaultItemOut = {id, meta_ct, blob_id|null, size_bytes, version, created_at, updated_at}`, newest first, at most 5 000.
  - `POST /api/vault/items {meta_ct, blob_id?}` → 201 `VaultItemOut`.
    - `meta_ct` is base64, ≤ 1 400 000 characters (a 1 MiB note, encrypted and encoded) → else 413 `too_large`.
    - `blob_id` must be this user's completed vault upload that isn't attached yet (else 404 `not_found`), and is then attached (`upload.item_id = vault item id`).
    - `size_bytes` = blob size + `len(meta_ct)`.
    - Quota: `used_bytes + len(meta_ct) > quota` → 507 `vault_full` (the blob was already counted while unattached).
  - `PUT /api/vault/items/{id} {meta_ct, version}` → 200 with `version + 1`. A stale version → 409 `{detail: "stale_version", current: VaultItemOut}`. The new `meta_ct` length is re-checked against the quota.
  - `DELETE /api/vault/items/{id}` → 204: the row, the blob file and the attached upload row are gone. Another user's id → 404.
  - `GET /api/vault/items/{id}/blob`:
    - an X-Accel-Redirect to `/protected/vault/…` (with `SERVE_FILES`, the bytes themselves);
    - `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="blob"`, `Cache-Control: private, no-store`.
  - `POST /api/uploads` with `target: "vault"`:
    - recipients and `is_global` must be empty/false (else 400 `bad_target`);
    - `used_bytes + size > quota` → 507 `vault_full` before anything is created;
    - otherwise the same chunk protocol; vault uploads count toward the plan-2 per-user upload limits.
  - `POST /api/uploads/{id}/complete` for a vault upload moves the file to `vault/` and returns 201 `{blob_id, size}` (repeat → 200, same body). It creates no shared item and sends no live event.
  - Cleanup (`run_cleanup`): completed vault uploads with `item_id IS NULL` and `updated_at` older than `stale_after_hours` are deleted together with their `vault/` file. `sweep_orphans` also covers `vault/`: a file is known when some `vault_items.blob_id` or vault `uploads.storage_id` names it.

- [ ] **Step 1: Write the failing tests:**
  - **Items** (`test_vault_items.py`):
    - `test_create_list_update_delete`;
    - `test_stale_version_409_returns_current`;
    - `test_other_users_item_404` (GET blob, PUT, DELETE);
    - `test_meta_only_counts_toward_quota`;
    - `test_attach_blob_once` (a second attach → 404);
    - `test_attach_someone_elses_blob_404`;
    - `test_delete_frees_quota_and_file`;
    - `test_blob_download_headers` (accel path under `/protected/vault/`, attachment, no-store).
  - **Uploads** (`test_vault_uploads.py`):
    - `test_vault_upload_roundtrip` (start, chunks, complete → `{blob_id}`, file under `vault/`, no `Item` row, no SSE event);
    - `test_vault_upload_refused_over_quota_before_bytes` (507 `vault_full`, no upload row);
    - `test_vault_quota_counts_reserved_and_unattached`;
    - `test_cancel_vault_upload_frees_quota`;
    - `test_vault_upload_rejects_recipients`;
    - `test_unattached_blob_swept_after_24h`;
    - `test_orphan_sweep_covers_vault`;
    - `test_vault_complete_idempotent`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `complete` branches on `up.target`. Vault finalize = `finalize_file` with the destination kind `"vault"` (add a `kind` parameter, default `"files"`).
- [ ] **Step 4: Run** the backend suite, ruff and `alembic check` (no schema change is expected: `uploads.item_id` is plain text). Expected: all pass.
- [ ] **Step 5: Commit** `feat(backend): vault items, blobs and encrypted uploads`.

### Task 3: Browser crypto

**Files:** `frontend/src/features/vault/crypto.ts`, `crypto.test.ts` (Vitest **node** environment: real `crypto.subtle`)

**Interfaces:**
- Produces (all base64 is standard base64 with padding):
  - `ITERATIONS = 600_000`, `SEGMENT = 4 * 1024 * 1024`.
  - `newSalt(): string` (16 random bytes).
  - `deriveKek(password: string, salt: string, iterations: number): Promise<CryptoKey>` (PBKDF2-SHA-256 → AES-GCM-256; usages wrapKey/unwrapKey).
  - `newDataKey(): Promise<CryptoKey>` (extractable only so it can be wrapped once).
  - `wrapDataKey(key, kek): Promise<string>` = base64(iv ‖ wrapped).
  - `unwrapDataKey(wrapped, kek): Promise<CryptoKey>` (non-extractable; usages encrypt/decrypt). A wrong password throws `WrongPassword`.
  - `encryptMeta(meta: VaultMeta, key): Promise<string>`, `decryptMeta(ct, key): Promise<VaultMeta>`. AAD = `"fsv1:meta"`. A bad tag throws `Corrupt`.
  - `encryptBlob(file: Blob, key, onProgress?): Promise<Blob>`:
    - format: `"FSV1"` (4 bytes) ‖ a random 8-byte nonce prefix ‖ segments;
    - each segment = AES-GCM(plain ≤ `SEGMENT`), with IV = prefix ‖ uint32 big-endian segment index and AAD = `"fsv1:blob:" + index + ":" + (last ? "end" : "more")`;
    - reads one segment at a time with `file.slice().arrayBuffer()`, so the whole file is never in memory twice.
  - `decryptBlob(blob: Blob, key, mime: string): Promise<Blob>`. Wrong magic, a truncated last segment, or reordered or missing segments → `Corrupt`.
  - `VaultMeta` (in `api.ts`, re-exported) is one of:
    - `{kind: "password", title, username, url, password, note}`
    - `{kind: "note", title, text}`
    - `{kind: "link", title, url, note}`
    - `{kind: "photo" | "file", name, mime, size, note?}`
- [ ] **Step 1: Write the failing tests:**
  - **Key and meta:**
    - `wrap → unwrap with the right password works, and the unwrapped key is not extractable`;
    - `the wrong password throws WrongPassword`;
    - `meta round-trips`;
    - `two encryptions of the same meta differ (fresh IV)`;
    - `a flipped byte in meta → Corrupt`.
  - **Blobs:**
    - `blob round-trips across 3 segments (use SEGMENT = 1024 via an optional parameter)`;
    - `an empty file round-trips`;
    - `a truncated blob → Corrupt`;
    - `swapped segments → Corrupt`;
    - `a dropped last segment → Corrupt (the "end" AAD)`;
    - `derivation uses 600 000 iterations` (spy on `subtle.deriveKey` params).
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(frontend): vault crypto (AES-GCM, PBKDF2 600k, segmented blobs)`.

### Task 4: Vault state (`useVault`)

**Files:** `frontend/src/features/vault/api.ts`, `useVault.ts`, `useVault.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3, the `api` client.
- Produces: `useVault()`, a singleton store like `useUploads`, exposing:
  - `status: "loading" | "setup" | "locked" | "open"`;
  - `lockedBecause: "idle" | "manual" | "other-tab" | null`;
  - `items: DecryptedItem[]`, where `DecryptedItem = VaultItemOut & {meta: VaultMeta} | {..., meta: null, broken: true}` (a broken item can still be deleted);
  - `usedBytes`, `quotaBytes`, `itemCount`;
  - `setup(password)`;
  - `unlock(password)`, which throws `WrongPassword`;
  - `lock(reason?)`;
  - `erase()`;
  - `changePassword(current, next)`;
  - `add(meta, blobId?)`;
  - `update(id, meta)`, which on 409 refreshes and throws `StaleVersion`;
  - `remove(id)`;
  - `refresh()`;
  - `touch()`, which counts as activity;
  - `lockWarning: boolean`, true for the last 60 s.
- Rules:
  - The data key lives in a module variable, never in React state, storage or logs.
  - Auto-lock: `IDLE = 20 * 60_000` and `WARN = 60_000`. Activity listeners (`keydown`, `pointerdown`, `wheel`) are added only while open. `touch()` is also called by running vault uploads.
  - `BroadcastChannel("fs-vault")` messages:
    - `{t: "unlocked", key}`: a CryptoKey can be posted between same-origin tabs;
    - `{t: "locked"}`;
    - `{t: "changed"}`: items changed, so refresh;
    - `{t: "erased"}`;
    - `{t: "rekeyed"}`: after a password change; other tabs keep the same data key, so nothing changes for them.
  - On `fs:signed-out` or a sign-in as another user: lock and drop everything.
- [ ] **Step 1: Write the failing tests** (mocked `fetch`, fake timers, a fake BroadcastChannel):
  - **Setup and unlock:**
    - `setup posts salt, 600000 and wrapped key, then status is open`;
    - `unlock with the wrong password keeps locked and throws WrongPassword`;
    - `items decrypt after unlock; an item that fails to decrypt is marked broken, not thrown`.
  - **Auto-lock:**
    - `auto-lock after 20 min idle, warning at 19 min; a key press resets it; touch() resets it`;
    - `lock drops the key: after lock, add() throws Locked`.
  - **Other tabs:**
    - `another tab's unlock opens this tab; its lock locks this tab with lockedBecause other-tab`;
    - `erase in another tab → this tab goes to setup`.
  - **Edits and other users:**
    - `update with a stale version → StaleVersion and the list holds the server's current`;
    - `changePassword re-wraps: unlock works with the new password, not the old`;
    - `a different user signing in locks and clears items`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): vault state, auto-lock and tab sync`.

### Task 5: Setup, lock, erase, profile

**Files:** `VaultView.tsx`, `VaultSetup.tsx`, `VaultLock.tsx`, `EraseDialog.tsx`, `AutoLockToast.tsx`, `App.tsx` (the My storage tab renders `<VaultView/>`), `ProfileDrawer.tsx` (+ tests)

**Interfaces:**
- Consumes: `useVault` (Task 4).
- Produces: the screens exactly as `states.html` §3 and the mockup's lock card:
  - **Setup:**
    - shield icon, "Set up My storage", the hint "At least 10 characters. Don't reuse your login password.";
    - Repeat field and the tick box;
    - "Create My storage", disabled until both passwords are ≥ 10 characters and equal and the box is ticked.
    - Errors: "The passwords don't match." and "Use at least 10 characters."
    - Shows "Setting up…" while PBKDF2 runs.
  - **Lock:**
    - "My storage is locked";
    - `.why-locked` "Locked after 20 minutes without activity" only when `lockedBecause === "idle"`;
    - the password input and Unlock;
    - a wrong password → "Wrong storage password.";
    - small text "Forgot it? It cannot be reset. That is what keeps it private." plus a link "Erase My storage and start again" that opens EraseDialog.
  - **Erase dialog:**
    - `.erase-box` text: "This permanently deletes everything in My storage (84.6 MB, 9 items). It can't be undone. Your shared files are not affected." The kinds are encrypted, so this uses counts only, not the mockup's per-kind list (ledgered).
    - "Type ERASE to confirm"; the button is enabled only on exactly `ERASE`.
  - **AutoLockToast:** "My storage locks in 60 s because you've been away." with a "Stay unlocked" button that calls `touch()`.
  - **Honest limit (spec §3.7):** under the lock and setup cards, a `.hintline` toggle "How private is this?" opens: "Your items are encrypted in this browser before they are saved, so the database, backups and colleagues can't read them. Someone who controls the server and changes the app it sends you could capture your storage password. Use it for work notes and passwords, not for anything that must survive a compromised server." Ledgered: the design has no slot for it.
  - **Profile storage section:**
    - before setup: "You haven't set up My storage yet." + "Set up My storage", which opens the My storage tab;
    - after setup: the mockup's form (current storage password, new storage password, "Change storage password"), with errors "Current storage password is wrong." and "Use at least 10 characters.", and success "Storage password changed.".
- [ ] **Step 1: Write the failing tests:**
  - **Setup:**
    - `setup button disabled until ≥ 10, equal and ticked`;
    - `setup creates and opens`.
  - **Lock:**
    - `wrong unlock shows the message and clears the field`;
    - `idle lock shows the why-locked line; manual lock doesn't`.
  - **Erase:** `erase needs exactly ERASE and goes back to setup`.
  - **Auto-lock toast:** `the toast appears in the last minute and Stay unlocked keeps it open`.
  - **Profile:**
    - `profile: Set up My storage switches to the tab`;
    - `profile: change storage password`.
  - **Shell:** `the global account still has no My storage tab` (regression).
- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): vault setup, lock, erase and profile`.

### Task 6: The open vault (cards, forms, menus)

**Files:** `VaultOpen.tsx`, `cards.tsx`, `ItemForm.tsx` (+ tests)

**Interfaces:**
- Consumes: `useVault`, `copyText`, `DeleteButton` (plan 3), `formatBytes`, `relativeTime`.
- Produces the mockup's open view:
  - **Head:**
    - `.vault-head` with "Encrypted, only you can see this", the autolock line and a Lock button;
    - `.q-bar` with `--p = used/quota`, and `.q-foot` "84.6 MB of 200 MB used / 115.4 MB free";
    - when full (free < 1 MiB): `.q-bar.full`, "Full" `.full-tag`, and "Delete something to add more", with Add disabled and `title` explaining why.
  - **Filter and Add:**
    - `.kinds` filter: All, Notes, Links, Passwords, Photos, Files;
    - the Add menu with Note, Link, Password, Photo, File (Photo and File go to Task 7).
  - **Groups**, in this order: Passwords, "Notes and links", Photos, Files. A group is hidden when empty.
  - **Empty state:** "Nothing saved yet …" + "Add the first one".
  - **Cards** (`states.html` §1):
    - **Password:** title, "username · url"; dots with reveal and copy; ⋯ menu Edit / Copy password / Copy username / Delete.
    - **Note:** title, "Edited N ago", snippet (first 200 characters); ⋯ menu Edit / Copy note / Delete.
    - **Link:** the title is an `<a class="ttl-link" target="_blank" rel="noopener noreferrer">` (title only, not the whole card), host as subtitle, note as snippet; ⋯ menu Edit / Copy address / Delete.
    - **File row** (`.card.item`): "size · added Oct 12", Download, and ⋯ Rename / Delete.
  - **Delete inline:** the menu's Delete turns into `.confirm-del` "Delete?" for 4 s.
  - **Forms** (`states.html` §2, as a modal over `.overlay`):
    - **Password:** title, username, website or IP, password with show and Generate (20 characters from letters, digits and `!@#$%^&*-_=+`, via `crypto.getRandomValues`), note.
    - **Note:** title placeholder "First line is used if empty"; an empty body → "Write something before saving.".
    - **Link:** address check → "That isn't a web address. Example: grafana.southerniot.net".
    - **Rename:** a name field.
    - Save calls `add`/`update`. `StaleVersion` → toast "Changed in another tab — reloaded." and the form stays open with the user's text.
  - Every user value is rendered as text (no HTML).
- [ ] **Step 1: Write the failing tests:**
  - **Cards and view:**
    - `cards per kind render as the mockup (classes, texts)`;
    - `kinds filter`;
    - `password reveal and copy`;
    - `link title opens in a new tab with noopener noreferrer; javascript: urls are refused at save`;
    - `full storage disables Add with the reason`;
    - `XSS fixture in every field renders as text`.
  - **Forms:**
    - `note: empty → error; title defaults to the first line`;
    - `link: "grafana southerniot" → error; "grafana.southerniot.net" → saved as https://…`;
    - `generate makes 20 characters from the set`.
  - **Menus and saving:**
    - `⋯ Delete asks inline then deletes`;
    - `stale save keeps the form and shows the toast`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): My storage cards, forms and menus`.

### Task 7: Encrypted photos and files

**Files:** `vaultFiles.ts`, `Uploader.ts` (+ `addVaultFile`), `VaultOpen.tsx` (queue + photos), `cards.tsx` (`PhotoTile`) (+ tests)

**Interfaces:**
- Consumes: `encryptBlob` / `decryptBlob`, `Uploader`, `useVault.add` and `touch`.
- Produces:
  - `Uploader.addVaultFile(cipher: Blob, label: string, finish: (blobId: string) => Promise<void>): string` (returns the job id).
    - Target `{vault: true}`: `POST /api/uploads` with `target: "vault"` and no recipients.
    - On complete it calls `finish(blob_id)`. The job is `done` only after `finish` resolves; if `finish` fails, the job is failed with reason `rejected` and a Retry re-runs `finish`.
    - Vault jobs are never saved to localStorage: after a reload the key and the ciphertext are gone.
    - `Job.vault: boolean`, so the vault view shows only vault rows and the Sharing view only sharing rows.
  - `vaultFiles.addFiles(files: File[], kind: "photo" | "file")`:
    - for each file: build `meta`, encrypt it now (so a lock mid-upload doesn't matter), encrypt the blob, and check `cipher.size + meta_ct.length` against the free quota;
    - too big → no upload, message "Not enough space in My storage (needs X, Y free).";
    - otherwise `addVaultFile(cipher, name, (blobId) => add(meta_ct, blobId))`;
    - running jobs call `touch()` on progress.
  - Photos:
    - Photo kind accepts only `image/png|jpeg|gif|webp` (the picker uses `accept`); other files are refused with "Only PNG, JPEG, GIF or WebP photos. Add it as a File instead.".
    - The `.photos` grid of `.ph` tiles decrypts lazily (IntersectionObserver), each with an object URL as the background image.
    - Hover or tap shows `.ph-act` Download and Delete; a click opens the plan-3 `Lightbox` with the decrypted image.
    - Object URLs are revoked on lock and on unmount.
  - File row Download fetches the blob → `decryptBlob` → `startDownload` of an object URL with the original name (via an `<a download="name">`).
  - The vault view shows the `UploadQueue` with vault jobs only.
- [ ] **Step 1: Write the failing tests:**
  - **Uploading:**
    - `addVaultFile posts target vault, then finish attaches; the job is done only after finish`;
    - `finish failure → failed, Retry re-runs finish without re-uploading`;
    - `vault jobs are not persisted`;
    - `over quota → message, nothing uploaded`;
    - `lock during upload: the item still attaches (meta was encrypted before)`;
    - `uploads call touch()`.
  - **Opening and reading:**
    - `photo kind refuses a PDF`;
    - `photo tile shows the decrypted image; lightbox opens; URLs revoked on lock`;
    - `file download decrypts to the original bytes and name`;
    - `a broken blob shows "This file can't be decrypted" and can still be deleted`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(frontend): encrypted photos and files in My storage`.

### Task 8: Parity, end-to-end, docs, push

**Files:** `frontend/e2e/parity.spec.ts`, `frontend/e2e/vault.spec.ts`, `frontend/e2e/mock-api.ts` (vault fixtures), READMEs, roadmap

- [ ] **Step 1: Parity** (< 1 % of pixels, same rules as plan 3), against the mockup's sample vault (2 passwords, 1 note, 1 link, 4 photos, 1 file, 84.6 MB used). The mock API serves real ciphertext made with `crypto.ts` in Node, with the mockup's photo as the encrypted photo blobs. Views:
  - the lock screen;
  - the open vault at 1300 px;
  - the open vault at 390 px.
- [ ] **Step 2: Flows** against the real backend:
  - set up → add a note, a password and a photo → lock → unlock → all three show, the photo decrypted;
  - the DB holds no plaintext (the test reads `app.db` and the `vault/` files and searches for the note text and the password → not found);
  - two tabs: edit in tab A, a stale save in tab B → the reload message;
  - erase → back to setup and the quota freed;
  - change the storage password → the old one fails and the new one unlocks.
- [ ] **Step 3: Run** the full check: `make backend-test && make frontend-test && cd frontend && npx playwright test`. Expected: all pass.
- [ ] **Step 4: Docs:**
  - `frontend/README.md` (vault module and the crypto format);
  - `backend/README.md` (vault API, quota rules);
  - roadmap: plan 4 ✔.
- [ ] **Step 5: Commit** `docs: My storage; plan 4 done`, then `git push origin feature/v2`.

---

## Decisions and corner-case additions (2026-11-02, binding; they extend and override the tasks above)

The owner asked for the open questions to be decided by agents. Process:
- an independent corner-case review (24 findings);
- 5 reviewers (security, staff user, browser engineer, design guardian, maintainer), then a debate round;
- 3 fresh judges on the points still split.

Record: `docs/superpowers/plans/2026-11-02-plan-4-decisions.md`.

**Decisions**

| # | Question | Decision | Vote |
|---|---|---|---|
| D1 | Vault upload interrupted by a reload | Restart from zero after re-pick; no resume across reloads (resuming would reuse AES-GCM IVs when a file changes) | 5/5 |
| D2 | Honest limit (spec §3.7) | Reword the mockup's false sentence in place; no new toggle (the Task 5 toggle is dropped). Lock card: "Your notes, links, passwords and photos are encrypted on this device before they are saved, so the database, backups and colleagues can't read them. Only your storage password opens them." Its `<small>`: "Forgot it? It cannot be reset. That is what keeps it private. It can't protect you if the server itself is taken over." Full text goes in the README. | 5/5 |
| D3 | Erase and setup | Setting up My storage **requires your own login password** (an account still on the shared starting password gets 403 `own_password_required` and the message "Set your own login password first (Profile)." with a button that opens Profile). **Erase** needs the typed `ERASE` **and** the current login password (a `.field` above the ERASE field, checked by the server: wrong → 401 `bad_credentials` "Login password is wrong."). | 4/5 |
| D4 | Photo grid | Each photo gets an encrypted thumbnail inside its `meta`: ~400 px wide JPEG at quality 0.7 (`createImageBitmap` + canvas, which also strips EXIF), ≤ 60 KB. Tiles use it; the Lightbox and Download decrypt the full photo (one at a time). No thumbnail or a broken one → a plain tile; the full photo decrypts on click. | 5/5 |
| D5 | A tab opened later | Opens **locked** (needs the password). Tabs already open share unlock: `{t:"unlocked", key, uid, keyGen}` over BroadcastChannel; each tab runs its own idle timer and ignores messages for another `uid` or `keyGen`. | 4/5 (new tab), judges 3/3 (open tabs) |
| D6 | Orphaned reservation after a reload | The server cancels this user's unfinished vault uploads with no chunk for **> 5 min** when a new vault upload starts and before computing `used_bytes`. "Not enough space" also says "X MB is held by an upload that didn't finish." with **[Cancel it]**, which cancels this user's unfinished vault uploads with no chunk for ≥ 30 s (never one still running in another tab). | 5/5; button by judges 2/3 |
| D7 | Telling the user | A `beforeunload` warning while a vault upload runs. Next time My storage opens in that tab, the toast "1 upload to My storage didn't finish. Add it again." (only a count in sessionStorage, `.toast` style). | judges 2/3 |

**Corner-case additions (each line names the task it extends; the tests go in that task's Step 1)**

- **T2, T7: no plaintext in `uploads`.** For `target:"vault"` the server stores `name="blob"` and `mime="application/octet-stream"` whatever is sent. `client_key` = `vault:` + `crypto.randomUUID()`. The resume query also matches `target`. Tests:
  - `test_vault_upload_stores_no_name_or_mime`;
  - `test_vault_upload_never_resumes_other_ciphertext`;
  - e2e: the DB and the `vault/` files hold no file name, photo name, note text or password.
- **T1, T2, T4: `key_gen`.** `vault_keys.key_gen` (a random 16-hex string, new on every setup; migration `0003_vault_keygen`) is returned by GET. Item POST/PUT and vault upload start send it; a mismatch → 409 `key_changed`, and the client locks and reloads its status. Before setup: items and vault uploads → 404 `not_initialized`. Tests:
  - `test_item_write_with_old_key_gen_409`;
  - `test_vault_upload_before_setup_404`.
- **T3, T4: extractability.**
  - `unwrapDataKey(wrapped, kek, {extractable = false})`. Only `changePassword` unwraps an extractable key, temporarily, to re-wrap it.
  - After setup, the data key is re-unwrapped as non-extractable before it is kept or broadcast.
  - `changePassword` first GETs a fresh status (a stale `previous_wrapped_key` → 409 `stale_key` → "Changed in another tab — try again."); it works while locked and does not unlock.
  - Tests: `key held after setup is not extractable`; `changePassword works while locked and does not unlock`.
- **T4: auto-lock that works across tabs and sleep.**
  - Activity is shared over the channel (throttled `{t:"active", at}` every 30 s).
  - The lock uses a `Date.now()` deadline, re-checked on `visibilitychange` and on a 15 s tick.
  - It also locks on `pagehide` (the back-forward cache).
  - Tests: `activity in tab A keeps tab B open`; `wake after 25 min sleep → locked at once`; `pagehide → locked`.
- **T2: quota correctness.**
  - Vault upload start reserves the blob size plus a **64 KiB meta allowance**, so attach succeeds when `meta_ct` ≤ 64 KiB, or within what is free.
  - A completed but unattached vault upload can be cancelled (DELETE removes its `vault/` file).
  - Every vault quota check runs under `QUOTA_LOCK`.
  - PUT checks the size *difference* (new − old meta).
  - `meta_ct` is capped at 1 400 000 characters for notes; a photo meta with its thumbnail fits in the 64 KiB allowance.
  - Tests:
    - `test_attach_over_quota_frees_blob` (the client cancels the blob after a 507 on attach);
    - `test_delete_unattached_vault_upload`;
    - `test_parallel_item_posts_respect_quota`;
    - `test_edit_near_full_uses_delta`;
    - `test_idle_vault_upload_cancelled_when_new_one_starts` (D6);
    - `test_release_held_spares_active_upload` (D6).
- **T7: one file at a time, size first.**
  - Files are encrypted **one at a time, just before their own upload**; the cipher Blob is dropped once its job is done.
  - The expected ciphertext size, `4 + 8 + 4 + n_seg × 16 + size` (with the header from the T3 line below), is checked against the **running total** of free space before encrypting.
  - 507 `vault_full` gets its own reason and message.
  - Test: `multi-select over free space refuses the overflow up front`.
- **T7: downloads.**
  - The blob is fetched as a stream and decrypted segment by segment into parts. The decrypted Blob for Download is always `application/octet-stream` (an HTML or SVG file can never run in the app's origin), with the real name via `<a download>`.
  - The Lightbox and tiles accept only png, jpeg, gif or webp from the decrypted meta.
  - Link and password URLs are checked again at render (only http/https become links).
  - Tests: `file download blob type is octet-stream`; `meta with a javascript: url renders as plain text`.
- **T1: erase.**
  - It takes the upload locks of the user's vault uploads, so a `complete` racing it leaves no file and no 500.
  - Other tabs cancel their vault jobs on `{t:"erased"}`.
  - The audit actions are `vault_erase` and `vault_key_change`.
  - Test: `erase during an upload's complete leaves no file and no 500`.
- **T3: crypto format.**
  - The header is `"FSV1"` ‖ uint32 segment size ‖ an 8-byte nonce prefix.
  - An empty file still has one final segment (AAD `end`); a header-only blob, or bytes after the end segment → `Corrupt`.
  - The meta stores the blob's nonce prefix, and `decryptBlob` checks it (no swapping photos between items).
  - Meta and wrapped-key formats start with a version byte `1`; status returns `kdf: "pbkdf2-sha256"`.
  - The password is NFC-normalised before PBKDF2.
  - Server `iterations` < 600 000 are refused by the client too.
  - Tests: one per rule.
- **T4, T5: setup half done.** `setup` getting 409 `already_initialized` → go to the lock screen and try unlocking with the password just typed. Test: `setup 409 → unlock with same password`.
- **T4, T7: sessions and broadcast.**
  - Every channel message carries `uid` and `keyGen`; mismatches are ignored.
  - On `fs:signed-out` vault jobs pause like shared ones. Their `finish` is `addEncrypted(meta_ct, blobId)` (the meta was encrypted before the upload, so a lock doesn't matter).
  - A sign-in as another user drops them.
  - Test: `paused vault job attaches after re-sign-in as the same user; dropped for another user`.
- **Minor, to include:**
  - **Server:**
    - item 5 001 → 409 `too_many_items` ("My storage holds at most 5,000 items.");
    - the global account gets 403 on a vault-target upload (test).
  - **Editing:** PUT to an item deleted in another tab → 404 → "Deleted in another tab."
  - **Unlocking and offline:**
    - unlock shows "Unlocking…" with the button disabled while PBKDF2 runs;
    - offline saves keep the form open with "You're offline — saved nothing yet.".
  - **Phones:** a tap on a photo opens the Lightbox with Download, Delete and Close (`.ph-act` is shown on hover only).
  - **Accessibility:**
    - the toast is `role="status"`;
    - reveal uses `aria-pressed`;
    - the ⋯ menu closes on Esc and returns focus;
    - the modal traps focus;
    - focus goes to the password field on lock.
  - **Link field:**
    - accepts an IP, a port or `HTTP://`;
    - trims spaces;
    - refuses `//host` and spaces inside.
  - **Wiring:**
    - `App.tsx` passes the vault status and an `onSetupStorage` that opens the tab;
    - `VaultView` stays mounted (hidden) when switching tabs, so form text and decrypted thumbnails survive.
  - **Insecure page:** without `crypto.subtle`, the message "My storage needs a secure (https) connection."
  - **Clipboard:** a copied password is cleared after 30 s if the clipboard still holds it (best effort; not when reading it is refused).
- **Dropped from the plan:** the "How private is this?" toggle (Task 5), replaced by D2.
