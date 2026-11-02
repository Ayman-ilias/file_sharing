"""Chunked uploads: chunk maths, name/path cleaning, capped reads, offset writes, locks."""

import asyncio
import errno
import os
import re
import unicodedata
from pathlib import Path

from fastapi import FastAPI, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Item, Upload
from app.storage import storage_path

# Bidi overrides/isolates: they make "evil‮txt.exe" display as "evilexe.txt".
_BIDI = dict.fromkeys(map(ord, "‪‫‬‭‮⁦⁧⁨⁩"))
_MIME = re.compile(r"[\w.+-]+/[\w.+-]+")
_DRIVE = re.compile(r"[A-Za-z]:")
_RESERVED = re.compile(r"(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?", re.IGNORECASE)
MAX_SEGMENT_BYTES = 255
MAX_DEPTH = 32  # folders deeper than this can't be extracted on many systems


class DiskFull(Exception):
    pass


def num_chunks(size: int, chunk_size: int) -> int:
    return -(-size // chunk_size)


def chunk_len(size: int, chunk_size: int, n: int) -> int:
    return min(chunk_size, size - n * chunk_size)


def _clean_segment(raw: str) -> str:
    text = unicodedata.normalize("NFC", raw).translate(_BIDI)
    # drop control characters, keep format characters like ZWJ/ZWNJ (part of Bangla spelling)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cc").strip()
    if not text or text in (".", "..") or "/" in text or "\\" in text:
        raise ValueError("bad_path")
    if text.endswith(".") or _RESERVED.fullmatch(text):  # names Windows can't create
        raise ValueError("bad_path")
    if len(text.encode()) > MAX_SEGMENT_BYTES:
        raise ValueError("bad_path")
    return text


def clean_name(raw: str) -> str:
    return _clean_segment(raw)


def clean_relative_path(raw: str) -> str:
    if not raw or "\\" in raw or raw.startswith("/") or _DRIVE.match(raw):
        raise ValueError("bad_path")
    parts = raw.split("/")
    if len(parts) > MAX_DEPTH:
        raise ValueError("bad_path")
    return "/".join(_clean_segment(part) for part in parts)


def clean_mime(raw: str) -> str:
    raw = (raw or "").strip()
    return raw if len(raw) <= 255 and _MIME.fullmatch(raw) else "application/octet-stream"


def recipient_key(ids: list[int], is_global: bool) -> list[int]:
    return [] if is_global else sorted(set(ids))


def reserved_bytes(db: Session, user_id: int | None = None) -> int:
    """Bytes promised to unfinished uploads but not received yet."""
    q = select(func.coalesce(func.sum(Upload.size - Upload.received_bytes), 0)).where(
        Upload.completed_at.is_(None)
    )
    if user_id is not None:
        q = q.where(Upload.user_id == user_id)
    return int(db.scalar(q))


async def read_capped(request, limit: int) -> bytes:
    """Read the body without ever holding more than `limit` bytes; one byte over → ValueError."""
    buf = bytearray()
    async for part in request.stream():
        buf += part
        if len(buf) > limit:
            raise ValueError("body_too_long")
    return bytes(buf)


def write_chunk(path: Path, offset: int, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    view = memoryview(data)
    try:
        while view:  # pwrite may write fewer bytes than asked (e.g. a disk filling up)
            written = os.pwrite(fd, view, offset)
            if written <= 0:
                raise DiskFull
            view, offset = view[written:], offset + written
    except OSError as e:
        if e.errno == errno.ENOSPC:
            raise DiskFull from e
        raise
    finally:
        os.close(fd)


class UploadLocks:
    """One asyncio lock per upload, so bookkeeping for parallel chunks is serialised.

    Entries are forgotten only while unlocked (a held lock is never replaced, so waiters can't be
    split), and the table is pruned once it holds more than `max_idle` entries.
    """

    def __init__(self, max_idle: int = 1000):
        self.max_idle = max_idle
        self._locks: dict[str, asyncio.Lock] = {}

    def get(self, upload_id: str) -> asyncio.Lock:
        lock = self._locks.get(upload_id)
        if lock is None:
            lock = self._locks[upload_id] = asyncio.Lock()
            if len(self._locks) > self.max_idle:
                for key in [k for k, v in self._locks.items() if not v.locked() and k != upload_id]:
                    del self._locks[key]
        return lock

    def drop(self, upload_id: str) -> None:
        lock = self._locks.get(upload_id)
        if lock is not None and not lock.locked():
            del self._locks[upload_id]

    def size(self) -> int:
        return len(self._locks)


def _load_open(db: Session, upload_id: str, user_id: int | None) -> Upload:
    up = db.get(Upload, upload_id)
    if up is None or (user_id is not None and up.user_id != user_id):
        raise HTTPException(404, "not_found")
    if up.completed_at is not None:
        raise HTTPException(409, "already_complete")
    return up


async def record_chunk(app: FastAPI, upload_id: str, n: int, data: bytes,
                       user_id: int | None = None) -> None:
    """Under the upload's lock: re-check the row, write at the offset, mark the chunk received."""
    data_dir = app.state.settings.data_dir

    def _check() -> int:
        with app.state.session_factory() as db:
            return _load_open(db, upload_id, user_id).chunk_size

    def _mark() -> None:
        with app.state.session_factory() as db:
            up = _load_open(db, upload_id, user_id)
            if n not in up.received:
                # a NEW list: SQLAlchemy doesn't notice .append() on a JSON column
                up.received = sorted([*up.received, n])
                up.received_bytes += len(data)
            up.updated_at = utcnow()
            if up.batch_id:  # a chunk is activity for the whole folder (stale = idle)
                from app.models import Batch

                batch = db.get(Batch, up.batch_id)
                if batch is not None:
                    batch.updated_at = up.updated_at
            db.commit()
            if up.batch_id and len(up.received) == num_chunks(up.size, up.chunk_size):
                complete_batch_file(db, up, data_dir)

    async with app.state.upload_locks.get(upload_id):
        chunk_size = await asyncio.to_thread(_check)
        path = storage_path(data_dir, "tmp", upload_id)
        try:
            await asyncio.to_thread(write_chunk, path, n * chunk_size, data)
        except DiskFull:
            raise HTTPException(507, "disk_full") from None
        await asyncio.to_thread(_mark)


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def finalize_file(data_dir: Path, upload: Upload) -> None:
    """Move a fully received upload into files/ (same inode, no copy). Safe to call again.

    After a crash between the rename and the database commit, the temp file is gone and the
    stored file exists: that counts as done.
    """
    tmp = storage_path(data_dir, "tmp", upload.id)
    dest = storage_path(data_dir, "files", upload.id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not tmp.exists():
        if dest.exists():
            return
        if upload.size == 0:
            tmp.parent.mkdir(parents=True, exist_ok=True)
            tmp.touch()
        else:
            raise FileNotFoundError(f"upload {upload.id}: no data on disk")
    with open(tmp, "r+b") as fh:
        if os.fstat(fh.fileno()).st_size != upload.size:
            fh.truncate(upload.size)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, dest)
    _fsync_dir(dest.parent)


def complete_batch_file(db: Session, up: Upload, data_dir: Path) -> None:
    """A folder file is done when its last chunk lands (no separate complete call)."""
    from app.models import Batch

    finalize_file(data_dir, up)
    now = utcnow()
    up.completed_at, up.storage_id, up.updated_at = now, up.id, now
    batch = db.get(Batch, up.batch_id)
    if batch is not None:
        batch.updated_at = now
    db.commit()


def folder_zip(item: Item, data_dir: Path):
    """A stored (uncompressed) zip of a folder, streamed from disk with a known total length.

    Stored: files here are mostly already compressed, and stored entries give an exact length,
    so the browser shows real progress. Entries over 4 GiB use Zip64 automatically.
    """
    from zipstream import ZIP_STORED, ZipStream

    zs = ZipStream(compress_type=ZIP_STORED, sized=True)
    for e in sorted(item.entries, key=lambda e: e.relative_path):
        zs.add_path(str(storage_path(data_dir, "files", e.storage_id)), arcname=e.relative_path)
    return zs
