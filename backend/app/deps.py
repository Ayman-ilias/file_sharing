from datetime import timedelta

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.db import get_db, utcnow
from app.models import AuthSession, User
from app.security import token_hash

COOKIE_NAME = "fs_session"


def set_session_cookie(response: Response, request: Request, token: str) -> None:
    settings = request.app.state.settings
    response.set_cookie(
        COOKIE_NAME, token, max_age=settings.session_days * 86400, path="/",
        httponly=True, samesite="lax", secure=settings.cookie_secure,
    )


def current_user(request: Request, response: Response, db: Session = Depends(get_db)) -> User:
    """The signed-in user. Sliding expiry: extended whenever less than SESSION_DAYS - 1 remain."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(401, "not_signed_in")
    sess = db.get(AuthSession, token_hash(token))
    now = utcnow()
    if sess is None or sess.expires_at <= now:
        raise HTTPException(401, "not_signed_in")
    user = db.get(User, sess.user_id)
    if user is None or user.disabled_at is not None:
        raise HTTPException(401, "not_signed_in")
    days = request.app.state.settings.session_days
    if sess.expires_at - now < timedelta(days=days - 1):
        sess.expires_at = now + timedelta(days=days)
        db.commit()
        set_session_cookie(response, request, token)
    request.state.session_hash = sess.token_hash
    return user


def require_regular_user(user: User = Depends(current_user)) -> User:
    if user.is_global:
        raise HTTPException(403, "global_account")
    return user
