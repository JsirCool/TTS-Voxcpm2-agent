from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from server.core.cleanup import cleanup_if_needed
from server.core.domain import EpisodeCreate
from server.core.models import Base
from server.core.repositories import EpisodeRepo


@pytest_asyncio.fixture()
async def session_factory() -> async_sessionmaker[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        await EpisodeRepo(session).create(
            EpisodeCreate(
                id="ep-cleanup",
                title="Cleanup",
                script_uri="s3://test/episodes/ep-cleanup/script.json",
            )
        )
        await session.commit()
    try:
        yield maker
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_cleanup_if_needed_tolerates_sync_magicmock_storage(session_factory: async_sessionmaker[AsyncSession]):
    storage = MagicMock()
    storage.get_bucket_size_bytes.return_value = 1
    storage.delete_prefix.return_value = 0

    await cleanup_if_needed(session_factory, storage)

