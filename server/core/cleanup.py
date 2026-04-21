"""Storage cleanup — delete oldest unlocked episodes when quota exceeded.

Best-effort: failures are logged but never propagate to callers.
"""

from __future__ import annotations

import inspect
import logging
import os
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .repositories import EpisodeRepo
from .storage import StorageBackend

_log = logging.getLogger(__name__)

async def _await_if_needed(value: object) -> object:
    if inspect.isawaitable(value):
        return await value
    return value


def _coerce_size_bytes(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return max(0, int(value))
    return None


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


async def cleanup_storage(
    session: AsyncSession,
    storage: StorageBackend,
    quota_bytes: int,
    target_bytes: int,
) -> list[str]:
    """Delete oldest unlocked episodes until storage drops below *target_bytes*.

    Returns list of deleted episode IDs.
    """
    current = _coerce_size_bytes(await _await_if_needed(storage.get_bucket_size_bytes()))
    if current is None:
        _log.warning("storage get_bucket_size_bytes returned a non-numeric value; skip cleanup")
        return []
    if current <= quota_bytes:
        _log.debug("storage %d bytes <= quota %d, skip cleanup", current, quota_bytes)
        return []

    _log.info("storage %d bytes > quota %d, starting cleanup (target %d)", current, quota_bytes, target_bytes)

    repo = EpisodeRepo(session)
    candidates = await repo.list_unlocked_oldest_first()

    deleted_ids: list[str] = []
    for ep in candidates:
        if current <= target_bytes:
            break
        prefix = f"episodes/{ep.id}/"
        deleted_raw = await _await_if_needed(storage.delete_prefix(prefix))
        n = _coerce_size_bytes(deleted_raw)
        if n is None:
            n = 0
        await repo.delete(ep.id)
        await session.flush()
        _log.info("cleaned up episode %s (%d objects)", ep.id, n)
        deleted_ids.append(ep.id)
        next_size = _coerce_size_bytes(await _await_if_needed(storage.get_bucket_size_bytes()))
        if next_size is None:
            _log.warning("storage get_bucket_size_bytes returned a non-numeric value after deletion; stop cleanup")
            break
        current = next_size

    if deleted_ids:
        await session.commit()

    return deleted_ids


# ---------------------------------------------------------------------------
# Fire-and-forget trigger (called from create_episode route)
# ---------------------------------------------------------------------------

_GB = 1024 ** 3


async def cleanup_if_needed(
    session_factory: async_sessionmaker[AsyncSession],
    storage: StorageBackend,
) -> None:
    """Run cleanup check. Swallows all exceptions (best-effort)."""
    try:
        quota = int(float(os.environ.get("STORAGE_QUOTA_GB", "5")) * _GB)
        target = int(float(os.environ.get("STORAGE_TARGET_GB", "4")) * _GB)
        async with session_factory() as session:
            deleted = await cleanup_storage(session, storage, quota, target)
            if deleted:
                _log.info("cleanup deleted %d episodes: %s", len(deleted), deleted)
    except Exception:
        _log.exception("cleanup_if_needed failed (best-effort, continuing)")
