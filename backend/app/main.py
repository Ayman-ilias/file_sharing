from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import Settings, get_settings
from app.db import make_engine, make_session_factory, upgrade_db


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        for sub in ("files", "vault", "tmp"):
            (settings.data_dir / sub).mkdir(parents=True, exist_ok=True)
        upgrade_db(settings, engine)
        yield
        engine.dispose()

    app = FastAPI(title="Southern IoT Files", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    engine = make_engine(settings)
    app.state.engine = engine
    app.state.session_factory = make_session_factory(engine)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    return app
