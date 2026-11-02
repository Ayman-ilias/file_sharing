"""vault key generation

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-02

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # nullable first so existing rows (none expected before plan 4) can be filled, then NOT NULL
    with op.batch_alter_table("vault_keys", schema=None) as batch_op:
        batch_op.add_column(sa.Column("key_gen", sa.String(length=16), nullable=True))
    op.execute("UPDATE vault_keys SET key_gen = lower(hex(randomblob(8))) WHERE key_gen IS NULL")
    with op.batch_alter_table("vault_keys", schema=None) as batch_op:
        batch_op.alter_column("key_gen", existing_type=sa.String(length=16), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("vault_keys", schema=None) as batch_op:
        batch_op.drop_column("key_gen")
