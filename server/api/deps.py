"""Dependency injection helpers for FastAPI route handlers.

All heavy resources (DB session, storage, prefect client) are resolved here so
that route handlers stay thin.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from server.core.db import get_session as _core_get_session
from server.core.runtime_mode import is_truthy
from server.core.storage import StorageBackend, build_storage_from_env


# ---------------------------------------------------------------------------
# DB session
# ---------------------------------------------------------------------------


async def get_session() -> AsyncIterator[AsyncSession]:
    """Yield an ``AsyncSession`` scoped to one request."""
    async for s in _core_get_session():
        yield s


# ---------------------------------------------------------------------------
# MinIO storage
# ---------------------------------------------------------------------------

_storage_singleton: StorageBackend | None = None


def _build_storage() -> StorageBackend:
    return build_storage_from_env()


def get_storage() -> StorageBackend:
    global _storage_singleton
    if _storage_singleton is None:
        _storage_singleton = _build_storage()
    return _storage_singleton


# ---------------------------------------------------------------------------
# Prefect client
# ---------------------------------------------------------------------------


async def get_prefect_client() -> AsyncIterator[Any]:
    """Yield a Prefect async client.

    Usage in routes::

        @router.post("/episodes/{id}/run")
        async def run_episode(id: str, client=Depends(get_prefect_client)):
            await client.create_flow_run_from_deployment(...)
    """
    if not is_truthy(os.environ.get("TTS_USE_PREFECT")):
        yield None
        return

    from prefect.client.orchestration import get_client

    async with get_client() as client:
        yield client
