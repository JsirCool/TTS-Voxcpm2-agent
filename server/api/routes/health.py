"""Health-check endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from server.api.deps import get_session, get_storage
from server.core.storage import StorageBackend

router = APIRouter()


@router.get("/healthz", tags=["ops"])
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz", tags=["ops"])
async def readyz(
    session: AsyncSession = Depends(get_session),
    storage: StorageBackend = Depends(get_storage),
) -> dict[str, object]:
    database_ok = True
    storage_ok = True
    database_error: str | None = None
    storage_error: str | None = None

    try:
        await session.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        database_ok = False
        database_error = f"{type(exc).__name__}: {exc}"

    try:
        await storage.ensure_bucket()
    except Exception as exc:  # noqa: BLE001
        storage_ok = False
        storage_error = f"{type(exc).__name__}: {exc}"

    return {
        "api": True,
        "database": database_ok,
        "storage": storage_ok,
        "databaseError": database_error,
        "storageError": storage_error,
    }
