"""Tables, exactly as in the roadmap's shared contracts. No user-supplied name is ever a path."""

from datetime import datetime

from sqlalchemy import JSON, BigInteger, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base, UTCDateTime, utcnow


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    # None = the user still signs in with the shared starting password
    password_hash: Mapped[str | None] = mapped_column(String(255))
    is_global: Mapped[bool] = mapped_column(Boolean, default=False)
    disabled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class AuthSession(Base):
    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)


class Item(Base):
    __tablename__ = "items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8))  # file | folder | text
    name: Mapped[str] = mapped_column(String(512))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    mime: Mapped[str] = mapped_column(String(255), default="application/octet-stream")
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    is_global: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    text_body: Mapped[str | None] = mapped_column(Text)
    storage_id: Mapped[str | None] = mapped_column(String(32))
    file_count: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)

    recipients: Mapped[list["ItemRecipient"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True
    )
    entries: Mapped[list["FolderEntry"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True
    )


class ItemRecipient(Base):
    __tablename__ = "item_recipients"

    item_id: Mapped[str] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class FolderEntry(Base):
    __tablename__ = "folder_entries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), index=True)
    relative_path: Mapped[str] = mapped_column(String(1024))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    storage_id: Mapped[str] = mapped_column(String(32))
    mime: Mapped[str] = mapped_column(String(255), default="application/octet-stream")


class Upload(Base):
    __tablename__ = "uploads"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    target: Mapped[str] = mapped_column(String(8))  # share | vault
    client_key: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(String(512))
    size: Mapped[int] = mapped_column(BigInteger)
    mime: Mapped[str] = mapped_column(String(255))
    chunk_size: Mapped[int] = mapped_column(Integer)
    received: Mapped[list] = mapped_column(JSON, default=list)
    batch_id: Mapped[str | None] = mapped_column(String(32), index=True)
    relative_path: Mapped[str | None] = mapped_column(String(1024))
    recipient_ids: Mapped[list] = mapped_column(JSON, default=list)
    is_global: Mapped[bool] = mapped_column(Boolean, default=False)
    received_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    storage_id: Mapped[str | None] = mapped_column(String(32))  # set when a batch file completes
    item_id: Mapped[str | None] = mapped_column(String(32))  # set when completed (idempotent retry)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)  # idle check
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class Batch(Base):
    """A folder being uploaded: its completed files become one folder item."""

    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(512))
    file_count: Mapped[int] = mapped_column(Integer)  # expected number of files
    recipient_ids: Mapped[list] = mapped_column(JSON, default=list)  # sorted; [] when global
    is_global: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    item_id: Mapped[str | None] = mapped_column(String(32))
    failed_paths: Mapped[list] = mapped_column(JSON, default=list)  # same answer on a retry


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # delete | password_change | vault_erase | user_disabled
    action: Mapped[str] = mapped_column(String(32))
    item_id: Mapped[str | None] = mapped_column(String(32))
    item_name: Mapped[str | None] = mapped_column(String(512))
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class VaultKey(Base):
    __tablename__ = "vault_keys"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    salt: Mapped[str] = mapped_column(String(64))
    iterations: Mapped[int] = mapped_column(Integer)
    wrapped_key: Mapped[str] = mapped_column(String(512))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class VaultItem(Base):
    __tablename__ = "vault_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    meta_ct: Mapped[str] = mapped_column(Text)
    blob_id: Mapped[str | None] = mapped_column(String(32))
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
