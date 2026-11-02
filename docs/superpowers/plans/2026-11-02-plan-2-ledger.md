# SDD ledger — plan: docs/superpowers/plans/2026-11-02-plan-2-transfers.md
Spec read (§3.4, §3.5, §3.8, §6.3–6.5). Executor: inline (executing-plans). Base: 2bf8dd1.
## Pre-flight (shared interfaces)
- T3 notify_created stub → T6 replaces it: same signature notify_created(app, item_id). OK.
- T2 UploadLocks used by T3 complete/cancel and T4 batch auto-complete: one app.state.upload_locks instance. OK.
- T4 batch files auto-complete inside the T2 chunk handler (needs storage move from T3): implement the move as transfers.finalize_file(upload, data_dir) in T3, reused by T4. Ruling: extract finalize_file in T3 — avoids duplicating fsync/rename — cost if wrong: none.
- T6 delete must compute the audience before deletion: items.delete_item (plan 1) gets modified in T6. OK.
Task 1: Ruling: 0002 adds updated_at nullable → backfills from created_at → sets NOT NULL; received_bytes server_default 0 — autogenerate's plain NOT NULL add fails on tables with rows (test_0002_upgrades_a_database_with_existing_uploads) — cost if wrong: none.
Task 1: complete (commits 2bf8dd1..91da13b, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 2: Ruling: POST /api/uploads refuses batch_id/relative_path (400 use_batch_files); folder files register only via POST /api/batches/{id}/files (task 4) — one path for folder files, avoids two resume rules — cost if wrong: roadmap row updated in task 7.
Task 2: Ruling: concurrency test widens the race between load and commit (slow utcnow), not the file write — the first version passed WITHOUT the lock (vacuous); verified now: no-lock → FAIL, lock → PASS — cost if wrong: none.
Task 2: Ruling: upload rows are not pre-created as files; pwrite creates the temp file (sparse holes) — no truncate(size), per review item 16 — cost if wrong: none.
Task 2: complete (commits 91da13b..441556c, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 3: Ruling: plan-1 test_cleanup_removes_stale_uploads_only updated to set updated_at — staleness is now idle time by design (review item 2) — cost if wrong: none.
Task 3: complete (commits 441556c..db4cc68, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 4: Ruling: added batches.failed_paths (JSON) to migration 0002 instead of a new 0003 — a retried batch complete must return the same failed list; 0002 has never run outside tests — cost if wrong: none pre-deploy.
Task 4: Ruling: folder item mime = "inode/directory" — never served (folders download as zip) — cost if wrong: none.
Task 4: Ruling: the whole registration call fails on the first bad path/size/duplicate (no partial registration) — the client fixes and resends — cost if wrong: one round trip.
Task 4: complete (commits db4cc68..4163e89, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 5: Ruling: zipstream-ng 1.9.3 (PyPI, 2026-08-20, LGPL-3.0-only) — named in spec §6.4; LGPL is fine for an internal, undistributed service that imports it — cost if wrong: swap for stdlib zipfile.
Task 5: Ruling: no Range on folder zips (single files inside resume via their own download) — cost if wrong: a dropped multi-GB zip restarts.
Task 5: Note: test_zip64_entry_over_4_gib writes a real 4 GiB temp file (~2.5 s on the Mac); mark slow if CI disk is small.
Task 5: complete (commits 4163e89..bfc1ad8, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 6: Ruling: notify_created(app, item_out, audience) takes the serialised item + audience (plan: notify_created(app, item_id)) — callers already hold both, and async callers must not do sync DB reads on the loop — cost if wrong: signature only.
Task 6: Ruling: run_cleanup(..., on_deleted=None) callback instead of importing the app into jobs — expiry runs in a thread without the app — cost if wrong: none.
Task 6: Ruling: endpoint streaming is verified live in task 7 (uvicorn + curl -N), unit tests drive event_stream directly; only the 401 check goes through TestClient — avoids hanging TestClient on an endless stream — cost if wrong: none.
Task 6: complete (commits bfc1ad8..4fa4467, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Task 7: e2e test passed at once (integration of existing behaviour). Live run 2026-11-02: 50 MiB, 4×16 MiB chunks (2 parallel), localhost 0.09 s, sha256 identical, retry complete 200, SSE created+deleted(by rahim) received with no-cache/no-transform + X-Accel-Buffering: no, 0 server errors.
Task 7: complete (commits 4fa4467..4ce6cbc, tests: bash -c 'cd backend && uv run pytest -q && uv run ruff check .' → All checks passed!)
Final review: model sonnet (opus hit the weekly limit mid-review; re-dispatched same brief) — 'With fixes', 0 Critical, 4 Important.
Final: fixed Important-1 short pwrite ignored (silent corruption) — test_short_pwrite_is_completed_not_ignored / test_pwrite_writing_nothing_is_disk_full RED→GREEN, suite 200/200
Final: fixed Important-2 batch complete raced a chunk in flight (500 + orphan) — test_batch_complete_waits_for_a_chunk_in_flight RED (chunk thread crashed) → GREEN; batch complete and file registration now hold the unfinished files' locks, suite 200/200
Final: fixed Important-3 retrying a folder registration after files finished gave 409 — test_retrying_registration_after_files_finished_is_not_a_conflict RED→GREEN; old test corrected to a real conflict (different file at a finished path), suite 200/200
Final: fixed Important-4 busy SSE streams skipped the session re-check — test_busy_stream_is_still_rechecked RED→GREEN, suite 200/200
Final: fixed (re-graded Minor→Important: data loss) chunks didn't keep a batch alive, so a slow file inside a folder could be cleaned up mid-transfer — test_chunks_keep_a_batch_alive RED→GREEN, suite 200/200
Final: minor (deferred): UploadLocks entries for batch files / batch-<id> / cleaned-up uploads are never dropped (slow memory growth)
Final: minor (deferred): drop() after cancel/complete can give a late request a fresh lock (DB re-check prevents harm)
Final: minor (deferred): quota/disk checks in start/register are check-then-act across concurrent sync requests (bounded overshoot)
Final: minor (deferred): resuming an upload doesn't touch updated_at (race with cleanup at the 24 h edge)
Final: minor (deferred): folder path collisions not detected: case-only duplicates, `a` vs `a/b`, trailing dots/spaces, Windows reserved names, no depth cap
Final: minor (deferred): folder_zip raises FileNotFoundError → 500 if a stored file vanished (e.g. expiry during download)
Final: minor (deferred): chunk PUT without Content-Length (chunked transfer encoding) gets 400; document for non-browser clients
Final: declined-to-judge noted: load behaviour at 20 users × parallel 16 MB chunks; real Cloudflare/nginx behaviour (plan 5); whether get_db pins a SQLite connection for the life of an SSE/zip response (check in plan 3/5)
