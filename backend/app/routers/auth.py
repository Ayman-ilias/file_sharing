import hmac
import re
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import get_db, utcnow
from app.deps import COOKIE_NAME, current_user, set_session_cookie
from app.models import AuditLog, AuthSession, User
from app.security import client_ip, hash_password, new_session_token, token_hash, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Verified against when the user is unknown, so timing doesn't reveal which emails exist.
_DUMMY_HASH = hash_password("dummy password for timing")


class EmailIn(BaseModel):
    email: str


class LoginIn(BaseModel):
    email: str
    password: str


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


MIN_PASSWORD_LEN = 10


class Me(BaseModel):
    id: int
    email: str
    username: str
    is_global: bool
    uses_shared_password: bool


def normalize_email(raw: str, domain: str) -> str:
    email = raw.strip().lower()
    if not re.fullmatch(r"[a-z0-9._%+-]+@" + re.escape(domain.lower()), email):
        raise ValueError("domain_not_allowed")
    return email


def to_me(user: User) -> Me:
    return Me(id=user.id, email=user.email, username=user.username, is_global=user.is_global,
              uses_shared_password=user.is_global or user.password_hash is None)


def check_password(user: User, password: str, settings: Settings) -> bool:
    if user.is_global or user.password_hash is None:
        shared = settings.shared_password.get_secret_value()
        return hmac.compare_digest(password.encode(), shared.encode())
    return verify_password(user.password_hash, password)


def _ip(request: Request) -> str:
    return client_ip(request, trust_x_real_ip=request.app.state.settings.trust_x_real_ip)


def _limit(request: Request) -> None:
    """Registration: every attempt counts."""
    if not request.app.state.login_limiter.hit(_ip(request)):
        raise HTTPException(429, "too_many_attempts")


def _fail_login(request: Request) -> HTTPException:
    """Only failed logins count, so a whole office behind one IP can still sign in."""
    request.app.state.login_limiter.record(_ip(request))
    return HTTPException(401, "bad_credentials")


@router.post("/register", status_code=201)
def register(body: EmailIn, request: Request, response: Response, db: Session = Depends(get_db)):
    _limit(request)
    settings = request.app.state.settings
    try:
        email = normalize_email(body.email, settings.allowed_email_domain)
    except ValueError:
        raise HTTPException(400, "domain_not_allowed") from None
    if email == settings.global_email.lower():
        raise HTTPException(400, "reserved")
    user = db.query(User).filter_by(email=email).one_or_none()
    if user is not None:
        response.status_code = 200
    else:
        user = User(email=email, username=email.split("@")[0])
        db.add(user)
        db.commit()
    return {"email": user.email, "username": user.username}


@router.post("/login", response_model=Me)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    if request.app.state.login_limiter.blocked(_ip(request)):
        raise HTTPException(429, "too_many_attempts")
    settings = request.app.state.settings
    try:
        email = normalize_email(body.email, settings.allowed_email_domain)
    except ValueError:
        email = None
    user = db.query(User).filter_by(email=email).one_or_none() if email else None
    if user is None or user.disabled_at is not None:
        verify_password(_DUMMY_HASH, body.password)
        raise _fail_login(request)
    if not check_password(user, body.password, settings):
        raise _fail_login(request)
    token = new_session_token()
    db.add(AuthSession(token_hash=token_hash(token), user_id=user.id,
                       expires_at=utcnow() + timedelta(days=settings.session_days)))
    db.commit()
    set_session_cookie(response, request, token)
    return to_me(user)


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, user: User = Depends(current_user),
           db: Session = Depends(get_db)):
    sess = db.get(AuthSession, request.state.session_hash)
    if sess is not None:
        db.delete(sess)
        db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")


@router.get("/me", response_model=Me)
def me(user: User = Depends(current_user)):
    return to_me(user)


@router.post("/password", status_code=204)
def change_password(body: PasswordIn, request: Request, user: User = Depends(current_user),
                    db: Session = Depends(get_db)):
    """Set your own login password. Other sessions are signed out; this one stays."""
    if user.is_global:
        raise HTTPException(403, "global_account")
    if not check_password(user, body.current_password, request.app.state.settings):
        raise HTTPException(401, "bad_credentials")
    if len(body.new_password) < MIN_PASSWORD_LEN:
        raise HTTPException(400, "too_short")
    shared = request.app.state.settings.shared_password.get_secret_value()
    if hmac.compare_digest(body.new_password.encode(), shared.encode()):
        raise HTTPException(400, "same_as_shared")  # else the warning banner would lie
    user.password_hash = hash_password(body.new_password)
    db.query(AuthSession).filter(
        AuthSession.user_id == user.id, AuthSession.token_hash != request.state.session_hash
    ).delete(synchronize_session=False)
    db.add(AuditLog(actor_id=user.id, action="password_change"))
    db.commit()
