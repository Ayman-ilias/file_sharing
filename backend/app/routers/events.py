import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.db import utcnow
from app.deps import current_user
from app.events import event_stream
from app.models import AuthSession, User

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("")
async def events(request: Request, user: User = Depends(current_user)):
    """Server-Sent Events for this user. Re-checks the session at every heartbeat."""
    app = request.app
    session_hash = request.state.session_hash
    sub = app.state.broker.subscribe(user.id, user.is_global)

    def _valid() -> bool:
        with app.state.session_factory() as db:
            sess = db.get(AuthSession, session_hash)
            if sess is None or sess.expires_at <= utcnow():
                return False
            u = db.get(User, sess.user_id)
            return u is not None and u.disabled_at is None

    async def still_allowed() -> bool:
        return await asyncio.to_thread(_valid)

    async def stream():
        try:
            async for frame in event_stream(sub, still_allowed):
                yield frame
        finally:
            app.state.broker.unsubscribe(sub)

    headers = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}
    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)
