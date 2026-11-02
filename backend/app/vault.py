"""My storage: quota maths. The server never sees what is inside (ciphertext only)."""

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Upload, VaultItem

META_ALLOWANCE = (
    64 * 1024
)  # reserved with every vault upload, so its metadata can still be attached
HELD_IDLE = timedelta(
    seconds=30
)  # "[Cancel it]" only touches uploads quiet this long (never a live one)


def _unfinished(user_id: int):
    return select(Upload).where(
        Upload.user_id == user_id, Upload.target == "vault", Upload.completed_at.is_(None)
    )


def used_bytes(db: Session, user_id: int) -> int:
    """Items + finished-but-unattached blobs + what unfinished vault uploads have reserved."""
    items = db.scalar(
        select(func.coalesce(func.sum(VaultItem.size_bytes), 0)).where(VaultItem.user_id == user_id)
    )
    unattached = db.scalar(
        select(func.coalesce(func.sum(Upload.size + META_ALLOWANCE), 0)).where(
            Upload.user_id == user_id,
            Upload.target == "vault",
            Upload.completed_at.is_not(None),
            Upload.item_id.is_(None),
        )
    )
    reserved = db.scalar(
        select(
            func.coalesce(func.sum(Upload.size - Upload.received_bytes + META_ALLOWANCE), 0)
        ).where(Upload.user_id == user_id, Upload.target == "vault", Upload.completed_at.is_(None))
    )
    return int(items) + int(unattached) + int(reserved)


def held_bytes(db: Session, user_id: int, now: datetime) -> int:
    """Space held by this user's vault uploads that have gone quiet (e.g. the tab was reloaded)."""
    q = select(
        func.coalesce(func.sum(Upload.size - Upload.received_bytes + META_ALLOWANCE), 0)
    ).where(
        Upload.user_id == user_id,
        Upload.target == "vault",
        Upload.completed_at.is_(None),
        Upload.updated_at <= now - HELD_IDLE,
    )
    return int(db.scalar(q))


def quiet_uploads(db: Session, user_id: int, idle_for: timedelta, now: datetime) -> list[Upload]:
    return list(db.scalars(_unfinished(user_id).where(Upload.updated_at <= now - idle_for)))


VAULT_ABANDONED = timedelta(minutes=5)  # a vault upload this quiet was left behind by a reload
