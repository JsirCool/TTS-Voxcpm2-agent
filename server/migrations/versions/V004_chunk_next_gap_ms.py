"""V004 - add per-boundary chunk gap override.

Revision ID: V004_chunk_next_gap_ms
Revises: V003_episode_locked
Create Date: 2026-04-21
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "V004_chunk_next_gap_ms"
down_revision: Union[str, None] = "V003_episode_locked"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("chunks", sa.Column("next_gap_ms", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("chunks", "next_gap_ms")
