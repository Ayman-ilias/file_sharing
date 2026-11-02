import asyncio
import re
from datetime import timedelta
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db, utcnow
from app.deps import current_user
from app.models import Upload, User
from app.routers.items import resolve_recipients
from app.storage import free_bytes, remove_stored
from app.transfers import (
    chunk_len,
    clean_mime,
    clean_name,
    num_chunks,
    read_capped,
    recipient_key,
    record_chunk,
    reserved_bytes,
)

router = APIRouter(prefix="/api/uploads", tags=["uploads"])
_HEX32 = re.compile(r"[0-9a-f]{32}")


class UploadIn(BaseModel):
    client_key: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    name: str = Field(min_length=1, max_length=512)
    size: int = Field(ge=0)
    mime: str = Field(default="application/octet-stream", max_length=255)
    recipient_ids: list[int] = Field(default=[], max_length=1000)
    is_global: bool = False
    target: Literal["share", "vault"] = "share"
    batch_id: str | None = None
    relative_path: str | None = None


class UploadStarted(BaseModel):
    upload_id: str
    chunk_size: int
    received: list[int]


def check_id(upload_id: str) -> None:
    if not _HEX32.fullmatch(upload_id):
        raise HTTPException(404, "not_found")


def own_upload(db: Session, user: User, upload_id: str) -> Upload:
    check_id(upload_id)
    up = db.get(Upload, upload_id)
    if up is None or up.user_id != user.id:
        raise HTTPException(404, "not_found")
    return up


@router.post("", response_model=UploadStarted, status_code=201)
def start(body: UploadIn, request: Request, response: Response,
          user: User = Depends(current_user), db: Session = Depends(get_db)):
    settings = request.app.state.settings
    if body.target != "share":
        raise HTTPException(400, "bad_target")  # My storage uploads arrive in plan 4
    if body.batch_id or body.relative_path:
        raise HTTPException(400, "use_batch_files")  # folders register via /api/batches/{id}/files
    if user.is_global and not body.is_global:
        raise HTTPException(403, "global_account")
    try:
        name = clean_name(body.name)
    except ValueError:
        raise HTTPException(400, "bad_path") from None
    if body.size > settings.max_file_size:
        raise HTTPException(413, "too_large")
    if not body.is_global:
        if not resolve_recipients(db, user, body.recipient_ids):
            raise HTTPException(400, "no_recipients")
    key = recipient_key(body.recipient_ids, body.is_global)
    now = utcnow()

    existing = db.scalars(
        select(Upload).where(
            Upload.user_id == user.id, Upload.client_key == body.client_key,
            Upload.size == body.size, Upload.is_global.is_(body.is_global),
            Upload.batch_id.is_(None), Upload.completed_at.is_(None),
            Upload.updated_at > now - timedelta(hours=settings.stale_after_hours),
        ).order_by(Upload.updated_at.desc())
    ).all()
    for up in existing:
        if list(up.recipient_ids) == key:
            response.status_code = 200
            return UploadStarted(upload_id=up.id, chunk_size=up.chunk_size, received=up.received)

    unfinished = db.scalar(select(func.count()).select_from(Upload).where(
        Upload.user_id == user.id, Upload.completed_at.is_(None), Upload.batch_id.is_(None)))
    if unfinished >= settings.max_user_uploads or \
            reserved_bytes(db, user.id) + body.size > settings.max_user_reserved:
        raise HTTPException(429, "upload_quota")
    if free_bytes(settings.data_dir) - reserved_bytes(db) - body.size < settings.disk_margin:
        raise HTTPException(507, "disk_full")

    up = Upload(id=uuid4().hex, user_id=user.id, target="share", client_key=body.client_key,
                name=name, size=body.size, mime=clean_mime(body.mime),
                chunk_size=settings.chunk_size, received=[], received_bytes=0,
                recipient_ids=key, is_global=body.is_global, created_at=now, updated_at=now)
    db.add(up)
    db.commit()
    return UploadStarted(upload_id=up.id, chunk_size=up.chunk_size, received=[])


@router.put("/{upload_id}/chunks/{n}", status_code=204)
async def put_chunk(upload_id: str, n: int, request: Request, user: User = Depends(current_user)):
    check_id(upload_id)
    app = request.app

    def _expected() -> int:
        with app.state.session_factory() as db:
            up = db.get(Upload, upload_id)
            if up is None or up.user_id != user.id:
                raise HTTPException(404, "not_found")
            if up.completed_at is not None:
                raise HTTPException(409, "already_complete")
            if not 0 <= n < num_chunks(up.size, up.chunk_size):
                raise HTTPException(400, "bad_chunk")
            return chunk_len(up.size, up.chunk_size, n)

    expected = await asyncio.to_thread(_expected)
    if request.headers.get("content-length") != str(expected):
        raise HTTPException(400, "bad_chunk_size")
    try:
        data = await read_capped(request, expected)
    except ValueError:
        raise HTTPException(400, "bad_chunk_size") from None
    if len(data) != expected:
        raise HTTPException(400, "bad_chunk_size")
    await record_chunk(app, upload_id, n, data, user_id=user.id)


@router.get("/{upload_id}")
def status(upload_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    up = own_upload(db, user, upload_id)
    return {"received": up.received, "size": up.size, "chunk_size": up.chunk_size,
            "completed": up.completed_at is not None, "item_id": up.item_id}


@router.delete("/{upload_id}", status_code=204)
async def cancel(upload_id: str, request: Request, user: User = Depends(current_user)):
    check_id(upload_id)
    app = request.app

    def _delete() -> None:
        with app.state.session_factory() as db:
            up = own_upload(db, user, upload_id)
            if up.completed_at is not None:
                raise HTTPException(409, "already_complete")
            db.delete(up)
            db.commit()
        remove_stored(app.state.settings.data_dir, "tmp", upload_id)

    async with app.state.upload_locks.get(upload_id):
        await asyncio.to_thread(_delete)
    app.state.upload_locks.drop(upload_id)
