"""Hourly cleanup of expired shared items and abandoned uploads. Never touches My storage."""

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import utcnow
from app.models import Item, Upload
from app.storage import remove_stored

log = logging.getLogger("fs.jobs")

CLEANUP_EVERY_S = 3600
STALE_UPLOAD_AFTER = timedelta(hours=24)


@dataclass
class CleanupReport:
    items_deleted: int = 0
    uploads_deleted: int = 0
    errors: int = 0


def run_cleanup(db: Session, settings: Settings, now: datetime) -> CleanupReport:
    """Each row in its own try/commit: one failure is counted, logged, and retried next run."""
    report = CleanupReport()
    expired = db.scalars(select(Item).where(Item.expires_at <= now)).all()
    for item in expired:
        try:
            for sid in [item.storage_id] + [e.storage_id for e in item.entries]:
                remove_stored(settings.data_dir, "files", sid)
            db.delete(item)
            db.commit()
            report.items_deleted += 1
        except Exception:
            db.rollback()
            report.errors += 1
            log.exception("cleanup: could not delete expired item %s", item.id)

    stale = db.scalars(
        select(Upload).where(
            Upload.completed_at.is_(None), Upload.created_at <= now - STALE_UPLOAD_AFTER
        )
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
    return report


def _cleanup_once(app: FastAPI) -> CleanupReport:
    with app.state.session_factory() as db:
        return run_cleanup(db, app.state.settings, utcnow())


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
