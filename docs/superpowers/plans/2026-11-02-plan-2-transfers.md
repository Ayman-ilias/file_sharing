# Plan 2: Transfers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Large files and folders reach the right people fast and reliably through Cloudflare: chunked, parallel, resumable uploads; folder batches; streaming zips; live updates.

**Architecture:**
- **Uploads:** an upload is an `uploads` row plus a temp file at `tmp/<ab>/<upload_id>`.
- **Chunks:** each chunk is at most `CHUNK_SIZE` (16 MiB). It's streamed from the request with a byte cap and written at its offset with `os.pwrite`, so chunks may arrive in parallel, out of order, or twice.
- **Locking:** one per-upload asyncio lock serialises the bookkeeping. Database work runs off the event loop.
- **Completion:** it fsyncs and renames the temp file to `files/<ab>/<upload_id>` (storage ID = upload ID). It's idempotent: a retry after a dropped connection gets the same item.
- **Folders:** a `batches` row, filled through bulk file registration, whose files complete themselves when their last chunk lands.
- **Live updates:** an in-process broker pushes Server-Sent Events only to users who can see the item.

**Tech Stack:** Plan 1's stack, plus `zipstream-ng` (named in spec §6.4) for streaming zips with a known length.

**Spec:** [docs/superpowers/specs/2026-11-01-file-sharing-v2-design.md](../specs/2026-11-01-file-sharing-v2-design.md) §3.4, §3.5, §3.8, §6.3–§6.5. **Contracts:** [roadmap](2026-11-01-file-sharing-v2-roadmap.md). **Binding plan-1 rulings:** [plan-1 ledger](2026-11-01-plan-1-ledger.md). **Corner-case review of this plan:** 2026-11-02, 5 critical + 9 important findings, all built in below.

## Global Constraints

- Plan 1's Global Constraints still hold (CSRF header, 404 `not_found` for outsiders, paths only from 32-hex IDs). An upload/batch ID that isn't 32-hex → 404 before any path is built.
- Settings: `CHUNK_SIZE` = 16777216, `MAX_FILE_SIZE` = 10737418240, `DISK_MARGIN` = 2147483648, `MAX_BATCH_FILES` = 5000.
- New settings: `MAX_USER_RESERVED` = 21474836480 (20 GiB of unsent bytes per user), `MAX_USER_UPLOADS` = 20 (unfinished non-batch uploads per user), `MAX_STREAMS_PER_USER` = 10, `STALE_AFTER_HOURS` = 24 (idle time, measured from `updated_at`).
- Plan 2 accepts `target: "share"` only. `"vault"` → 400 `bad_target` until plan 4.
- **Resume rule:** resume only when the same user, `client_key`, `size`, sorted de-duplicated `recipient_ids` (always `[]` when `is_global`), `is_global` and `batch_id` all match, and the row has been idle less than `STALE_AFTER_HOURS`. The resumed row's **own** `chunk_size` is returned.
- **Refuse before bytes:**
  - size > `MAX_FILE_SIZE` → 413 `too_large`;
  - `free_bytes − reserved_bytes − size < DISK_MARGIN` → 507 `disk_full`;
  - the user's unsent bytes + size > `MAX_USER_RESERVED`, or more than `MAX_USER_UPLOADS` unfinished uploads → 429 `upload_quota`;
  - `reserved_bytes` = SQL `SUM(size − received_bytes)` over unfinished uploads;
  - `ENOSPC` while writing → 507 `disk_full`, and the chunk is not marked.
- **Chunk body:** the `Content-Length` must equal `chunk_len(n)`, else 400 `bad_chunk_size`. The body is read from `request.stream()` with a running cap; one byte over → 400. Never `await request.body()`.
- Zero-byte files: 0 chunks; they complete at once.
- **Names and paths:**
  - Unicode NFC.
  - Control characters and bidi overrides (U+202A–U+202E, U+2066–U+2069) are removed.
  - Paths use `/`, with each segment at most 255 UTF-8 bytes.
  - Empty, `.` or `..` segments, a leading `/`, a drive letter or a backslash → 400 `bad_path`.
  - `mime` must match `^[\w.+-]+/[\w.+-]+$` (≤ 255 characters), else it's stored as `application/octet-stream`.
- **Live events:**
  - `item.created` `{item}` and `item.deleted` `{id, by}`, where `by` is null for expiry. Each event goes only to users who can see the item.
  - Heartbeat `: ping` every 25 s. Every heartbeat re-checks the session, and the stream ends if it is gone or disabled.
  - At most `MAX_STREAMS_PER_USER` streams per user (the oldest is closed). Each subscriber queue is bounded at 100; on overflow the subscriber is dropped (the client reconnects and refetches).
  - Headers: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
- Commit after each task with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, on `feature/v2` only, never push.

## Review Focus

1. **The same file re-sent to different people** must be a new upload that reaches only the new people. Test in task 2.
2. **A retried `complete` after a dropped connection** must return the same item, not an error and not a duplicate. Tests in tasks 3 and 4.
3. **Chunks arriving twice, out of order, or concurrently with cancel or complete** must give a byte-identical file, or a clean 404/409, never a 500. Tests in tasks 2 and 3.
4. **A nearly full disk, a disk filling mid-upload, or one user hoarding space** must be refused before bytes (507/429), and ENOSPC must give 507. Test in task 2.
5. **Hostile or odd folder paths** (`../x`, `a//b`, `C:\x`, a U+202E name, NFD Bangla, duplicates) must be refused or normalised, and the zip must carry UTF-8 names and an exact `Content-Length`. Tests in tasks 4 and 5.

---

### Task 1: Migration: batches, upload bookkeeping

**Files:** modify `backend/app/models.py` and `backend/app/config.py` (new settings); create `backend/migrations/versions/0002_transfers.py`; update the roadmap Tables; test in `backend/tests/test_db.py`.

**Interfaces:**
- Produces:
  - `Batch` with: `id` (32-hex pk), `user_id` (FK, cascade), `name`, `file_count`, `recipient_ids` (JSON, sorted), `is_global`, `created_at`, `updated_at`, `completed_at?`, `item_id?`.
  - `Upload` gains `received_bytes` (BigInteger, 0), `updated_at` (UTCDateTime), `item_id?` (str 32) and `storage_id?` (str 32).
  - Settings `max_user_reserved`, `max_user_uploads`, `max_streams_per_user`, `stale_after_hours`.
- [ ] **Step 1: Write the failing test** `test_transfer_columns_exist` (`batches` table; `uploads` has `received_bytes`, `updated_at`, `item_id`, `storage_id`). **Step 2: Run** `uv run pytest tests/test_db.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Autogenerate `0002` against a temp DB and review it by hand. Existing rows get `updated_at = created_at`.
- [ ] **Step 4: Run** `uv run pytest -q && uv run ruff check .`. Expected: PASS. **Step 5: Commit** `feat(backend): batches and upload bookkeeping columns`.

### Task 2: Start, resume and send chunks

**Files:** create `backend/app/transfers.py`, `backend/app/routers/uploads.py`, `backend/tests/test_uploads.py`; modify `main.py` (router; ensure the `tmp/` and `files/` shard folders are created on write) and `tests/conftest.py`.

**Interfaces:**
- Consumes: `resolve_recipients`, `nfc` (items.py), `storage_path`, `free_bytes`, `current_user`.
- Produces (`transfers.py`):
  - `num_chunks(size, chunk_size) -> int` (ceil; 0 for 0) and `chunk_len(size, chunk_size, n) -> int`
  - `clean_name(raw) -> str` and `clean_relative_path(raw) -> str` (both raise `ValueError("bad_path")`), and `clean_mime(raw) -> str`
  - `reserved_bytes(db, user_id: int | None = None) -> int` (SQL SUM)
  - `recipient_key(ids, is_global) -> list[int]`
  - `async read_capped(request, limit) -> bytes`
  - `write_chunk(path, offset, data)` (`os.open(O_RDWR|O_CREAT)` + `os.pwrite`; maps ENOSPC to `DiskFull`)
  - `UploadLocks` (`get(id) -> asyncio.Lock`, `drop(id)`)
- Produces (`uploads.py`):
  - `POST /api/uploads` `UploadIn {client_key (1–128, [A-Za-z0-9._:-]), name, size ≥ 0, mime, recipient_ids, is_global, target, batch_id?, relative_path?}` → 201 `{upload_id, chunk_size, received}`, or 200 when resuming.
  - `PUT /api/uploads/{id}/chunks/{n}` → 204.
  - `GET /api/uploads/{id}` → `{received, size, chunk_size, completed, item_id}`.
  - `DELETE /api/uploads/{id}` → 204.
  - Chunk handler order: validate `n` and Content-Length → `read_capped` → under the upload's lock: re-load the row in a thread (missing → 404, completed → 409 `already_complete`) → write in a thread → set `received` to a **new** sorted list, add the bytes to `received_bytes`, touch `updated_at`, commit (in a thread).
  - Cancel takes the same lock, deletes the row and the temp file, and drops the lock.
- Fixtures: `chunk4` (`CHUNK_SIZE=4`), `put_chunk(c, upload_id, n, data)`, `upload(c, data, **fields) -> dict`.
- [ ] **Step 1: Write the failing tests:**

```python
def test_out_of_order_and_repeated_chunks_give_identical_bytes(chunk4, ...): ...   # 10 bytes; n=2, 0, 0, 1 → sha256(tmp) == sha256(data); received == [0, 1, 2]; received_bytes == 10
async def test_concurrent_chunks_never_lose_received_entries(chunk4, app, ...): ...
    # drive the chunk handler for n=0..2 with asyncio.gather + a forced await between write and mark;
    # assert received == [0, 1, 2]; and the test FAILS when UploadLocks is replaced by a no-op (verify once, note in ledger)
def test_received_list_persists(chunk4, ...): ...   # new DB session sees the marked chunks (guards the JSON-mutation bug)
def test_resume_returns_received_and_rows_own_chunk_size(chunk4, ...): ...
def test_same_file_new_recipients_is_a_new_upload(chunk4, ...): ...
def test_resume_needs_same_size_and_same_user(chunk4, ...): ...
def test_duplicate_and_unordered_recipient_ids_resume(chunk4, ...): ...   # [r, n, r] then [n, r] → same upload
def test_too_large_refused_before_bytes(...): ...   # 413, no tmp file
def test_disk_full_and_reservation_shrinks(..., monkeypatch): ...   # second init 507; after the first upload's chunks arrive, the same init succeeds
def test_per_user_upload_quota(..., monkeypatch): ...   # MAX_USER_UPLOADS=2 → third init 429 upload_quota
def test_enospc_maps_to_507_and_chunk_not_marked(chunk4, ..., monkeypatch): ...
def test_wrong_content_length_and_oversized_body_rejected(chunk4, ...): ...   # header ≠ chunk_len → 400; a streamed body longer than declared → 400, nothing written past the offset
def test_bad_chunk_numbers(chunk4, ...): ...
def test_chunk_after_cancel_is_404_not_500(chunk4, ...): ...
def test_other_user_cannot_touch_my_upload(chunk4, ...): ...   # PUT/GET/DELETE/complete → 404
def test_non_hex_upload_id_is_404(...): ...
def test_vault_target_not_yet_supported(...): ...
def test_global_account_may_only_upload_global(...): ...
def test_signed_out_mid_upload_then_resume(chunk4, ...): ...
def test_clean_name_path_and_mime(): ...
    # "../x" "/x" "a//b" "a/./b" "C:\\x" "" → bad_path; "a\u202Eexe.txt" → "aexe.txt"; NFD → NFC; a 300-byte segment → bad_path; mime "text/html; x" → octet-stream
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `uv run pytest -q && uv run ruff check .`. Expected: PASS. **Step 5: Commit** `feat(backend): chunked, parallel, resumable uploads`.

### Task 3: Complete an upload (idempotent)

**Files:** modify `uploads.py`, `test_uploads.py`; add an orphan sweep to `backend/app/jobs.py`.

**Interfaces:**
- Produces:
  - `POST /api/uploads/{id}/complete`, under the upload's lock:
    - missing chunks → 409 `{detail: "missing_chunks", missing}`;
    - already completed → **200 with the same `Item`** (from `item_id`);
    - otherwise: check `st_size == size` (truncate if longer), fsync, `os.replace` to `storage_path(files, upload_id)`, create the `Item` (`storage_id = upload_id`), set `completed_at` and `item_id`, commit, drop the lock, `notify_created` → 201 `Item`.
    - If the temp file is gone but `files/<id>` exists (a crash between rename and commit), finish from there.
  - `notify_created(app, item_id)` is a no-op stub until task 6.
  - `run_cleanup` also removes, after `STALE_AFTER_HOURS`:
    - idle unfinished uploads (by `updated_at`);
    - files in `tmp/` and `files/` that no `uploads`, `items` or `folder_entries` row references.
- [ ] **Step 1: Write the failing tests:**

```python
def test_complete_creates_item_and_bytes_match(chunk4, ...): ...   # inode of the tmp file == inode of the stored file (no copy)
def test_complete_retry_returns_same_item(chunk4, ...): ...   # second complete → 200, same id, still one item
def test_crash_between_rename_and_commit_recovers(chunk4, ..., monkeypatch): ...   # make the commit raise once after os.replace → retry complete → 201 item
def test_zero_byte_file(...): ...
def test_one_byte_over_a_chunk(chunk4, ...): ...   # 5 bytes / chunk 4
def test_missing_chunks_reported(chunk4, ...): ...
def test_complete_races_a_late_chunk(chunk4, ...): ...   # chunk arriving after complete → 409 already_complete
def test_idle_upload_survives_overnight_if_touched(chunk4, ..., db_session): ...   # created 30 h ago, updated 1 h ago → kept; idle 25 h → removed
def test_orphan_sweep(app_settings, db_session): ...   # tmp and files entries without rows and older than 24 h are removed; referenced ones stay
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `feat(backend): idempotent upload completion and orphan sweep`.

### Task 4: Folder batches with bulk registration

**Files:** create `backend/app/routers/batches.py`, `backend/tests/test_batches.py`; modify `main.py`, `uploads.py` (auto-complete of batch files) and `jobs.py`.

**Interfaces:**
- Produces:
  - `POST /api/batches {name, file_count, recipient_ids, is_global}` → 201 `{batch_id}`. `file_count` must be 1–`MAX_BATCH_FILES` (else 400 `empty` / `too_many_files`). Same recipient rules as text.
  - `POST /api/batches/{id}/files {files: [{relative_path, size, mime, client_key}]}` (≤ 500 per call) → 201 `{uploads: [{relative_path, upload_id, chunk_size, received}]}`:
    - it resumes matching unfinished rows;
    - a path already **completed** in this batch → 409 `duplicate_path`, and an unfinished row for the same path with a different `client_key` is replaced;
    - registering beyond `file_count` → 409 `batch_full`;
    - a closed batch → 409 `batch_closed`.
  - Batch files complete themselves when their last chunk lands: they set `storage_id = upload_id` and `completed_at`.
  - `POST /api/batches/{id}/complete` → 201 `{item, failed: [relative_path]}`:
    - one folder `Item`, plus one `FolderEntry` per completed file;
    - unfinished files are deleted and listed in `failed`;
    - 0 completed → 400 `empty_batch`;
    - a repeat call → **200 with the same item and failed list**.
  - All batch writes take a per-batch lock.
  - `run_cleanup`: a batch idle for `STALE_AFTER_HOURS` and not completed loses its uploads, their temp files and the `files/` of its completed files.
- [ ] **Step 1: Write the failing tests:**

```python
def test_folder_round_trip(chunk4, ...): ...   # bulk-register 3 files incl. "config/gw.json"; send chunks; complete; entries download their own bytes
def test_batch_files_auto_complete(chunk4, ...): ...
def test_partial_batch_reports_failed(chunk4, ...): ...
def test_batch_complete_retry_returns_same_item(chunk4, ...): ...
def test_duplicate_completed_path_and_replaced_unfinished(chunk4, ...): ...
def test_batch_full_and_closed(chunk4, ...): ...
def test_batch_limits(...): ...
def test_bad_and_hostile_paths(chunk4, ...): ...   # "../x", "/etc/x", "a//b", "C:\\x" → bad_path; "a\u202Eb" cleaned
def test_nfd_paths_stored_nfc(chunk4, ...): ...
def test_another_users_batch_is_404_everywhere(chunk4, ...): ...   # register files, complete, init with batch_id
def test_stale_batch_cleanup_removes_completed_files_too(...): ...
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `feat(backend): folder batches with bulk registration`.

### Task 5: Streaming zip with an exact length

**Files:** `uv add zipstream-ng`; modify `backend/app/routers/items.py` and `transfers.py` (`folder_zip(item, data_dir) -> ZipStream`); test in `backend/tests/test_zip.py`.

**Interfaces:**
- Produces: `GET /api/items/{id}/zip` → `StreamingResponse(application/zip)` with:
  - `Content-Length` = `len(zipstream)` (stored entries, Zip64 when needed);
  - `Content-Disposition: attachment; filename*=UTF-8''<name>.zip`;
  - `Cache-Control: private, no-store`.
- Range on zips is not supported. **Ruling:** whole folders restart; single files inside a folder resume via their own download.
- Not a folder → 400 `not_a_folder`. An outsider → 404.
- [ ] **Step 1: Write the failing tests:**

```python
def test_zip_names_bytes_and_utf8_flag(...): ...   # "app.hex", "কনফিগ/gw.json": namelist, bytes, flag_bits & 0x800
def test_zip_content_length_is_exact(...): ...   # int(headers["content-length"]) == len(resp.content)
def test_zip_streams_in_small_pieces(...): ...   # each yielded piece ≤ 1.1 MiB for a 3 MiB folder
def test_zip64_entry_over_4_gib(...): ...   # sparse 4 GiB + 1 file: ZipStream length computed and the central directory is readable (stream to a temp file, then open it with zipfile)
def test_zip_outsider_404_and_text_400(...): ...
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `feat(backend): streaming folder zips with exact length`.

### Task 6: Live events (SSE)

**Files:** create `backend/app/events.py`, `backend/app/routers/events.py`, `backend/tests/test_events.py`; modify `uploads.py`, `batches.py`, `items.py` (text create, delete), `jobs.py` (expiry, from a thread), `main.py`.

**Interfaces:**
- Produces:
  - `Broker(max_streams_per_user, queue_size=100)` with:
    - `subscribe(user_id, is_global_account) -> Subscription`, closing the user's oldest stream above the cap;
    - `unsubscribe(sub)`;
    - `publish(event, payload, audience)`, which is thread-safe (`loop.call_soon_threadsafe`), and on a full queue marks the subscriber dropped.
  - `Audience(everyone: bool, user_ids: frozenset[int])` and `audience_for(item, recipient_ids) -> Audience`.
  - `notify_created(app, item_id)` and `notify_deleted(app, item_id, audience, by)`.
  - `event_stream(sub, still_allowed: Callable[[], Awaitable[bool]], heartbeat_s=25) -> AsyncIterator[str]`:
    - first yields `"retry: 3000\n\n"`;
    - then `"event: <name>\ndata: <json>\n\n"` frames;
    - on each heartbeat, calls `still_allowed()` (session valid, user enabled) and ends if false, else yields `": ping\n\n"`;
    - ends when the subscription is dropped.
  - `GET /api/events`. Delete computes the audience **before** deleting.
- [ ] **Step 1: Write the failing tests:**

```python
async def test_created_event_reaches_only_people_who_can_see_it(): ...
async def test_global_event_reaches_everyone_including_global_account(): ...
async def test_stream_frames_heartbeat_and_end_on_revoked_session(): ...   # still_allowed returns False on the 2nd heartbeat → stream ends
async def test_stream_cap_closes_oldest(): ...
async def test_slow_subscriber_is_dropped_not_blocking(): ...   # 101 events without reading → dropped; other subscribers unaffected
async def test_publish_from_another_thread(): ...
def test_delete_and_expiry_publish_deleted_with_by(...): ...
def test_upload_and_batch_completion_publish_created(...): ...
def test_events_endpoint_needs_session(raw_client): ...
```

  If `TestClient` can't close the endless stream cleanly, test `event_stream` directly, keep the 401 endpoint check, and record a ruling.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement.** **Step 4: Run.** Expected: PASS. **Step 5: Commit** `feat(backend): live events over SSE`.

### Task 7: End-to-end transfer check and docs

**Files:** create `backend/tests/test_transfer_e2e.py`; modify `backend/README.md` (protocol summary) and the roadmap (plan 2 contract additions: `/api/batches/{id}/files`, 429 `upload_quota`, idempotent complete, zip Content-Length, SSE rules, `Upload.item_id`/`received_bytes`/`updated_at`).

- [ ] **Step 1: Test** `test_big_file_round_trip`: with `CHUNK_SIZE=1 MiB`, send a 5.5 MiB random file from 4 threads in random order, repeating one chunk, then complete. Check the SHA-256 of the stored file, that its inode equals the temp file's, and that the recipient sees it.
- [ ] **Step 2: Run** `uv run pytest -q && uv run ruff check .`. Expected: PASS.
- [ ] **Step 3: Live run:** `make backend-dev` with a dummy password and a temp `DATA_DIR`. Send a 50 MB file over curl in 16 MiB chunks, two in parallel, complete it, compare the `shasum -a 256`, and record the time in the ledger.
- [ ] **Step 4: Commit** `test(backend): end-to-end transfer check; docs`.
