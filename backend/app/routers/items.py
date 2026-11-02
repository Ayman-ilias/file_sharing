import base64
import binascii
import unicodedata
from datetime import datetime, timedelta
from pathlib import PurePosixPath
from typing import Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import Select, and_, exists, or_, select
from sqlalchemy.orm import Session

from app.db import get_db, utcnow
from app.deps import current_user
from app.models import AuditLog, FolderEntry, Item, ItemRecipient, User
from app.schemas import ItemOut, ItemPage, TextItemIn, UserRef
from app.storage import accel_path, remove_stored

router = APIRouter(prefix="/api/items", tags=["items"])

UNTITLED_MAX = 80
TEXT_PREVIEW_CHARS = 2000  # lists carry a preview; the card asks for the rest on "Show all"
# Shown in the browser only on request (?inline=1); everything else is always a download.
INLINE_SANDBOXED = {"image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4"}
INLINE_PLAIN = {"application/pdf"}  # Chromium won't render a sandboxed PDF


class EntryOut(BaseModel):
    id: str
    relative_path: str
    size: int


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def visible_items_query(user: User, now: datetime) -> Select:
    """The one visibility rule: sender, recipient, or global. The global account: global only."""
    q = select(Item).where(Item.expires_at > now)
    if user.is_global:
        return q.where(Item.is_global.is_(True))
    is_recipient = exists().where(
        ItemRecipient.item_id == Item.id, ItemRecipient.user_id == user.id
    )
    return q.where(or_(Item.is_global.is_(True), Item.sender_id == user.id, is_recipient))


def encode_cursor(item: Item) -> str:
    raw = f"{item.created_at.isoformat()}|{item.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        ts, item_id = raw.split("|", 1)
        return datetime.fromisoformat(ts), item_id
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise HTTPException(400, "bad_cursor") from None


def to_out(items: list[Item], db: Session, *, full: bool = False) -> list[ItemOut]:
    """Serialise items with two queries (users + recipients). `full=False`: text preview only."""
    if not items:
        return []
    ids = [i.id for i in items]
    rec_rows = db.execute(
        select(ItemRecipient.item_id, ItemRecipient.user_id).where(ItemRecipient.item_id.in_(ids))
    ).all()
    user_ids = {i.sender_id for i in items} | {uid for _, uid in rec_rows}
    names = dict(db.execute(select(User.id, User.username).where(User.id.in_(user_ids))).all())
    recs: dict[str, list[UserRef]] = {}
    for item_id, uid in rec_rows:
        recs.setdefault(item_id, []).append(UserRef(id=uid, username=names[uid]))
    return [
        ItemOut(
            id=i.id, kind=i.kind, name=i.name, size=i.size, mime=i.mime,
            sender=UserRef(id=i.sender_id, username=names[i.sender_id]),
            recipients=sorted(recs.get(i.id, []), key=lambda u: u.username),
            is_global=i.is_global,
            **_text_fields(i, full),
            file_count=i.file_count if i.kind == "folder" else None,
            created_at=i.created_at, expires_at=i.expires_at,
        )
        for i in items
    ]


def _text_fields(item: Item, full: bool) -> dict:
    if item.kind != "text" or item.text_body is None:
        return {}
    body = item.text_body
    truncated = not full and len(body) > TEXT_PREVIEW_CHARS
    return {
        "text_body": body[:TEXT_PREVIEW_CHARS] if truncated else body,
        "text_truncated": truncated,
        "line_count": len(body.splitlines()),
    }


def resolve_recipients(db: Session, sender: User, ids: list[int]) -> list[User]:
    """Enabled regular users other than the sender; anything else is unknown_recipient."""
    wanted = set(ids)
    if not wanted:
        return []
    found = db.query(User).filter(
        User.id.in_(wanted), User.is_global.is_(False), User.disabled_at.is_(None),
        User.id != sender.id,
    ).all()
    if len(found) != len(wanted):
        raise HTTPException(400, "unknown_recipient")
    return found


@router.get("", response_model=ItemPage)
def list_items(
    section: Literal["private", "global"],
    before: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    q = visible_items_query(user, utcnow())
    q = q.where(Item.is_global.is_(section == "global"))
    if before:
        ts, item_id = decode_cursor(before)
        q = q.where(or_(Item.created_at < ts, and_(Item.created_at == ts, Item.id < item_id)))
    rows = db.scalars(q.order_by(Item.created_at.desc(), Item.id.desc()).limit(limit + 1)).all()
    page, more = rows[:limit], len(rows) > limit
    return ItemPage(items=to_out(list(page), db), next=encode_cursor(page[-1]) if more else None)


@router.post("/text", response_model=ItemOut, status_code=201)
def create_text(body: TextItemIn, request: Request, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    settings = request.app.state.settings
    if user.is_global and not body.is_global:
        raise HTTPException(403, "global_account")
    if not body.body.strip():
        raise HTTPException(400, "empty")
    size = len(body.body.encode())
    if size > settings.max_text_bytes:
        raise HTTPException(400, "too_large")
    recipients = [] if body.is_global else resolve_recipients(db, user, body.recipient_ids)
    if not body.is_global and not recipients:
        raise HTTPException(400, "no_recipients")

    title = (body.title or "").strip()
    if not title:
        first = next(line.strip() for line in body.body.splitlines() if line.strip())
        title = first[:UNTITLED_MAX]
    now = utcnow()
    item = Item(
        id=uuid4().hex, kind="text", name=nfc(title), size=size, mime="text/plain",
        sender_id=user.id, is_global=body.is_global, text_body=body.body,
        created_at=now, expires_at=now + timedelta(days=settings.item_ttl_days),
    )
    db.add(item)
    for r in recipients:
        db.add(ItemRecipient(item_id=item.id, user_id=r.id))
    db.commit()
    return to_out([item], db, full=True)[0]


def get_visible(db: Session, user: User, item_id: str) -> Item:
    item = db.scalars(visible_items_query(user, utcnow()).where(Item.id == item_id)).first()
    if item is None:
        raise HTTPException(404, "not_found")  # never reveal that a hidden item exists
    return item


def file_response(storage_id: str, filename: str, mime: str, inline: bool) -> Response:
    """Empty body + X-Accel-Redirect: nginx streams the bytes (Range, sendfile)."""
    base_mime = mime.split(";")[0].strip().lower()
    show_inline = inline and base_mime in INLINE_SANDBOXED | INLINE_PLAIN
    disposition = "inline" if show_inline else "attachment"
    headers = {
        "X-Accel-Redirect": accel_path("files", storage_id),
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(filename, safe='')}",
        "Cache-Control": "private, no-store",
    }
    if show_inline and base_mime in INLINE_SANDBOXED:
        headers["Content-Security-Policy"] = "sandbox"
    media_type = base_mime if show_inline else "application/octet-stream"
    return Response(content=b"", media_type=media_type, headers=headers)


@router.get("/{item_id}", response_model=ItemOut)
def get_item(item_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """One item with its full text (lists only carry a preview)."""
    return to_out([get_visible(db, user, item_id)], db, full=True)[0]


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: str, request: Request, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    """Anyone who can see an item may delete it for everyone (owner decision); always audited."""
    item = get_visible(db, user, item_id)
    data_dir = request.app.state.settings.data_dir
    stored = [item.storage_id] + [e.storage_id for e in item.entries]
    db.add(AuditLog(actor_id=user.id, action="delete", item_id=item.id, item_name=item.name))
    db.delete(item)
    db.commit()
    for sid in stored:
        remove_stored(data_dir, "files", sid)


@router.get("/{item_id}/download")
def download(item_id: str, inline: bool = False, user: User = Depends(current_user),
             db: Session = Depends(get_db)):
    item = get_visible(db, user, item_id)
    if item.kind != "file" or not item.storage_id:
        raise HTTPException(400, "not_a_file")
    return file_response(item.storage_id, item.name, item.mime, inline)


@router.get("/{item_id}/entries", response_model=list[EntryOut])
def list_entries(item_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    item = get_visible(db, user, item_id)
    if item.kind != "folder":
        raise HTTPException(400, "not_a_folder")
    rows = sorted(item.entries, key=lambda e: e.relative_path)
    return [EntryOut(id=e.id, relative_path=e.relative_path, size=e.size) for e in rows]


@router.get("/{item_id}/entries/{entry_id}/download")
def download_entry(item_id: str, entry_id: str, inline: bool = False,
                   user: User = Depends(current_user), db: Session = Depends(get_db)):
    item = get_visible(db, user, item_id)
    entry = db.get(FolderEntry, entry_id)
    if entry is None or entry.item_id != item.id:
        raise HTTPException(404, "not_found")
    filename = PurePosixPath(entry.relative_path).name
    return file_response(entry.storage_id, filename, entry.mime, inline)
