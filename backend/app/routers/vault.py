"""My storage. Everything is encrypted in the browser; these routes only keep ciphertext."""

import asyncio
import base64
import binascii
import secrets
from contextlib import AsyncExitStack

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db import get_db, utcnow
from app.deps import require_regular_user
from app.models import AuditLog, Upload, User, VaultItem, VaultKey
from app.routers.auth import check_password
from app.storage import remove_stored
from app.vault import held_bytes, used_bytes

router = APIRouter(prefix="/api/vault", tags=["vault"])
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

    ids = await asyncio.to_thread(_ids)
    async with (
        AsyncExitStack() as stack
    ):  # a chunk or complete racing the erase waits, then finds nothing
        for upload_id in sorted(ids):
            await stack.enter_async_context(app.state.upload_locks.get(upload_id))
        await asyncio.to_thread(_erase)
    for upload_id in ids:
        app.state.upload_locks.drop(upload_id)
