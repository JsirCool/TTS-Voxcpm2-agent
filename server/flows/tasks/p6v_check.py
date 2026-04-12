"""P6v — end-to-end validation check gate, runs after P6.

Validates the final concatenated output (subtitles + audio) at the
episode level. Mirrors the logic of ``scripts/postcheck-p6.js``.

Check rules:
  - subtitle coverage > 80% of audio duration
  - adjacent subtitle gap <= 0.5s
  - no subtitle overlap (> 1ms tolerance)
  - audio duration is reasonable (> 0)
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable

from prefect import task
from sqlalchemy.ext.asyncio import AsyncSession

from server.core.domain import DomainError
from server.core.events import write_event
from server.core.repositories import ChunkRepo, StageRunRepo
from server.core.storage import MinIOStorage

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants (match postcheck-p6.js thresholds)
# ---------------------------------------------------------------------------

COVERAGE_THRESHOLD = 0.8       # 80%
INTER_SUB_GAP_THRESHOLD = 0.5  # 0.5s
OVERLAP_TOLERANCE = 0.001      # 1ms

# ---------------------------------------------------------------------------
# Dependency wiring
# ---------------------------------------------------------------------------

_SessionFactory = Callable[[], Any]
_session_factory: _SessionFactory | None = None
_storage: MinIOStorage | None = None


def configure_p6v_dependencies(
    *,
    session_factory: _SessionFactory,
    storage: MinIOStorage,
) -> None:
    global _session_factory, _storage
    _session_factory = session_factory
    _storage = storage


def _require_deps() -> tuple[_SessionFactory, MinIOStorage]:
    if _session_factory is None or _storage is None:
        raise RuntimeError(
            "p6v_check dependencies not configured. "
            "Call configure_p6v_dependencies(...) before running the task."
        )
    return _session_factory, _storage


@asynccontextmanager
async def _session_scope(factory: _SessionFactory) -> AsyncIterator[AsyncSession]:
    ctx = factory()
    async with ctx as session:
        yield session


# ---------------------------------------------------------------------------
# Validation logic (pure, no I/O)
# ---------------------------------------------------------------------------


def validate_subtitles(
    subtitles: list[dict[str, Any]],
    audio_duration: float,
) -> tuple[list[str], list[str]]:
    """Validate subtitle list against audio duration.

    Returns (errors, warnings).
    """
    errors: list[str] = []
    warnings: list[str] = []

    if audio_duration <= 0:
        errors.append(f"audio duration {audio_duration}s is invalid")
        return errors, warnings

    if not subtitles:
        warnings.append("no subtitles to validate")
        return errors, warnings

    # Coverage check
    total_sub_time = sum(
        max(0.0, sub.get("end", 0) - sub.get("start", 0))
        for sub in subtitles
    )
    coverage = total_sub_time / audio_duration if audio_duration > 0 else 0
    if coverage < COVERAGE_THRESHOLD:
        errors.append(
            f"subtitle coverage {coverage:.1%} < {COVERAGE_THRESHOLD:.0%} "
            f"(sub time {total_sub_time:.2f}s / audio {audio_duration:.2f}s)"
        )

    # Gap + overlap checks
    for i in range(len(subtitles) - 1):
        curr = subtitles[i]
        nxt = subtitles[i + 1]
        curr_end = curr.get("end", 0)
        nxt_start = nxt.get("start", 0)

        # Overlap check (error)
        if curr_end > nxt_start + OVERLAP_TOLERANCE:
            errors.append(
                f"overlap at sub[{i}]: end {curr_end:.3f}s > sub[{i+1}] start {nxt_start:.3f}s"
            )

        # Gap check (warning)
        gap = nxt_start - curr_end
        if gap > INTER_SUB_GAP_THRESHOLD:
            warnings.append(
                f"gap {gap:.2f}s between sub[{i}] and sub[{i+1}]"
            )

    return errors, warnings


# ---------------------------------------------------------------------------
# Core routine
# ---------------------------------------------------------------------------


async def run_p6v_check(
    episode_id: str,
    *,
    srt_uri: str | None = None,
    total_duration_s: float | None = None,
    subtitles_data: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Pure coroutine that executes the P6v end-to-end validation.

    Can accept pre-loaded data (for tests) or fetch from storage.
    """
    session_factory, storage = _require_deps()

    # We pick the first chunk of the episode for event association
    async with _session_scope(session_factory) as session:
        chunks = await ChunkRepo(session).list_by_episode(episode_id)
        if not chunks:
            raise DomainError("not_found", f"no chunks for episode {episode_id}")

        first_chunk_id = chunks[0].id

        # stage_started
        started_at = datetime.now(timezone.utc)
        await write_event(
            session,
            episode_id=episode_id,
            chunk_id=None,
            kind="stage_started",
            payload={"stage": "p6v", "started_at": started_at.isoformat()},
        )
        # Use first chunk for StageRun record
        await StageRunRepo(session).upsert(
            chunk_id=first_chunk_id,
            stage="p6v",
            status="running",
            started_at=started_at,
        )
        await session.commit()

    # Gather subtitle data
    all_errors: list[str] = []
    all_warnings: list[str] = []

    if subtitles_data is not None and total_duration_s is not None:
        # Pre-loaded (test mode)
        errs, warns = validate_subtitles(subtitles_data, total_duration_s)
        all_errors.extend(errs)
        all_warnings.extend(warns)
    elif srt_uri and total_duration_s is not None:
        # Load from storage
        try:
            srt_bytes = await storage.download_bytes(srt_uri)
            srt_data = json.loads(srt_bytes.decode("utf-8"))
            # srt_data could be a flat list or a dict keyed by shot_id
            if isinstance(srt_data, list):
                errs, warns = validate_subtitles(srt_data, total_duration_s)
                all_errors.extend(errs)
                all_warnings.extend(warns)
            elif isinstance(srt_data, dict):
                for shot_id, subs in srt_data.items():
                    if isinstance(subs, list):
                        errs, warns = validate_subtitles(subs, total_duration_s)
                        all_errors.extend(errs)
                        all_warnings.extend(warns)
        except Exception as exc:
            all_errors.append(f"failed to load subtitles from {srt_uri}: {exc}")
    else:
        all_warnings.append("no subtitle data provided for validation")

    # Write result
    finished_at = datetime.now(timezone.utc)
    duration_ms = int((finished_at - started_at).total_seconds() * 1000)
    status = "failed" if all_errors else "ok"

    async with _session_scope(session_factory) as session:
        event_kind = "stage_failed" if all_errors else "stage_finished"
        payload: dict[str, Any] = {
            "stage": "p6v",
            "errors": all_errors,
            "warnings": all_warnings,
        }
        if all_errors:
            payload["error"] = "; ".join(all_errors)

        await write_event(
            session,
            episode_id=episode_id,
            chunk_id=None,
            kind=event_kind,
            payload=payload,
        )
        await StageRunRepo(session).upsert(
            chunk_id=first_chunk_id,
            stage="p6v",
            status=status,
            finished_at=finished_at,
            duration_ms=duration_ms,
            error="; ".join(all_errors) if all_errors else None,
        )
        await session.commit()

    return {
        "episode_id": episode_id,
        "status": status,
        "errors": all_errors,
        "warnings": all_warnings,
    }


# ---------------------------------------------------------------------------
# Prefect task wrapper
# ---------------------------------------------------------------------------


@task(name="p6v-check", retries=0)
async def p6v_check(
    episode_id: str,
    *,
    srt_uri: str | None = None,
    total_duration_s: float | None = None,
) -> dict[str, Any]:
    """Prefect-wrapped entry point for the P6v validation check gate."""
    return await run_p6v_check(
        episode_id,
        srt_uri=srt_uri,
        total_duration_s=total_duration_s,
    )


__all__ = [
    "p6v_check",
    "run_p6v_check",
    "configure_p6v_dependencies",
    "validate_subtitles",
]
