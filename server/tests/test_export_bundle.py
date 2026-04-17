from __future__ import annotations

import io
import shutil
import wave
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from server.core.domain import ChunkInput, EpisodeCreate, TakeAppend
from server.core.export_bundle import build_export_bundle
from server.core.models import Base
from server.core.p6_logic import generate_silence
from server.core.repositories import ChunkRepo, EpisodeRepo, TakeRepo
from server.core.storage import chunk_subtitle_key, chunk_take_key


ffmpeg_required = pytest.mark.skipif(
    shutil.which("ffmpeg") is None,
    reason="ffmpeg not in PATH",
)


class FakeStorage:
    def __init__(self, bucket: str = "test") -> None:
        self._bucket = bucket
        self._objects: dict[str, bytes] = {}

    async def download_bytes(self, key: str) -> bytes:
        return self._objects[key]

    async def upload_file(self, key: str, path: Path) -> str:
        self._objects[key] = Path(path).read_bytes()
        return f"s3://{self._bucket}/{key}"

    async def upload_bytes(
        self,
        key: str,
        data: bytes,
        content_type: str | None = None,
    ) -> str:
        self._objects[key] = data
        return f"s3://{self._bucket}/{key}"


@pytest_asyncio.fixture()
async def session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as sess:
        yield sess
    await engine.dispose()


async def _seed_export_data(session: AsyncSession, storage: FakeStorage, tmp_path: Path) -> list:
    ep_repo = EpisodeRepo(session)
    chunk_repo = ChunkRepo(session)
    take_repo = TakeRepo(session)

    await ep_repo.create(
        EpisodeCreate(
            id="ep-export",
            title="Export episode",
            script_uri="s3://test/episodes/ep-export/script.json",
        )
    )

    chunk_specs = [
        ("ep-export:shot01:1", "shot01", 1, 0.4, "Alpha"),
        ("ep-export:shot02:1", "shot02", 1, 0.6, "Beta"),
    ]
    await chunk_repo.bulk_insert(
        [
            ChunkInput(
                id=chunk_id,
                episode_id="ep-export",
                shot_id=shot_id,
                idx=idx,
                text=text,
                text_normalized=text,
                char_count=len(text),
            )
            for chunk_id, shot_id, idx, _duration_s, text in chunk_specs
        ]
    )

    for chunk_id, shot_id, idx, duration_s, text in chunk_specs:
        take_id = f"{chunk_id}-take1"
        wav_path = tmp_path / f"{chunk_id.replace(':', '_')}.wav"
        await generate_silence(wav_path, duration_s)
        await storage.upload_file(chunk_take_key("ep-export", chunk_id, take_id), wav_path)
        await take_repo.append(
            TakeAppend(
                id=take_id,
                chunk_id=chunk_id,
                audio_uri=f"s3://test/{chunk_take_key('ep-export', chunk_id, take_id)}",
                duration_s=duration_s,
            )
        )
        await chunk_repo.set_selected_take(chunk_id, take_id)
        await chunk_repo.set_status(chunk_id, "verified")
        await storage.upload_bytes(
            chunk_subtitle_key("ep-export", chunk_id),
            f"1\n00:00:00,000 --> 00:00:00,300\n{text}\n".encode("utf-8"),
        )

    await session.commit()
    return list(await chunk_repo.list_by_episode("ep-export"))


@ffmpeg_required
@pytest.mark.asyncio
async def test_build_export_bundle_includes_final_episode_assets(
    tmp_path: Path,
    session: AsyncSession,
):
    storage = FakeStorage()
    chunks = await _seed_export_data(session, storage, tmp_path)
    take_repo = TakeRepo(session)

    bundle = await build_export_bundle(
        episode_id="ep-export",
        chunks=chunks,
        take_repo=take_repo,
        storage=storage,  # type: ignore[arg-type]
        episode_title="Export episode",
        cache_key="test-cache",
    )

    assert "shot01.wav" in bundle.files
    assert "shot02.wav" in bundle.files
    assert "episode.wav" in bundle.files
    assert "episode.srt" in bundle.files
    assert bundle.manifest["finalAudioFile"] == "episode.wav"
    assert bundle.manifest["finalSubtitleFile"] == "episode.srt"
    assert bundle.manifest["shotCount"] == 2
    assert bundle.manifest["shots"][1]["startS"] == pytest.approx(0.9, abs=0.01)
    assert bundle.manifest["totalDurationS"] == pytest.approx(1.5, abs=0.05)

    with io.BytesIO(bundle.files["episode.wav"]) as wav_buffer:
        with wave.open(wav_buffer) as wav_file:
            duration_s = wav_file.getnframes() / wav_file.getframerate()
    assert duration_s == pytest.approx(1.5, abs=0.05)

    episode_srt = bundle.files["episode.srt"].decode("utf-8").replace("\r\n", "\n")
    assert "1\n00:00:00,000 --> 00:00:00,300\nAlpha" in episode_srt
    assert "2\n00:00:00,900 --> 00:00:01,200\nBeta" in episode_srt
