from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import make_engine, make_session_factory, upgrade_db
from app.models import User
from app.routers import auth, items, users
from app.security import RateLimiter, SecurityMiddleware


def seed_global_user(db: Session, settings: Settings) -> None:
    """The fixed global account exists from first start (idempotent)."""
    email = settings.global_email.lower()
    if db.query(User).filter_by(email=email).one_or_none() is None:
        db.add(User(email=email, username=email.split("@")[0], is_global=True))
        db.commit()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        for sub in ("files", "vault", "tmp"):
            (settings.data_dir / sub).mkdir(parents=True, exist_ok=True)
        upgrade_db(settings, engine)
        with app.state.session_factory() as db:
            seed_global_user(db, settings)
        yield
        engine.dispose()

    app = FastAPI(title="Southern IoT Files", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.add_middleware(SecurityMiddleware)
    engine = make_engine(settings)
    app.state.engine = engine
    app.state.session_factory = make_session_factory(engine)
    app.state.login_limiter = RateLimiter(limit=10, window_s=60)
    app.include_router(auth.router)
    app.include_router(users.router)
    app.include_router(items.router)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    return app
