"""My storage. Everything is encrypted in the browser; these routes only keep ciphertext."""

import asyncio
import base64
import binascii
import re
import secrets
from contextlib import AsyncExitStack
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db import get_db, utcnow
from app.deps import require_regular_user
from app.models import AuditLog, Upload, User, VaultItem, VaultKey
from app.routers.auth import check_password
from app.routers.uploads import QUOTA_LOCK
from app.storage import accel_path, remove_stored, storage_path
from app.vault import HELD_IDLE, META_ALLOWANCE, held_bytes, quiet_uploads, used_bytes

router = APIRouter(prefix="/api/vault", tags=["vault"])
_HEX32 = re.compile(r"[0-9a-f]{32}")
MIN_ITERATIONS = 600_000
MAX_ITERATIONS = 5_000_000


def _b64_len(value: str, lo: int, hi: int) -> str:
    try:
        n = len(base64.b64decode(value, validate=True))
    except (binascii.Error, ValueError):
        raise ValueError("not base64") from None
    if not lo <= n <= hi:
        raise ValueError("bad length")
    return value


class KeyIn(BaseModel):
    salt: str = Field(max_length=64)
    iterations: int = Field(ge=MIN_ITERATIONS, le=MAX_ITERATIONS)
    wrapped_key: str = Field(max_length=512)

    @field_validator("salt")
    @classmethod
    def _salt(cls, v: str) -> str:
        return _b64_len(v, 16, 16)

    @field_validator("wrapped_key")
    @classmethod
    def _wrapped(cls, v: str) -> str:
        return _b64_len(v, 40, 200)


class KeyChangeIn(KeyIn):
    previous_wrapped_key: str = Field(max_length=512)


class EraseIn(BaseModel):
    confirm: str = Field(max_length=16)
    login_password: str = Field(max_length=1024)


@router.get("")
def status(
    request: Request, user: User = Depends(require_regular_user), db: Session = Depends(get_db)
):
    key = db.get(VaultKey, user.id)
    count = db.scalar(
        select(func.count()).select_from(VaultItem).where(VaultItem.user_id == user.id)
    )
    return {
        "initialized": key is not None,
        "salt": key.salt if key else None,
        "iterations": key.iterations if key else None,
        "wrapped_key": key.wrapped_key if key else None,
        "key_gen": key.key_gen if key else None,
        "kdf": "pbkdf2-sha256",
        "used_bytes": used_bytes(db, user.id),
        "quota_bytes": request.app.state.settings.vault_quota,
        "item_count": int(count),
        "held_bytes": held_bytes(db, user.id, utcnow()),
    }


@router.post("/setup", status_code=204)
def setup(body: KeyIn, user: User = Depends(require_regular_user), db: Session = Depends(get_db)):
    if user.password_hash is None:
        # anyone who knows the shared starting password could otherwise set it up (or erase it)
        raise HTTPException(403, "own_password_required")
    if db.get(VaultKey, user.id) is not None:
        raise HTTPException(409, "already_initialized")
    db.add(
        VaultKey(
            user_id=user.id,
            salt=body.salt,
            iterations=body.iterations,
            wrapped_key=body.wrapped_key,
            key_gen=secrets.token_hex(8),
            updated_at=utcnow(),
        )
    )
    db.commit()


@router.put("/key", status_code=204)
def change_key(
    body: KeyChangeIn, user: User = Depends(require_regular_user), db: Session = Depends(get_db)
):
    """A new storage password re-wraps the same data key; key_gen stays (items stay readable)."""
    key = db.get(VaultKey, user.id)
    if key is None:
        raise HTTPException(404, "not_initialized")
    if not secrets.compare_digest(key.wrapped_key, body.previous_wrapped_key):
        raise HTTPException(409, "stale_key")  # another tab or device changed it first
    key.salt, key.iterations, key.wrapped_key = body.salt, body.iterations, body.wrapped_key
    key.updated_at = utcnow()
    db.add(AuditLog(actor_id=user.id, action="vault_key_change"))
    db.commit()


@router.post("/erase", status_code=204)
async def erase(body: EraseIn, request: Request, user: User = Depends(require_regular_user)):
    """Delete every vault item, blob, vault upload and the key.

    Needs the word ERASE and the login password.
    """
    app = request.app
    settings = app.state.settings
    if body.confirm != "ERASE":
        raise HTTPException(400, "confirm_required")
    if not check_password(user, body.login_password, settings):
        raise HTTPException(401, "bad_credentials")

    def _ids() -> list[str]:
        with app.state.session_factory() as db:
            return list(
                db.scalars(
                    select(Upload.id).where(Upload.user_id == user.id, Upload.target == "vault")
                )
            )

    def _erase() -> None:
        with app.state.session_factory() as db:
            blobs = list(
                db.scalars(
                    select(VaultItem.blob_id).where(
                        VaultItem.user_id == user.id, VaultItem.blob_id.is_not(None)
                    )
                )
            )
            uploads = list(
                db.scalars(
                    select(Upload).where(Upload.user_id == user.id, Upload.target == "vault")
                )
            )
            db.execute(delete(VaultItem).where(VaultItem.user_id == user.id))
            for up in uploads:
                db.delete(up)
            key = db.get(VaultKey, user.id)
            if key is not None:
                db.delete(key)
            db.add(AuditLog(actor_id=user.id, action="vault_erase"))
            db.commit()
        for blob in blobs:
            remove_stored(settings.data_dir, "vault", blob)
        for up in uploads:
            remove_stored(settings.data_dir, "tmp", up.id)
            remove_stored(settings.data_dir, "vault", up.id)

    def _locked_erase() -> None:
        with QUOTA_LOCK:  # an item save that already checked the key can't land after the erase
            _erase()

    ids = await asyncio.to_thread(_ids)
    async with (
        AsyncExitStack() as stack
    ):  # a chunk or complete racing the erase waits, then finds nothing
        for upload_id in sorted(ids):
            await stack.enter_async_context(app.state.upload_locks.get(upload_id))
        await asyncio.to_thread(_locked_erase)
    for upload_id in ids:
        app.state.upload_locks.drop(upload_id)


# ---------- items ----------

MAX_ITEMS = 5000
MAX_META = 1_400_000  # base64 characters: a 1 MiB note, encrypted and encoded


class ItemIn(BaseModel):
    meta_ct: str = Field(min_length=1)
    blob_id: str | None = Field(default=None, max_length=32)
    key_gen: str = Field(max_length=16)


class ItemUpdate(BaseModel):
    meta_ct: str = Field(min_length=1)
    version: int
    key_gen: str = Field(max_length=16)


def _out(item: VaultItem) -> dict:
    return {
        "id": item.id,
        "meta_ct": item.meta_ct,
        "blob_id": item.blob_id,
        "size_bytes": item.size_bytes,
        "version": item.version,
        "created_at": item.created_at.isoformat().replace("+00:00", "Z"),
        "updated_at": item.updated_at.isoformat().replace("+00:00", "Z"),
    }


def _check_key(db: Session, user: User, key_gen: str) -> None:
    key = db.get(VaultKey, user.id)
    if key is None:
        raise HTTPException(404, "not_initialized")
    if not secrets.compare_digest(key.key_gen, key_gen):
        raise HTTPException(
            409, "key_changed"
        )  # written with a data key that is no longer this vault's


def _own_item(db: Session, user: User, item_id: str) -> VaultItem:
    item = db.get(VaultItem, item_id) if _HEX32.fullmatch(item_id) else None
    if item is None or item.user_id != user.id:
        raise HTTPException(404, "not_found")
    return item


def _check_meta_size(meta_ct: str) -> None:
    if len(meta_ct) > MAX_META:
        raise HTTPException(413, "too_large")


@router.get("/items")
def list_items(user: User = Depends(require_regular_user), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(VaultItem)
        .where(VaultItem.user_id == user.id)
        .order_by(VaultItem.created_at.desc(), VaultItem.id.desc())
        .limit(MAX_ITEMS)
    )
    return [_out(r) for r in rows]


@router.post("/items", status_code=201)
def create_item(
    body: ItemIn,
    request: Request,
    user: User = Depends(require_regular_user),
    db: Session = Depends(get_db),
):
    settings = request.app.state.settings
    _check_meta_size(body.meta_ct)
    # the checks and the insert are one step (parallel adds, an erase, can't slip in)
    with QUOTA_LOCK:
        _check_key(db, user, body.key_gen)
        count = db.scalar(
            select(func.count()).select_from(VaultItem).where(VaultItem.user_id == user.id)
        )
        if count >= MAX_ITEMS:
            raise HTTPException(409, "too_many_items")
        used = used_bytes(db, user.id)
        blob_size = 0
        up = None
        if body.blob_id is not None:
            up = db.get(Upload, body.blob_id) if _HEX32.fullmatch(body.blob_id) else None
            if (
                up is None
                or up.user_id != user.id
                or up.target != "vault"
                or up.completed_at is None
                or up.item_id is not None
            ):
                raise HTTPException(404, "not_found")
            blob_size = up.size
            used -= up.size + META_ALLOWANCE  # it was counted while unattached
        if used + blob_size + len(body.meta_ct) > settings.vault_quota:
            raise HTTPException(507, "vault_full")
        now = utcnow()
        item = VaultItem(
            id=uuid4().hex,
            user_id=user.id,
            meta_ct=body.meta_ct,
            blob_id=body.blob_id,
            size_bytes=blob_size + len(body.meta_ct),
            version=1,
            created_at=now,
            updated_at=now,
        )
        db.add(item)
        if up is not None:
            up.item_id, up.updated_at = item.id, now
        db.commit()
    return _out(item)


@router.put("/items/{item_id}")
def update_item(
    item_id: str,
    body: ItemUpdate,
    request: Request,
    user: User = Depends(require_regular_user),
    db: Session = Depends(get_db),
):
    settings = request.app.state.settings
    _check_meta_size(body.meta_ct)
    with QUOTA_LOCK:
        _check_key(db, user, body.key_gen)
        item = _own_item(db, user, item_id)
        if item.version != body.version:
            return JSONResponse({"detail": "stale_version", "current": _out(item)}, status_code=409)
        delta = len(body.meta_ct) - len(item.meta_ct)  # only the growth needs room
        if delta > 0 and used_bytes(db, user.id) + delta > settings.vault_quota:
            raise HTTPException(507, "vault_full")
        item.meta_ct = body.meta_ct
        item.size_bytes += delta
        item.version += 1
        item.updated_at = utcnow()
        db.commit()
        return _out(item)


@router.delete("/items/{item_id}", status_code=204)
def delete_item(
    item_id: str,
    request: Request,
    user: User = Depends(require_regular_user),
    db: Session = Depends(get_db),
):
    item = _own_item(db, user, item_id)
    blob = item.blob_id
    db.delete(item)
    if blob:
        up = db.get(Upload, blob)
        if up is not None:
            db.delete(up)
    db.commit()
    remove_stored(request.app.state.settings.data_dir, "vault", blob)


@router.get("/items/{item_id}/blob")
def get_blob(
    item_id: str,
    request: Request,
    user: User = Depends(require_regular_user),
    db: Session = Depends(get_db),
):
    """Ciphertext only; decrypted in the browser. Always an opaque download."""
    item = _own_item(db, user, item_id)
    if not item.blob_id:
        raise HTTPException(404, "not_found")
    settings = request.app.state.settings
    headers = {
        "Content-Disposition": 'attachment; filename="blob"',
        "Cache-Control": "private, no-store",
    }
    if settings.serve_files:
        path = storage_path(settings.data_dir, "vault", item.blob_id)
        return FileResponse(path, media_type="application/octet-stream", headers=headers)
    headers["X-Accel-Redirect"] = accel_path("vault", item.blob_id)
    return Response(content=b"", media_type="application/octet-stream", headers=headers)


@router.post("/release-held")
async def release_held(request: Request, user: User = Depends(require_regular_user)):
    """[Cancel it]: drop this user's vault uploads that have gone quiet (a reloaded tab)."""
    app = request.app

    def _quiet() -> list[str]:
        with app.state.session_factory() as db:
            return [u.id for u in quiet_uploads(db, user.id, HELD_IDLE, utcnow())]

    def _release(ids: list[str]) -> int:
        released = 0
        with app.state.session_factory() as db:
            # re-checked under the locks: a chunk that landed meanwhile makes it active again
            for up in quiet_uploads(db, user.id, HELD_IDLE, utcnow()):
                if up.id in ids:
                    released += up.size + META_ALLOWANCE
                    db.delete(up)
                    remove_stored(app.state.settings.data_dir, "tmp", up.id)
            db.commit()
        return released

    ids = await asyncio.to_thread(_quiet)
    async with AsyncExitStack() as stack:  # a chunk being recorded finishes first
        for upload_id in sorted(ids):
            await stack.enter_async_context(app.state.upload_locks.get(upload_id))
        released = await asyncio.to_thread(_release, ids)
    for upload_id in ids:
        app.state.upload_locks.drop(upload_id)
    return {"released_bytes": released}
