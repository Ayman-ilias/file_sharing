from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from fastapi import Request
from sqlalchemy import DateTime, Engine, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from app.config import Settings

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Base(DeclarativeBase):
    pass


class UTCDateTime(TypeDecorator):
    """Stores naive UTC in SQLite, always hands back timezone-aware UTC datetimes."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime given; use datetime.now(UTC)")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value, dialect):
        return value.replace(tzinfo=UTC) if value is not None else None


def utcnow() -> datetime:
    return datetime.now(UTC)


def db_url(settings: Settings) -> str:
    return f"sqlite:///{settings.data_dir / 'app.db'}"


def make_engine(settings: Settings) -> Engine:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    engine = create_engine(db_url(settings), connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

    return engine


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)


def upgrade_db(settings: Settings, engine: Engine) -> None:
    """Run Alembic migrations to head on the app's own engine, so its pragmas apply."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", db_url(settings))
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")


def get_db(request: Request) -> Iterator[Session]:
    session = request.app.state.session_factory()
    try:
        yield session
    finally:
        session.close()
