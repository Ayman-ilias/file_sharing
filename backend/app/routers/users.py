from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import current_user
from app.models import User

router = APIRouter(prefix="/api/users", tags=["users"])


class UserOut(BaseModel):
    id: int
    username: str
    email: str


@router.get("", response_model=list[UserOut])
def list_users(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Colleagues for Send to: other enabled, regular users. Global only sends to Global."""
    if user.is_global:
        return []
    rows = (
        db.query(User)
        .filter(User.id != user.id, User.is_global.is_(False), User.disabled_at.is_(None))
        .order_by(User.username)
        .all()
    )
    return [UserOut(id=u.id, username=u.username, email=u.email) for u in rows]
