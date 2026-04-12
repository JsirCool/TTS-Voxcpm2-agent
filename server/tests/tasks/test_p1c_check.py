"""Unit tests for the P1c input validation check gate.

Tests cover:
  1. Happy path — valid chunk passes
  2. Empty text_normalized → hard fail
  3. char_count too large (> 300) → hard fail
  4. char_count too small (< 5) → hard fail
  5. Text contains emoji → hard fail
  6. Control tag ratio > 50% → warning (not fail)
"""

from __future__ import annotations

from typing import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from server.core.domain import EpisodeCreate
from server.core.models import Base, Chunk, Event, StageRun
from server.core.repositories import ChunkRepo, EpisodeRepo
from server.flows.tasks.p1c_check import (
    configure_p1c_dependencies,
    run_p1c_check,
    validate_chunk,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture()
async def engine_and_maker() -> AsyncIterator[tuple]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield engine, maker
    finally:
        await engine.dispose()


async def _seed_episode_and_chunk(
    maker: async_sessionmaker[AsyncSession],
    ep_id: str,
    chunk_id: str,
    text_normalized: str,
    char_count: int | None = None,
) -> None:
    async with maker() as s:
        async with s.begin():
            await EpisodeRepo(s).create(
                EpisodeCreate(
                    id=ep_id,
                    title="test",
                    script_uri=f"s3://tts-harness/episodes/{ep_id}/script.json",
                )
            )
            chunk = Chunk(
                id=chunk_id,
                episode_id=ep_id,
                shot_id="shot01",
                idx=1,
                text=text_normalized,
                text_normalized=text_normalized,
                status="pending",
                char_count=char_count if char_count is not None else len(text_normalized),
            )
            s.add(chunk)


# ---------------------------------------------------------------------------
# Pure validation tests
# ---------------------------------------------------------------------------


def test_validate_chunk_valid():
    """Valid chunk passes with no errors."""
    errors, warnings = validate_chunk("这是一段正常的中文文本。", 10)
    assert errors == []
    assert warnings == []


def test_validate_chunk_empty_text():
    """Empty text_normalized → hard fail."""
    errors, warnings = validate_chunk("   ", 0)
    assert len(errors) == 1
    assert "empty" in errors[0]


def test_validate_chunk_too_long():
    """char_count > 300 → hard fail."""
    text = "a" * 301
    errors, warnings = validate_chunk(text, 301)
    assert any("exceeds max" in e for e in errors)


def test_validate_chunk_too_short():
    """char_count < 5 → hard fail."""
    errors, warnings = validate_chunk("ab", 2)
    assert any("below min" in e for e in errors)


def test_validate_chunk_emoji():
    """Text with emoji → hard fail."""
    errors, warnings = validate_chunk("Hello 😀 world test!", 20)
    assert any("emoji" in e for e in errors)


def test_validate_chunk_control_tag_ratio():
    """Control tags > 50% → warning, not error."""
    # "[break][break][break]ab" — tags are 21 chars, total is 23 chars, ratio > 50%
    text = "[break][break][break]ab"
    errors, warnings = validate_chunk(text, len(text))
    assert errors == []
    assert any("control tag ratio" in w for w in warnings)


# ---------------------------------------------------------------------------
# Integration tests (DB + events)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_p1c_happy_path(engine_and_maker):
    """Valid chunk → status ok, stage_started + stage_finished events."""
    _, maker = engine_and_maker
    configure_p1c_dependencies(session_factory=maker)
    await _seed_episode_and_chunk(maker, "ep1", "ch01", "这是一段正常的中文文本。", 10)

    result = await run_p1c_check("ch01")
    assert result["status"] == "ok"
    assert result["errors"] == []

    # Check events
    async with maker() as s:
        events = (await s.execute(select(Event).order_by(Event.id))).scalars().all()
        kinds = [e.kind for e in events]
        assert "stage_started" in kinds
        assert "stage_finished" in kinds

        # Check StageRun
        sr = (await s.execute(
            select(StageRun).where(StageRun.chunk_id == "ch01", StageRun.stage == "p1c")
        )).scalar_one()
        assert sr.status == "ok"


@pytest.mark.asyncio
async def test_run_p1c_fail_empty(engine_and_maker):
    """Empty text → status failed, stage_failed event."""
    _, maker = engine_and_maker
    configure_p1c_dependencies(session_factory=maker)
    await _seed_episode_and_chunk(maker, "ep2", "ch02", "  ", 0)

    result = await run_p1c_check("ch02")
    assert result["status"] == "failed"
    assert len(result["errors"]) > 0

    async with maker() as s:
        events = (await s.execute(select(Event).order_by(Event.id))).scalars().all()
        kinds = [e.kind for e in events]
        assert "stage_failed" in kinds

        sr = (await s.execute(
            select(StageRun).where(StageRun.chunk_id == "ch02", StageRun.stage == "p1c")
        )).scalar_one()
        assert sr.status == "failed"
        assert sr.error is not None
