# SDD ledger — plan: docs/superpowers/plans/2026-11-02-plan-4-my-storage.md
Executor: inline (superpowers:executing-plans). Spec: docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md §3.7-3.8.
Pre-flight: the binding "Decisions and corner-case additions" section overrides tasks 1-8; interfaces T1→T2 (used_bytes, key_gen), T3→T4 (crypto API incl. extractable option), T4→T5/T6/T7 (useVault incl. addEncrypted), T2/T7 (vault upload target, held release) — checked, consistent once the additions are applied.
Task 1: Ruling: GET /api/vault also returns key_gen, kdf and held_bytes (needed by the binding additions D3/D6) — cost if wrong: none
Task 1: Ruling: used_bytes reserves a 64 KiB meta allowance per unfinished or unattached vault upload (addition "quota correctness") — cost if wrong: a nearly full vault refuses an upload 64 KiB earlier
Task 1: complete (commits cb7769d..c7f4a0f, tests: bash -c 'cd backend && uv run pytest -q' → .........................                                                [100%])
Task 2: Ruling: the erase-race test drives one TestClient from two threads (one event loop, like production's single uvicorn worker); a second TestClient has its own loop and an asyncio lock can't span loops — mutation check: fails without erase's locks (FileNotFoundError), passes with them
Task 2: Ruling: POST /api/vault/release-held returns {released_bytes} and cancels this user's vault uploads quiet ≥ 30 s (D6 [Cancel it]) — cost if wrong: none
Task 2: Ruling: a vault upload start that comes with a non-matching key_gen is 409 key_changed; key_gen is required for vault uploads (None never matches) — cost if wrong: none
Task 2: complete (commits c7f4a0f..cf50356, tests: bash -c 'cd backend && uv run pytest -q' → .............................................................            [100%])
Task 3: Ruling: encryptBlob returns {blob, prefix}; the prefix goes into FileMeta and decryptBlob checks it (binding addition) — cost if wrong: none
Task 3: Ruling: decryptBlob reads the ciphertext Blob segment by segment (not the fetch stream); the browser keeps big fetched Blobs on disk on desktop — iOS memory for a 200 MB file stays a known risk, re-checked in Task 8 — cost if wrong: a very large vault file may not open on an old iPhone
Task 3: Ruling: api.send accepts PUT (JSON) for the vault key/items routes — cost if wrong: none
Task 3: Ruling: the task-done run surfaced an unhandled rejection from logout() when the server answers 401 (Sign in as someone else) — fixed with a test (session.test 'logout always signs out here…') — cost if wrong: none
Task 3: complete (commits cf50356..c6a05ef, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →              learn more: https://vitest.dev/guide/improving-performance#test-environments)
Task 4: Ruling: the store is a class (VaultStore, store.ts) with a thin useVault hook, like the upload engine — the plan named only useVault.ts — cost if wrong: none
Task 4: Ruling: crypto and store test files raise the per-test timeout to 20 s (PBKDF2 600k is slow on purpose; one run timed out under load, passes alone and twice in a row) — cost if wrong: a real hang takes 20 s to show
Task 4: Ruling: snapshot() re-checks the idle deadline on every read (and on a 15 s tick and visibilitychange), so a sleeping laptop locks on wake — cost if wrong: none
Task 4: complete (commits 3ef5c40..338a589, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →              learn more: https://vitest.dev/guide/improving-performance#test-environments)
Task 5: Ruling: ProfileDrawer takes a `vault` prop {initialized, changePassword} instead of reading the store, so it never touches the key — cost if wrong: none
Task 5: Ruling: both views stay mounted; the hidden one gets the mockup's `hidden` class (binding addition "VaultView stays mounted") — the old App test now checks the class — cost if wrong: none
Task 5: Ruling: the lock card's small text carries the honest line "It can't protect you if the server itself is taken over." plus a link-styled "Erase My storage and start again" button (D2, D3) — cost if wrong: copy edit; parity of the lock view re-checked in Task 8
Task 5: Ruling: the drawer's storage text stays the mockup's ("It never leaves this device…") — the user advocate's rewording was a suggestion, not a panel decision — cost if wrong: copy edit
Task 5: complete (commits 338a589..91b640f, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →              learn more: https://vitest.dev/guide/improving-performance#test-environments)
Task 6: Ruling: a password without a title is named after its website, then username, then "Password"; a link without a title is named after its host — the forms show Title without "(optional)" in states.html §2, but refusing a save for a missing title helps nobody — cost if wrong: copy edit
Task 6: Ruling: file rows say "size · added <relative time>" (mockup "added Oct 12"), notes "Edited <relative time>" — cost if wrong: copy edit
Task 6: Ruling: items that can't be decrypted go in a "Can't be opened" group with Delete only — cost if wrong: copy edit
Task 6: Ruling: copying a password clears the clipboard after 30 s if it still holds that password (best effort) — binding minor — cost if wrong: none
Task 6: complete (commits 91b640f..0e29c8c, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →              learn more: https://vitest.dev/guide/improving-performance#test-environments)
Task 7: Ruling: addVaultFile takes the keyGen (the server checks it on upload start) — the plan's signature lacked it but the binding key_gen addition needs it — cost if wrong: none
Task 7: Ruling: a failed attach keeps the blob for Retry only when the failure is retryable (network/5xx); 507 vault_full or 4xx frees the blob and fails without Retry — cost if wrong: the user re-adds the file
Task 7: Ruling: `.ph-act` (Download/Delete) is always visible, as the copied CSS has no hover rule; a tap on a tile opens the Lightbox (Download/Delete/Close) — cost if wrong: CSS tweak
Task 7: Ruling: files are added strictly one after another (encrypt → upload → attach → next), so only one ciphertext is in memory; this gives up 2-at-a-time parallelism for vault files (≤ 200 MB in total) — cost if wrong: slower multi-file adds
Task 7: Ruling: thumbnails are keyed on item ids+versions (the parent re-renders on upload progress) — cost if wrong: none
Task 7: complete (commits 0e29c8c..48434d2, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →              learn more: https://vitest.dev/guide/improving-performance#test-environments)
Task 8: Ruling: found while planning the two-tab e2e: store.update used the latest known version, so a refresh during an open form allowed a silent overwrite — update(id, meta, baseVersion) with tests (store + VaultOpen), a second Save after the message is a deliberate overwrite — cost if wrong: none
Task 8: Ruling: the vault-lock parity puts the decided D2 copy into the mockup DOM before comparing (layout/fonts/spacing still compared pixel for pixel); the app reaches the lock screen through a real 21-minute idle lock (page.clock) so the "Locked after 20 minutes" pill is real — cost if wrong: none
Task 8: Ruling: D2 wording tightened to the mockup's line count, as the design guardian asked: "…The database, backups and colleagues can't read them; a hacked server could." / "Forgot it? It cannot be reset. Erase My storage and start again" — cost if wrong: copy edit
Task 8: Ruling: new backend setting LOGIN_RATE_LIMIT (default 10, unchanged) — found because the full e2e run registers >10 users a minute from one IP, the same thing an office does on launch day; e2e raises it; deploy README says to raise it for launch day — cost if wrong: none
Task 8: Ruling: My storage photo actions (.ph-act) show on hover/focus only and are hidden on touch (the tap opens the viewer) — extra.css, pinned by a test — cost if wrong: CSS tweak
Task 8: bundle: see npm run build in the final check
Task 8: complete (commits 48434d2..6286053, tests: bash -c 'cd backend && uv run pytest -q && cd ../frontend && npx vitest run && npx tsc -b --noEmit' →              learn more: https://vitest.dev/guide/improving-performance#test-environments)
Final review: opus reviewer, "ready with fixes": 0 Critical, 6 Important, 7 Minor. Re-graded by effect: all 6 Important stand.
Final: fixed #1 running uploads undercounted — test_running_upload_counts_its_full_size RED→GREEN
Final: fixed #2 [Cancel it] could kill a slow live upload — HELD_IDLE 2 min + chunk start = activity + upload locks; test_release_held_spares_a_slow_chunk, test_chunk_start_counts_as_activity RED→GREEN (test_release_held_spares_active_upload moved to 3 min)
Final: fixed #3 pagehide locked every tab — store test "closing one tab locks only that tab" RED→GREEN
Final: fixed #4 photo meta over the 64 KiB allowance — THUMB_MAX 34 KiB; test "largest thumbnail fits" fails at 60 KiB (mutation checked), passes at 34
Final: fixed #5 lock during encryption → unhandled rejection — vaultFiles test RED→GREEN
Final: fixed #6 erase on another device left the tab open — store tests (status wipe, 404 not_initialized → KeyChanged + setup) RED→GREEN
Final: fixed minor 1 (attach uses the job's keyGen), minor 2 (key check + erase under QUOTA_LOCK), minor 4 (damaged key / file messages, VaultView test RED→GREEN) — suites: backend all, frontend 325/325, e2e 20/20
Final: minor (deferred): channel messages carry keyGen only on "unlocked"; "erased" doesn't cancel this tab's vault jobs (they fail as rejected)
Final: minor (deferred): meta AAD not bound to the item id (a DB editor could swap/roll back meta between the user's own items; nothing readable)
Final: minor (deferred): KeyChanged closes the form without a message
Final: minor (deferred): heldKeyForTest/forceStatusForTest/forcePatchForTest ship in the production store (test hooks; heldKeyForTest returns the in-memory CryptoKey reference)
Final: Ruling: the second Save after "Changed in another tab — reloaded." overwrites on purpose without showing the other tab's text — accepted by the reviewer as defensible — cost if wrong: a deliberate overwrite of a newer note
