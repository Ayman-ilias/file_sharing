from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        for sub in ("files", "vault", "tmp"):
            (settings.data_dir / sub).mkdir(parents=True, exist_ok=True)
        yield

    app = FastAPI(title="Southern IoT Files", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    return app
