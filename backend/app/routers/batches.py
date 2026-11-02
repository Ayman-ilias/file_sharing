import asyncio
import re
from datetime import timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db, utcnow
from app.deps import current_user
from app.events import notify_created
from app.models import Batch, FolderEntry, Item, ItemRecipient, Upload, User
from app.routers.items import resolve_recipients, to_out
from app.storage import free_bytes, remove_stored
from app.transfers import (
    clean_mime,
    clean_name,
    clean_relative_path,
    complete_batch_file,
    recipient_key,
    reserved_bytes,
)

router = APIRouter(prefix="/api/batches", tags=["batches"])
_HEX32 = re.compile(r"[0-9a-f]{32}")
MAX_FILES_PER_CALL = 500


class BatchIn(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    file_count: int
    recipient_ids: list[int] = Field(default=[], max_length=1000)
    is_global: bool = False


class BatchFileIn(BaseModel):
    relative_path: str = Field(min_length=1, max_length=4096)
    size: int = Field(ge=0)
    mime: str = Field(default="application/octet-stream", max_length=255)
    client_key: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")


class BatchFilesIn(BaseModel):
    files: list[BatchFileIn] = Field(min_length=1, max_length=MAX_FILES_PER_CALL)


def _lock(app, batch_id: str) -> asyncio.Lock:
    return app.state.upload_locks.get("batch-" + batch_id)


def own_batch(db: Session, user: User, batch_id: str) -> Batch:
    if not _HEX32.fullmatch(batch_id):
        raise HTTPException(404, "not_found")
    batch = db.get(Batch, batch_id)
    if batch is None or batch.user_id != user.id:
        raise HTTPException(404, "not_found")
    return batch


@router.post("", status_code=201)
def start_batch(body: BatchIn, request: Request, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    settings = request.app.state.settings
    if user.is_global and not body.is_global:
        raise HTTPException(403, "global_account")
    if body.file_count < 1:
        raise HTTPException(400, "empty")
    if body.file_count > settings.max_batch_files:
        raise HTTPException(400, "too_many_files")
    try:
        name = clean_name(body.name)
    except ValueError:
        raise HTTPException(400, "bad_path") from None
    if not body.is_global and not resolve_recipients(db, user, body.recipient_ids):
        raise HTTPException(400, "no_recipients")
    now = utcnow()
    batch = Batch(id=uuid4().hex, user_id=user.id, name=name, file_count=body.file_count,
                  recipient_ids=recipient_key(body.recipient_ids, body.is_global),
                  is_global=body.is_global, created_at=now, updated_at=now, failed_paths=[])
    db.add(batch)
    db.commit()
    return {"batch_id": batch.id}


@router.post("/{batch_id}/files", status_code=201)
async def register_files(batch_id: str, body: BatchFilesIn, request: Request,
                         user: User = Depends(current_user)):
    """Register up to 500 folder files at once; unfinished matches are resumed."""
    app = request.app
    settings = app.state.settings

    def _register():
        with app.state.session_factory() as db:
            batch = own_batch(db, user, batch_id)
            if batch.completed_at is not None:
                raise HTTPException(409, "batch_closed")
            wanted = []
            for f in body.files:
                try:
                    wanted.append((clean_relative_path(f.relative_path), f))
                except ValueError:
                    raise HTTPException(400, "bad_path") from None
                if f.size > settings.max_file_size:
                    raise HTTPException(413, "too_large")
            paths = [p for p, _ in wanted]
            if len(set(paths)) != len(paths):
                raise HTTPException(409, "duplicate_path")
            existing = {u.relative_path: u for u in db.scalars(
                select(Upload).where(Upload.batch_id == batch.id))}
            out, new_bytes, now = [], 0, utcnow()
            for path, f in wanted:
                old = existing.get(path)
                if old is not None and old.completed_at is not None:
                    raise HTTPException(409, "duplicate_path")
                if old is not None and old.client_key == f.client_key and old.size == f.size:
                    out.append((path, old))
                    continue
                if old is not None:  # same path, different file: replace the unfinished one
                    db.delete(old)
                    remove_stored(settings.data_dir, "tmp", old.id)
                    del existing[path]
                new_bytes += f.size
                out.append((path, Upload(
                    id=uuid4().hex, user_id=user.id, target="share", client_key=f.client_key,
                    name=path.rsplit("/", 1)[-1], size=f.size, mime=clean_mime(f.mime),
                    chunk_size=settings.chunk_size, received=[], received_bytes=0,
                    batch_id=batch.id, relative_path=path, recipient_ids=batch.recipient_ids,
                    is_global=batch.is_global, created_at=now, updated_at=now)))
            if len(set(existing) | set(paths)) > batch.file_count:
                raise HTTPException(409, "batch_full")
            if reserved_bytes(db, user.id) + new_bytes > settings.max_user_reserved:
                raise HTTPException(429, "upload_quota")
            free = free_bytes(settings.data_dir) - reserved_bytes(db)
            if free - new_bytes < settings.disk_margin:
                raise HTTPException(507, "disk_full")
            for _, up in out:
                if up not in db:
                    db.add(up)
            batch.updated_at = now
            db.commit()
            for _, up in out:  # zero-byte files have no chunks: done at once
                if up.size == 0 and up.completed_at is None:
                    complete_batch_file(db, up, settings.data_dir)
            return {"uploads": [{"relative_path": p, "upload_id": u.id, "chunk_size": u.chunk_size,
                                 "received": u.received} for p, u in out]}

    async with _lock(app, batch_id):
        result = await asyncio.to_thread(_register)
    return JSONResponse(result, status_code=201)


@router.post("/{batch_id}/complete", status_code=201)
async def complete_batch(batch_id: str, request: Request, user: User = Depends(current_user)):
    """Make the folder item from the finished files. Idempotent: a retry gets the same answer."""
    app = request.app
    settings = app.state.settings

    def _finish():
        with app.state.session_factory() as db:
            batch = own_batch(db, user, batch_id)
            if batch.completed_at is not None:
                item = to_out([db.get(Item, batch.item_id)], db, full=True)[0]
                return 200, item, list(batch.failed_paths)
            ups = db.scalars(select(Upload).where(Upload.batch_id == batch.id)).all()
            done = sorted((u for u in ups if u.completed_at is not None),
                          key=lambda u: u.relative_path)
            if not done:
                raise HTTPException(400, "empty_batch")
            failed = sorted(u.relative_path for u in ups if u.completed_at is None)
            now = utcnow()
            item = Item(id=uuid4().hex, kind="folder", name=batch.name,
                        size=sum(u.size for u in done), mime="inode/directory",
                        sender_id=user.id, is_global=batch.is_global, file_count=len(done),
                        created_at=now, expires_at=now + timedelta(days=settings.item_ttl_days))
            db.add(item)
            for uid in batch.recipient_ids:
                db.add(ItemRecipient(item_id=item.id, user_id=uid))
            for u in done:
                db.add(FolderEntry(id=uuid4().hex, item_id=item.id, relative_path=u.relative_path,
                                   size=u.size, storage_id=u.storage_id, mime=u.mime))
            for u in ups:
                if u.completed_at is None:
                    db.delete(u)
                    remove_stored(settings.data_dir, "tmp", u.id)
            batch.completed_at, batch.item_id, batch.failed_paths = now, item.id, failed
            batch.updated_at = now
            db.commit()
            return 201, to_out([item], db, full=True)[0], failed

    async with _lock(app, batch_id):
        code, item, failed = await asyncio.to_thread(_finish)
    if code == 201:
        notify_created(app, item.id)
    return JSONResponse({"item": item.model_dump(mode="json"), "failed": failed}, status_code=code)
