from datetime import datetime

from pydantic import BaseModel, Field


class UserRef(BaseModel):
    id: int
    username: str


class ItemOut(BaseModel):
    id: str
    kind: str
    name: str
    size: int
    mime: str
    sender: UserRef
    recipients: list[UserRef]
    is_global: bool
    text_body: str | None = None  # lists: first TEXT_PREVIEW_CHARS only; GET /api/items/{id}: all
    text_truncated: bool = False
    line_count: int | None = None
    file_count: int | None = None
    created_at: datetime
    expires_at: datetime


class ItemPage(BaseModel):
    items: list[ItemOut]
    next: str | None


class TextItemIn(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    body: str
    recipient_ids: list[int] = []
    is_global: bool = False
