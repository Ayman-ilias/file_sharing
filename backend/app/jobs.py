"""Hourly cleanup of expired shared items and abandoned uploads. Never touches My storage."""

import asyncio
import contextlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.events import Audience, audience_for
from app.models import AuthSession, Batch, FolderEntry, Item, Upload
from app.storage import remove_stored

log = logging.getLogger("fs.jobs")

CLEANUP_EVERY_S = 3600


@dataclass
class CleanupReport:
    items_deleted: int = 0
    uploads_deleted: int = 0
    orphans_deleted: int = 0
    errors: int = 0


def run_cleanup(db: Session, settings: Settings, now: datetime,
                on_deleted: Callable[[str, Audience], None] | None = None) -> CleanupReport:
    """Each row in its own try/commit: one failure is counted, logged, and retried next run."""
    report = CleanupReport()
    expired = db.scalars(select(Item).where(Item.expires_at <= now)).all()
    for item in expired:
        try:
            item_id = item.id
            audience = audience_for(item.sender_id, item.is_global,
                                    [r.user_id for r in item.recipients])
            for sid in [item.storage_id] + [e.storage_id for e in item.entries]:
                remove_stored(settings.data_dir, "files", sid)
            db.delete(item)
            db.commit()
            report.items_deleted += 1
            if on_deleted is not None:
                on_deleted(item_id, audience)
        except Exception:
            db.rollback()
            report.errors += 1
            log.exception("cleanup: could not delete expired item %s", item.id)

    idle_since = now - timedelta(hours=settings.stale_after_hours)
    stale_batches = db.scalars(
        select(Batch).where(Batch.completed_at.is_(None), Batch.updated_at <= idle_since)
    ).all()
    for batch in stale_batches:  # abandoned folders: their finished files go too
        try:
            for up in db.scalars(select(Upload).where(Upload.batch_id == batch.id)).all():
                remove_stored(settings.data_dir, "tmp", up.id)
                remove_stored(settings.data_dir, "files", up.storage_id)
                db.delete(up)
            db.delete(batch)
            db.commit()
        except Exception:
            db.rollback()
            report.errors += 1
            log.exception("cleanup: could not delete stale batch %s", batch.id)

    stale = db.scalars(
        select(Upload).where(Upload.completed_at.is_(None), Upload.updated_at <= idle_since)
    ).all()
    for up in stale:
        try:
            remove_stored(settings.data_dir, "tmp", up.id)
            db.delete(up)
            db.commit()
            report.uploads_deleted += 1
        except Exception:
            db.rollback()
            report.errors += 1
            log.exception("cleanup: could not delete stale upload %s", up.id)
    try:
        db.query(AuthSession).filter(AuthSession.expires_at <= now).delete()
        db.commit()
    except Exception:
        db.rollback()
        report.errors += 1
        log.exception("cleanup: could not purge expired sessions")
    report.orphans_deleted = sweep_orphans(db, settings, idle_since)
    return report


def sweep_orphans(db: Session, settings: Settings, older_than: datetime) -> int:
    """Delete files in tmp/ and files/ that no row references (e.g. after a crash)."""
    known_files = set(db.scalars(select(Item.storage_id).where(Item.storage_id.is_not(None))))
    known_files |= set(db.scalars(select(FolderEntry.storage_id)))
    known_files |= set(db.scalars(select(Upload.storage_id).where(Upload.storage_id.is_not(None))))
    known_tmp = set(db.scalars(select(Upload.id).where(Upload.completed_at.is_(None))))
    cutoff = older_than.timestamp()
    removed = 0
    for kind, known in (("files", known_files), ("tmp", known_tmp)):
        root = settings.data_dir / kind
        if not root.is_dir():
            continue
        for path in root.glob("*/*"):
            try:
                if path.name not in known and path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed += 1
            except OSError:
                log.exception("orphan sweep: could not check %s", path)
    return removed


def _cleanup_once(app: FastAPI) -> CleanupReport:
    from app.events import notify_deleted

    with app.state.session_factory() as db:
        return run_cleanup(db, app.state.settings, utcnow(),
                           on_deleted=lambda iid, aud: notify_deleted(app, iid, aud, by=None))


async def _loop(app: FastAPI) -> None:
    while True:
        try:
            report = await asyncio.to_thread(_cleanup_once, app)
            log.info("cleanup: %s", report)
        except Exception:  # never let the loop die
            log.exception("cleanup run failed")
        await asyncio.sleep(CLEANUP_EVERY_S)


def start_cleanup_loop(app: FastAPI) -> asyncio.Task:
    app.state.cleanup_task = asyncio.create_task(_loop(app), name="cleanup")
    return app.state.cleanup_task


async def stop_cleanup_loop(app: FastAPI) -> None:
    task = getattr(app.state, "cleanup_task", None)
    if task is not None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
