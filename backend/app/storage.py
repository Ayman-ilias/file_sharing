"""Where file bytes live. Paths come only from random hex IDs, never from user-supplied names."""

import re
import shutil
from pathlib import Path
from typing import Literal

Kind = Literal["files", "vault", "tmp"]
_ID = re.compile(r"[0-9a-f]{32}")
_KINDS = {"files", "vault", "tmp"}


def _check(kind: str, storage_id: str) -> None:
    if kind not in _KINDS:
        raise ValueError(f"bad storage kind: {kind!r}")
    if not _ID.fullmatch(storage_id):
        raise ValueError("storage id must be 32 lowercase hex characters")


def storage_path(data_dir: Path, kind: Kind, storage_id: str) -> Path:
    _check(kind, storage_id)
    return Path(data_dir) / kind / storage_id[:2] / storage_id


def accel_path(kind: Kind, storage_id: str) -> str:
    """The internal nginx location that serves the file (X-Accel-Redirect)."""
    _check(kind, storage_id)
    return f"/protected/{kind}/{storage_id[:2]}/{storage_id}"


def remove_stored(data_dir: Path, kind: Kind, storage_id: str | None) -> None:
    if storage_id:
        storage_path(data_dir, kind, storage_id).unlink(missing_ok=True)


def free_bytes(data_dir: Path) -> int:
    return shutil.disk_usage(data_dir).free
