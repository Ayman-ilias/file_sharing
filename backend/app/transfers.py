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
from app.models import Upload
from app.storage import storage_path

# Bidi overrides/isolates: they make "evil‮txt.exe" display as "evilexe.txt".
_BIDI = dict.fromkeys(map(ord, "‪‫‬‭‮⁦⁧⁨⁩"))
_MIME = re.compile(r"[\w.+-]+/[\w.+-]+")
_DRIVE = re.compile(r"[A-Za-z]:")
MAX_SEGMENT_BYTES = 255


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
    if len(text.encode()) > MAX_SEGMENT_BYTES:
        raise ValueError("bad_path")
    return text


def clean_name(raw: str) -> str:
    return _clean_segment(raw)


def clean_relative_path(raw: str) -> str:
    if not raw or "\\" in raw or raw.startswith("/") or _DRIVE.match(raw):
        raise ValueError("bad_path")
    return "/".join(_clean_segment(part) for part in raw.split("/"))


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
    try:
        os.pwrite(fd, data, offset)
    except OSError as e:
        if e.errno == errno.ENOSPC:
            raise DiskFull from e
        raise
    finally:
        os.close(fd)


class UploadLocks:
    """One asyncio lock per upload, so bookkeeping for parallel chunks is serialised."""

    def __init__(self):
        self._locks: dict[str, asyncio.Lock] = {}

    def get(self, upload_id: str) -> asyncio.Lock:
        return self._locks.setdefault(upload_id, asyncio.Lock())

    def drop(self, upload_id: str) -> None:
        self._locks.pop(upload_id, None)


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
            db.commit()

    async with app.state.upload_locks.get(upload_id):
        chunk_size = await asyncio.to_thread(_check)
        path = storage_path(data_dir, "tmp", upload_id)
        try:
            await asyncio.to_thread(write_chunk, path, n * chunk_size, data)
        except DiskFull:
            raise HTTPException(507, "disk_full") from None
        await asyncio.to_thread(_mark)
