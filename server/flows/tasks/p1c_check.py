"""P1c — input validation check gate, runs after P1 and before P2.

Validates each chunk's text content to catch problems early, before
sending to the expensive TTS API.

Check rules (all per-chunk):
  - char_count <= 300              (hard fail)
  - char_count >= 5                (hard fail)
  - text_normalized.strip() != ""  (hard fail)
  - no emoji / unprintable Unicode (hard fail)
  - control tag ratio <= 50%       (warning, not fail)
"""

from __future__ import annotations

import logging
import re
import unicodedata
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable

from prefect import task
from sqlalchemy.ext.asyncio import AsyncSession

from server.core.domain import DomainError
from server.core.events import write_event
from server.core.repositories import ChunkRepo, StageRunRepo

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_CHAR_COUNT = 300
MIN_CHAR_COUNT = 5

# S2-Pro control tags: [break], [breath], [long break], [pause], etc.
_CONTROL_TAG_RE = re.compile(r"\[[a-z][a-z\s\-]{0,30}\]", re.IGNORECASE)

# Emoji regex — covers most common emoji ranges.
_EMOJI_RE = re.compile(
    "["
    "\U0001F600-\U0001F64F"  # emoticons
    "\U0001F300-\U0001F5FF"  # symbols & pictographs
    "\U0001F680-\U0001F6FF"  # transport & map
    "\U0001F1E0-\U0001F1FF"  # flags
    "\U00002702-\U000027B0"  # dingbats
    "\U0001F900-\U0001F9FF"  # supplemental symbols
    "\U0001FA00-\U0001FA6F"  # chess symbols
    "\U0001FA70-\U0001FAFF"  # symbols extended-A
    "\U00002600-\U000026FF"  # misc symbols
    "\U0000FE00-\U0000FE0F"  # variation selectors
    "\U0000200D"             # ZWJ
    "\U0000231A-\U0000231B"  # watch/hourglass
    "]"
)

# ---------------------------------------------------------------------------
# Dependency wiring
# ---------------------------------------------------------------------------

_SessionFactory = Callable[[], Any]
_session_factory: _SessionFactory | None = None


def configure_p1c_dependencies(
    *,
    session_factory: _SessionFactory,
) -> None:
    global _session_factory
    _session_factory = session_factory


def _require_deps() -> _SessionFactory:
    if _session_factory is None:
        raise RuntimeError(
            "p1c_check dependencies not configured. "
            "Call configure_p1c_dependencies(...) before running the task."
        )
    return _session_factory


@asynccontextmanager
async def _session_scope(factory: _SessionFactory) -> AsyncIterator[AsyncSession]:
    ctx = factory()
    async with ctx as session:
        yield session


# ---------------------------------------------------------------------------
# Check helpers
# ---------------------------------------------------------------------------


def _has_unprintable(text: str) -> bool:
    """Return True if text contains unprintable Unicode (excluding common whitespace)."""
    for ch in text:
        cat = unicodedata.category(ch)
        # Allow normal whitespace (Zs=space, Cc for \n\r\t)
        if cat == "Cc" and ch in ("\n", "\r", "\t"):
            continue
        # Control chars (other than the above)
        if cat == "Cc" or cat == "Cf":
            # Zero-width chars, control chars
            if ch not in ("\u200b",):  # allow ZWSP? No, flag it.
                return True
    return False


def _control_tag_ratio(text: str) -> float:
    """Return the fraction of text occupied by control tags like [break]."""
    tags = _CONTROL_TAG_RE.findall(text)
    if not tags:
        return 0.0
    tag_chars = sum(len(t) for t in tags)
    return tag_chars / len(text) if text else 0.0


def validate_chunk(
    text_normalized: str,
    char_count: int,
) -> tuple[list[str], list[str]]:
    """Validate a single chunk. Returns (errors, warnings)."""
    errors: list[str] = []
    warnings: list[str] = []

    # 1. text_normalized must be non-empty
    if not text_normalized.strip():
        errors.append("text_normalized is empty")
        return errors, warnings  # no point checking further

    # 2. char_count bounds
    if char_count > MAX_CHAR_COUNT:
        errors.append(f"char_count {char_count} exceeds max {MAX_CHAR_COUNT}")

    if char_count < MIN_CHAR_COUNT:
        errors.append(f"char_count {char_count} below min {MIN_CHAR_COUNT}")

    # 3. emoji check
    if _EMOJI_RE.search(text_normalized):
        errors.append("text contains emoji")

    # 4. unprintable Unicode
    if _has_unprintable(text_normalized):
        errors.append("text contains unprintable Unicode characters")

    # 5. control tag ratio (warning only)
    ratio = _control_tag_ratio(text_normalized)
    if ratio > 0.5:
        warnings.append(
            f"control tag ratio {ratio:.0%} exceeds 50%"
        )

    return errors, warnings


# ---------------------------------------------------------------------------
# Core routine
# ---------------------------------------------------------------------------


async def run_p1c_check(chunk_id: str) -> dict[str, Any]:
    """Pure coroutine that executes the P1c check gate."""
    session_factory = _require_deps()

    async with _session_scope(session_factory) as session:
        chunk = await ChunkRepo(session).get(chunk_id)
        if chunk is None:
            raise DomainError("not_found", f"chunk not found: {chunk_id}")

        episode_id = chunk.episode_id
        text_normalized = chunk.text_normalized or ""
        char_count = chunk.char_count

        # stage_started event
        started_at = datetime.now(timezone.utc)
        await write_event(
            session,
            episode_id=episode_id,
            chunk_id=chunk_id,
            kind="stage_started",
            payload={"stage": "p1c", "started_at": started_at.isoformat()},
        )
        await StageRunRepo(session).upsert(
            chunk_id=chunk_id,
            stage="p1c",
            status="running",
            started_at=started_at,
        )
        await session.commit()

    # Run validation (pure logic, no I/O)
    errors, warnings = validate_chunk(text_normalized, char_count)

    finished_at = datetime.now(timezone.utc)
    duration_ms = int((finished_at - started_at).total_seconds() * 1000)
    status = "failed" if errors else "ok"

    async with _session_scope(session_factory) as session:
        event_kind = "stage_failed" if errors else "stage_finished"
        payload: dict[str, Any] = {
            "stage": "p1c",
            "errors": errors,
            "warnings": warnings,
        }
        if errors:
            payload["error"] = "; ".join(errors)

        await write_event(
            session,
            episode_id=episode_id,
            chunk_id=chunk_id,
            kind=event_kind,
            payload=payload,
        )
        await StageRunRepo(session).upsert(
            chunk_id=chunk_id,
            stage="p1c",
            status=status,
            finished_at=finished_at,
            duration_ms=duration_ms,
            error="; ".join(errors) if errors else None,
        )
        await session.commit()

    return {
        "chunk_id": chunk_id,
        "status": status,
        "errors": errors,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Prefect task wrapper
# ---------------------------------------------------------------------------


@task(name="p1c-check", retries=0)
async def p1c_check(chunk_id: str) -> dict[str, Any]:
    """Prefect-wrapped entry point for the P1c input check gate."""
    return await run_p1c_check(chunk_id)


__all__ = [
    "p1c_check",
    "run_p1c_check",
    "configure_p1c_dependencies",
    "validate_chunk",
]
