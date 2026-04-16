"""Integration test for ``run_p6_concat`` — real ffmpeg, in-memory DB, fake storage.

This test is intentionally self-contained:

* SQLite in-memory session (no docker required for the DB layer).
* An in-process ``FakeStorage`` that satisfies the subset of the
  ``MinIOStorage`` surface used by ``run_p6_concat`` — we don't need
  MinIO up because the real adapter is already covered by the W1-W2
  smoke in ``test_storage.py``.
* Real ``ffmpeg`` if it's on PATH. We generate three short silent WAVs
  with ffmpeg itself (sharing its encoder ensures stream-copy concat is
  guaranteed to work), upload them through the fake storage, run the
  task, and assert the output WAV's duration and the final SRT's shape.
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from server.core.domain import ChunkInput, EpisodeCreate, TakeAppend
from server.core.models import Base
from server.core.p6_logic import generate_silence, probe_duration_s
from server.core.repositories import ChunkRepo, EpisodeRepo, TakeRepo
from server.core.storage import chunk_subtitle_key, chunk_take_key
from server.flows.tasks.p6_concat import run_p6_concat


ffmpeg_required = pytest.mark.skipif(
    shutil.which("ffmpeg") is None,
    reason="ffmpeg not in PATH — skipping P6 integration test",
)


# ---------------------------------------------------------------------------
# In-memory storage double
# ---------------------------------------------------------------------------


class FakeStorage:
    """Minimal MinIOStorage-compatible stub used by ``run_p6_concat``.

    Only implements the methods the task actually calls. Keeping this
    deliberately tiny means the test stays focused on the P6 concat
    pipeline rather than on storage plumbing.
    """

    def __init__(self, bucket: str = "test") -> None:
        self._bucket = bucket
        self._objects: dict[str, bytes] = {}

    async def ensure_bucket(self) -> None:
        return None

    def s3_uri(self, key: str) -> str:
        return f"s3://{self._bucket}/{key}"

    async def exists(self, key: str) -> bool:
        return key in self._objects

    async def download_bytes(self, key: str) -> bytes:
        return self._objects[key]

    async def upload_file(self, key: str, path: Path) -> str:
        self._objects[key] = Path(path).read_bytes()
        return self.s3_uri(key)

    async def upload_bytes(
        self, key: str, data: bytes, content_type: str | None = None
    ) -> str:
        self._objects[key] = data
        return self.s3_uri(key)


# ---------------------------------------------------------------------------
# DB fixture (SQLite, shared with A2 tests)
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture()
async def session() -> AsyncSession:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:", future=True
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as sess:
        yield sess
    await engine.dispose()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _seed_episode(
    session: AsyncSession,
    storage: FakeStorage,
    tmp_path: Path,
    episode_id: str,
    chunk_specs: list[tuple[str, str, int, float, str]],
) -> None:
    """Insert episode + chunks + takes, upload fake WAVs and SRTs.

    ``chunk_specs`` entries: ``(chunk_id, shot_id, idx, duration_s, srt_body)``.
    ``srt_body`` is the literal SRT file content for that chunk, or empty to
    skip uploading a subtitle file.
    """
    ep_repo = EpisodeRepo(session)
    chunk_repo = ChunkRepo(session)
    take_repo = TakeRepo(session)

    await ep_repo.create(
        EpisodeCreate(
            id=episode_id,
            title=f"test-{episode_id}",
            script_uri=f"s3://test/{episode_id}/script.json",
        )
    )

    chunk_inputs = [
        ChunkInput(
            id=cid,
            episode_id=episode_id,
            shot_id=shot,
            idx=idx,
            text=f"text {cid}",
            text_normalized=f"text {cid}",
            char_count=len(f"text {cid}"),
        )
        for cid, shot, idx, _dur, _srt in chunk_specs
    ]
    await chunk_repo.bulk_insert(chunk_inputs)

    for cid, _shot, _idx, dur, srt_body in chunk_specs:
        take_id = f"{cid}-take1"
        # Generate a silent WAV at the target duration, upload it.
        wav_path = tmp_path / f"{cid}.wav"
        await generate_silence(wav_path, dur)
        await storage.upload_file(
            chunk_take_key(episode_id, cid, take_id), wav_path
        )
        await take_repo.append(
            TakeAppend(
                id=take_id,
                chunk_id=cid,
                audio_uri=storage.s3_uri(
                    chunk_take_key(episode_id, cid, take_id)
                ),
                duration_s=dur,
            )
        )
        await chunk_repo.set_selected_take(cid, take_id)
        await chunk_repo.set_status(cid, "verified")

        if srt_body:
            await storage.upload_bytes(
                chunk_subtitle_key(episode_id, cid),
                srt_body.encode("utf-8"),
            )

    await session.commit()


# ---------------------------------------------------------------------------
# The integration test
# ---------------------------------------------------------------------------


@ffmpeg_required
@pytest.mark.asyncio
async def test_run_p6_concat_end_to_end(tmp_path: Path, session: AsyncSession):
    storage = FakeStorage()

    # 3 chunks across 2 shots with realistic short durations.
    #   shot01:0 1.0s  "Hello"
    #   shot01:1 0.6s  "World"
    #   shot02:0 0.8s  "Next shot"
    specs = [
        (
            "ep:c1",
            "shot01",
            0,
            1.0,
            "1\n00:00:00,100 --> 00:00:00,800\nHello\n",
        ),
        (
            "ep:c2",
            "shot01",
            1,
            0.6,
            "1\n00:00:00,050 --> 00:00:00,500\nWorld\n",
        ),
        (
            "ep:c3",
            "shot02",
            0,
            0.8,
            "1\n00:00:00,050 --> 00:00:00,700\nNext shot\n",
        ),
    ]
    await _seed_episode(session, storage, tmp_path, "ep", specs)

    # Run the task core (not the Prefect wrapper — we don't need Prefect runtime).
    result = await run_p6_concat(
        "ep",
        padding_ms=200,
        shot_gap_ms=500,
        session=session,
        storage=storage,  # type: ignore[arg-type]
    )

    assert result.episode_id == "ep"
    assert result.chunk_count == 3
    # Expected total:
    #   c1=1.0 + pad 0.2 + c2=0.6 + shot_gap 0.5 + c3=0.8 = 3.1s
    assert result.total_duration_s == pytest.approx(3.1)

    # Download the final WAV back out of fake storage and probe it.
    wav_bytes = storage._objects[f"episodes/ep/final/episode.wav"]
    out_wav = tmp_path / "final.wav"
    out_wav.write_bytes(wav_bytes)
    probed = await probe_duration_s(out_wav)
    # ffmpeg concat of PCM WAVs is exact to within one sample; allow 40 ms
    # slack to cover container rounding on any platform.
    assert probed == pytest.approx(3.1, abs=0.04)

    # SRT content sanity: three renumbered cues with shifted timestamps.
    srt_bytes = storage._objects[f"episodes/ep/final/episode.srt"]
    srt_text = srt_bytes.decode("utf-8").replace("\r\n", "\n")
    assert "1\n00:00:00,100 --> 00:00:00,800\nHello" in srt_text
    # c2 offset = 1.0 + 0.2 = 1.2 → 1.25 --> 1.70
    assert "2\n00:00:01,250 --> 00:00:01,700\nWorld" in srt_text
    # c3 offset = 1.2 + 0.6 + 0.5 = 2.3 → 2.35 --> 3.00
    assert "3\n00:00:02,350 --> 00:00:03,000\nNext shot" in srt_text

    # Episode status advanced to done.
    ep_repo = EpisodeRepo(session)
    episode = await ep_repo.get("ep")
    assert episode is not None
    assert episode.status == "done"


@ffmpeg_required
@pytest.mark.asyncio
async def test_run_p6_concat_rejects_missing_selected_take(
    tmp_path: Path, session: AsyncSession
):
    """DomainError(invalid_state) if any chunk lacks a selected_take_id."""
    from server.core.domain import DomainError

    storage = FakeStorage()
    ep_repo = EpisodeRepo(session)
    chunk_repo = ChunkRepo(session)
    await ep_repo.create(
        EpisodeCreate(id="ep2", title="t", script_uri="s3://x/y.json")
    )
    await chunk_repo.bulk_insert(
        [
            ChunkInput(
                id="ep2:c1",
                episode_id="ep2",
                shot_id="shot01",
                idx=0,
                text="hi",
                text_normalized="hi",
                char_count=2,
            )
        ]
    )
    await chunk_repo.set_status("ep2:c1", "verified")
    await session.commit()

    with pytest.raises(DomainError) as exc:
        await run_p6_concat("ep2", session=session, storage=storage)  # type: ignore[arg-type]
    assert exc.value.code == "invalid_state"


@pytest.mark.asyncio
async def test_run_p6_concat_rejects_no_chunks(
    tmp_path: Path, session: AsyncSession
):
    """DomainError(invalid_state) if the episode has zero chunks."""
    from server.core.domain import DomainError

    storage = FakeStorage()
    ep_repo = EpisodeRepo(session)
    await ep_repo.create(
        EpisodeCreate(id="ep3", title="t", script_uri="s3://x/y.json")
    )
    await session.commit()

    with pytest.raises(DomainError) as exc:
        await run_p6_concat("ep3", session=session, storage=storage)  # type: ignore[arg-type]
    assert exc.value.code == "invalid_state"
