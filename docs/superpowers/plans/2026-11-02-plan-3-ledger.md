# SDD ledger — plan: docs/superpowers/plans/2026-11-02-plan-3-frontend.md
Spec + design (mockup.html, states.html) + roadmap read. Executor: inline. Base: 92f2c39 (plan commit; scaffolding started before it was committed, not yet committed).
Stack installed 2026-11-02: react 19.3.1, vite 8.3.5, vitest 5.0.5, typescript 7.0.2, @testing-library/react 16.3.3, jsdom; oxlint from the template.
## Pre-flight
- T6 Uploader consumes T2 api + T5 clientKey/SpeedMeter: names fixed in the plan. OK.
- T8 useEvents leader election (BroadcastChannel) is self-contained. OK.
- Ruling: the reviewer's suggestion to change the commit trailer to "Claude Sonnet 5.5" is rejected — it reflected the subagent's model; the session's attribution rule (Opus 5.5) stands — cost if wrong: none.
Task 1: complete (commits 92f2c39..6c12aa7, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →    Duration  145ms (setup 79%, transform 8%, tests 6%, worker 4%, import 4%))
Task 1: Ruling: tests excluded from tsconfig.app.json and checked by a new tsconfig.test.json (node types); __dirname → import.meta.dirname — keeps node types out of app code — cost if wrong: one config file
Task 2: Ruling: fs:signed-out fires only on 401 with detail not_signed_in, not every 401 — login and password change answer 401 bad_credentials, which must not sign the user out — cost if wrong: a dead session goes unnoticed until the next call (every guarded route answers not_signed_in)
Task 2: Ruling: added UploadStatus type (GET /api/uploads/{id}) — Task 6 needs it for the 409 already_complete row — cost if wrong: none
Task 2: complete (commits 6c12aa7..4a47936, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →    Duration  518ms (environment 59%, tests 26%, setup 11%, import 2%, transform 1%, worker 1%))
Task 3: Ruling: added sentences not in states.html — reserved → "This address can't be registered.", network failure → "Can't reach the server. Check your connection.", other → "Something went wrong. Try again." — the brief lists only 3 codes; a silent failure is worse — cost if wrong: copy edits
Task 3: Ruling: a wrong-domain paste keeps the full text in the field (states.html §8 shows "tanvir@gmail.com" with the error) and blocks submit — matches the design — cost if wrong: none
Task 3: Ruling: test setup calls cleanup() after each test — Vitest globals are off, so Testing Library doesn't auto-clean — cost if wrong: none
Task 3: complete (commits 4a47936..b001544, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →    Duration  642ms (environment 50%, tests 35%, setup 12%, import 1%, transform 1%, worker 1%))
Task 4: Ruling: same_as_shared → "Choose a password that is not the shared starting password." (states.html §9 has no sentence for it) — cost if wrong: copy edit
Task 4: Ruling: the global account's drawer shows the muted note with the heading "Signed in as the global account" (the mockup's "…?" question form was written for the regular-user preview) and no password/storage forms — brief: note only for global — cost if wrong: copy edit
Task 4: Ruling: the nudge renders inside the Sharing view only (mockup puts it inside #view-sharing) — cost if wrong: nudge not visible on My storage
Task 4: Ruling: supportsFolderPick() lives in src/lib/device.ts now; the Folder-tab fallback message is wired in Task 7 (composer) — the phone addition is listed under Task 4 but the Folder tab is Task 7 — cost if wrong: none
Task 4: complete (commits b001544..da2f5e7, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →    Duration  1.23s (environment 54%, tests 33%, setup 10%, import 1%, transform 1%))
Task 5: Ruling: formatBytes(n) uses one trimmed decimal ("1.8 GB", "10 GB", "200 MB" — what the mockup lists show); formatBytes(n, 2[, unit]) gives the fixed progress form ("1.80 GB", "0.76 GB") — the brief's two examples come from different places in the design — cost if wrong: copy edits
Task 5: Ruling: relativeTime adds "just now" (< 1 min, also for future skew), "yesterday" (mockup meta) and "Oct 12, 2025" for other years; expiresSoon adds "expires today" (< 1 day) and singular "1 day" — cost if wrong: copy edits
Task 5: Ruling: clientKey takes the whole File (it needs webkitRelativePath and the 64 KiB edges per the corner-case additions), not {name,size,lastModified} — the binding additions extend the brief — cost if wrong: none
Task 5: complete (commits da2f5e7..7037c34, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →    Duration  1.28s (environment 59%, tests 26%, setup 12%, import 2%, transform 1%, worker 1%))
Task 6: Ruling: api.put uses XMLHttpRequest instead of fetch — fetch can't report upload progress, and the design needs live % and speed (16 MiB chunks × 4 would freeze the bar for seconds) — it still sends X-Requested-With: fs (client tests) — cost if wrong: none known; the CSRF-across-a-full-upload test (Security additions) will cover XHR too in Task 8
Task 6: Ruling: Job gains `canRetry` and `files` ({total, done, failed[]}), and reasons `file_changed`/`not_found`/`interrupted`/`rejected` beyond the brief — the binding corner-case table needs them — cost if wrong: none
Task 6: Ruling: Retry is offered for network/not_found only; too_large/disk_full/upload_quota/file_changed show only ✕ (states.html §5 shows no Retry on "Too large"/"Server full") — cost if wrong: the user re-picks the file
Task 6: Ruling: a folder with transient failures stays "failed · Retry" (same batch) instead of completing; it completes once only permanent failures remain, ending "Done · N failed"; Retry there sends those files as a new folder — "batch complete failed[]" row of the table — cost if wrong: a second folder item for retried files
Task 6: Ruling: folder small files (≤ 1 chunk) run first 6 at a time, then big files 2 at a time × 4 chunks — the addition gives both limits, not whether they overlap; sequential keeps connections ≤ 8 — cost if wrong: slightly slower mixed folders
Task 6: Ruling: client pre-checks 10 GiB per folder file (the server's default, the design's "up to 10 GB") so one huge file doesn't 413 a whole 500-file group — the server stays the authority (a 413 still isolates per file) — cost if wrong: if the owner raises MAX_FILE_SIZE, folder files above 10 GiB are refused client-side until this constant changes
Task 6: Ruling: cancel DELETEs every unfinished upload of the job (6 at a time) — frees the 20 GiB reservation now instead of after the 24 h sweep — cost if wrong: extra requests on cancel
Task 6: Ruling: useSession.refresh fires `fs:signed-in`; the engine resumes on it — brief: "after sign-in, continue" — cost if wrong: none
Task 6: Ruling: folder file keys use the full clientKey (64 KiB head + tail per file) as the additions say; 5,000 files read ≤ 640 MB of edges — cost if wrong: a slower start on huge folders (measure in Task 9 e2e)
Task 6: complete (commits 7037c34..46094f6, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →    Duration  1.31s (environment 49%, tests 36%, setup 11%, import 2%, transform 1%, worker 1%))
Task 7: Ruling: picked files/folders are staged in the card as "Ready" rows (✕ to remove) and handed to the engine on Send — the brief says Send is disabled until there are recipients and content; the design has no staged-row state, so staged rows reuse .q with "Ready"/"Ready to send" — cost if wrong: one extra click per send
Task 7: Ruling: recipient initials are the first two letters (same rule as the header avatar); the mockup's "TS" for tasnim is illustrative — cost if wrong: copy edit
Task 7: Ruling: the upload queue shows under the Files and Folder tabs (where the mockup has it), not under Text — cost if wrong: progress hidden while on Text
Task 7: Ruling: queue sentences not in states.html §5 — paused signed_out "Signed out. It continues after you sign in again", upload_quota "Too many uploads"/"You have too many unfinished uploads. Let some finish, then try again", not_found "The server lost this upload. Retry starts it again", rejected "The server refused this file", queued "Waiting"; folder failed files expand under a chevron as extra q-sub lines — cost if wrong: copy/markup edits
Task 7: Ruling: dropped folders are read through webkitGetAsEntry (src/lib/dropped.ts) so "Drop a folder here" is true; each file gets webkitRelativePath — cost if wrong: none
Task 7: Ruling: the auto-delete notice is rendered in App's Sharing view with the send card — design checklist item — cost if wrong: none
Task 7: complete (commits 46094f6..ba0b29f, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit' →              at least ~342ms faster with isolate: false — reuses workers across files instead of one per file)
Task 8: Ruling: backend SSE heartbeat changed from the comment ": ping" to "event: ping" (commit 35e671e, backend test first) — EventSource never exposes comments, so the binding 60 s watchdog could not see pings and would reconnect healthy streams — cost if wrong: none (one frame format; README + roadmap updated)
Task 8: Ruling: the global account's Lists show only the Global pane (no Private/Global switch) — the backend never gives it private items; an always-empty Private tab would mislead — cost if wrong: one switch to add back
Task 8: Ruling: file cards show size but no time; text cards show the time; folders show file count + size — exactly the mockup's meta lines — cost if wrong: copy edits
Task 8: Ruling: a deleted-elsewhere item beyond page 1 can linger until the next full load; refetch keeps older loaded pages when page 1 has more — a 404 on any action removes it quietly — cost if wrong: a stale card that disappears on click
Task 8: Ruling: Download first GETs the item (cheap metadata) and only then starts the file download, so a deleted item drops its card instead of opening an error page — the binding addition "a 404 on download removes the card quietly" — cost if wrong: one extra small request per download
Task 8: Ruling: photo thumbnails load the full image (lazy) — the backend has no thumbnail endpoint — cost if wrong: bandwidth on photo-heavy lists (candidate for a backend thumbnail route later)
Task 8: Ruling: video plays inline under the card after a "Play" chevron (no design for it; brief says inline <video controls>) — cost if wrong: markup edit
Task 8: Ruling: the lightbox and toast stack need fixed positioning the gallery (states.html) doesn't show: the lightbox sits in the existing .overlay (centred, image max-height 78vh, contain), toasts are a fixed stack at the bottom centre; both inline styles — cost if wrong: layout tweaks
Task 8: Ruling: created toasts: private "rahim sent you "x"", global "rahim shared "x" with everyone"; one toast per item id (events can repeat after reconnects); expiry (by null) gives no toast — cost if wrong: copy edits
Task 8: Ruling: folder entries show the first 12 then a clickable "+N more" (the mockup's span) — cost if wrong: none
Task 8: Ruling: extra.css adds only (hover: none) .opens always visible + no hover peek on touch, and focus-visible outlines for the clickable drop zone and "+N more"; a test pins its selectors — cost if wrong: none
Task 8: Ruling: oxlint now runs the react plugin with react/no-danger as an error (proved on a planted violation); its other warnings were fixed (useEffectEvent instead of render-time ref writes, lazy useState for bubbles); one set-state-in-effect false positive (state set after await) is disabled on its line with a reason — cost if wrong: none
Task 8: Ruling: an ended session keeps the page mounted under ReSignIn (states.html §5) using useSession().lost; Log out clears it; the profile drawer is closed while signed out — cost if wrong: none
Task 8: complete (commits ba0b29f..5164ce1, tests: bash -c 'cd frontend && npx vitest run && npx tsc -b --noEmit && npx oxlint' →              learn more: https://vitest.dev/guide/improving-performance#test-environments)
Task 9: Ruling: Inter is self-hosted from Google's own files (latin + latin-ext woff2, OFL.txt alongside) and index.html no longer calls Google Fonts — the binding Task 9 addition; parity tests route the mockup's Google Fonts URL to the same files — cost if wrong: none
Task 9: Ruling: parity flattens the fixed .bg gradient to one colour in both pages and enlarges the viewport to the element before capture — tall captures are stitched from tiles and a fixed background breaks between them; app.css is pinned verbatim by design.test.ts — cost if wrong: gradient drift would go unnoticed by parity (it is CSS copied from the mockup)
Task 9: Ruling: drawer parity compares only the head + login-password section — the storage section differs on purpose before plan 4 (states.html §9 "Set up My storage") and the global note is shown only to the global account — cost if wrong: none
Task 9: Ruling: time is fixed with page.clock (NOW 2026-11-02 16:30 Asia/Dhaka) instead of masking [data-time] nodes, so "2 min ago"/"yesterday" render exactly like the mockup — cost if wrong: none
Task 9: Ruling: backend SERVE_FILES setting (default false) added so dev and e2e can download without nginx; documented in roadmap + deploy README — e2e found 0-byte downloads — cost if wrong: if set true in production, nginx sendfile is bypassed (slower, still correct)
Task 9: Ruling: e2e found a real bug — items sent in the ~0.5 s before the first stream open were never shown; the first open now refetches both lists immediately (unit tests first) — cost if wrong: none
Task 9: Ruling: e2e/ is type-checked by Playwright's own compiler, not tsc -b — cost if wrong: type errors surface at test run
Task 9: complete (commits 5164ce1..e2fdb0d, tests: bash -c 'cd frontend && npx playwright test' →   11 passed (17.7s))
Task 10: bundle: index.js 284.37 kB (gzip 88.00 kB), css 25.00 kB (gzip 5.92 kB), index.html 6.79 kB
Task 10: complete (commits e2fdb0d..dd0cae7, tests: bash -c 'cd backend && uv run pytest -q && cd ../frontend && npx vitest run && npx tsc -b --noEmit' →              learn more: https://vitest.dev/guide/improving-performance#test-environments)
Final review: opus reviewer, verdict "ready with fixes": 1 Critical, 7 Important, 13 Minor. Re-graded by effect: all 8 stand.
Final: fixed #1 logout/next user sends previous user's files — Uploader.review "signing in as someone else drops…", "cancelAll…", "saved jobs come back only for the owner", App "Log out with uploads running asks first…", session "says who signed in" RED→GREEN, suite 202/202
Final: fixed #2 reservation left after cancel mid-request / no-Retry failure / dismiss — 3 tests RED→GREEN, suite 202/202
Final: fixed #3 folder over 20 GiB never sends (lazy registration by groupBytes 4 GiB) — "registers files a few at a time" RED→GREEN, suite 202/202
Final: fixed #4 replaced batch loses finished files — "files finished in the lost batch are sent again" RED→GREEN (vacuous before groupFiles existed, then meaningful), suite 202/202
Final: fixed #5 re-pick after reload duplicates the item (file: verify saved id; folder: batch_closed → complete) — 2 tests RED→GREEN, suite 202/202
Final: fixed #6 fs.pending shared across tabs (now fs.pending:<tab>:<user> + 5 s heartbeat, take over after 15 s) — 2 tests, suite 202/202
Final: fixed #7 refetch drops live inserts — useItems "a live item that arrives while page 1 is being refetched is kept" RED→GREEN, suite 202/202
Final: fixed #8 stalled PUT hangs forever (60 s no-progress abort → retry) + JSON AbortSignal.timeout(120 s) — 2 tests RED→GREEN, suite 202/202; e2e 11/11
Final: fixed (minor, done during the pass): Retry after not_found keeps the dead upload id — review test "does not keep using the dead upload id" (fails without the fix, checked), suite 203/203
Final: minor (deferred): a signed-out leader tab keeps beating, so re-signing in a follower tab leaves live events down until the leader tab signs in
Final: minor (deferred): hidden leader tab throttled to 1 beat/min → leader flapping, a refetch per minute
Final: minor (deferred): linkify lookbehind regex breaks Safari < 16.4 (blank page on iOS 15/16.0-16.3)
Final: minor (deferred): ReSignIn overlay hides Log out ("sign in as someone else" link missing)
Final: minor (deferred): cancel during complete still creates the item
Final: minor (deferred): per-event work — sent() over 5,000 tasks per progress event, localStorage write per finished folder file, linkify of 1 MiB on each Lists render (useMemo), TextForm encodes 1 MiB per keystroke
Final: minor (deferred): upload queue hidden on the Text tab (Interrupted rows after a reload not visible until Files)
Final: minor (deferred): no client message for folders over 5,000 files; empty folder dropped silently (spec: "with a note")
Final: minor (deferred): refetchSoon still fetches the private section for the global account
Final: minor (deferred): parity at 390 px covers Sharing/Private only
Final: Ruling: reviewer's "declined to judge" items (parity numbers, SERVE_FILES under nginx, PDF unsandboxed, full-image thumbnails, vault UI) — parity was run here (11/11); the rest are plan 4/5 or recorded rulings — cost if wrong: none new
After review (owner: "solve the issues", 2026-11-02): fixed deferred minors with tests first —
- linkify lookbehind (blank page on Safari < 16.4) → capture group; test: no regex lookbehind anywhere in src
- signed-out leader tab: sign-in in any tab is shared over the channel and reopens the stream; test with two fake tabs
- ReSignIn covered Log out → "Sign in as someone else" (logs out; the engine drops the old user's jobs on the next user's sign-in); ReSignIn + App tests
- upload queue now also under the Text tab (ruling 38 reversed): Interrupted rows visible after a reload; SendCard test
- folder over 5,000 files / empty folder → clear message, nothing sent; SendCard test
- global account never fetches the private list (also on reconnects); Lists test
Owner: "solve everything" (2026-11-02): the last four fixed, tests first —
- per-event work: progress adds bytes once per 100 ms (not per XHR event over all files); saved jobs written only when they change (+ 5 s heartbeat); linkify memoized per text; the text counter avoids encoding/copying short texts (isTooLong replaces textBytes)
- hidden-leader flapping: the live leader is chosen with navigator.locks when available (held until the tab closes; no heartbeat to throttle); heartbeats remain the fallback
- cancel during complete: an item created after the cancel is deleted again (test proven to fail without the fix)
- parity at 390 px now also for Global (0.44 %) and Login (0.16 %)
Nothing from the review is deferred now.

