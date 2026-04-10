"""Integration tests for ``server.flows.tasks.p3_transcribe.run_p3_transcribe``.

Scope
-----
- Real SQLAlchemy (SQLite in-memory) — exercises repositories + events.
- Fake MinIO storage (in-memory dict).
- Mock httpx transport for whisperx-svc — no network calls.

Scenarios
---------
1. Happy path → chunk transitions synth_done → transcribed, transcript JSON
   uploaded to MinIO, events include stage_started + stage_finished.
2. Missing chunk → DomainError("not_found").
3. Chunk missing selected_take_id → DomainError("invalid_state").
4. WhisperX 503 → httpx.HTTPStatusError propagates (Prefect retries).
5. WhisperX timeout → httpx.ReadTimeout propagates.
6. WhisperX returns empty transcript → DomainError("invalid_state").
7. Take WAV missing from storage → DomainError("not_found").
"""

from __future__ import annotations

import io
import json
import wave
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from server.core.domain import (
    ChunkInput,
    DomainError,
    EpisodeCreate,
    TakeAppend,
)
from server.core.models import Base, Chunk, Event
from server.core.repositories import (
    ChunkRepo,
    EpisodeRepo,
    EventRepo,
    TakeRepo,
)
from server.core.storage import chunk_take_key, chunk_transcript_key
from server.flows.tasks import p3_transcribe as p3_module
from server.flows.tasks.p3_transcribe import (
    configure_p3_dependencies,
    run_p3_transcribe,
)

EP_ID = "ep-test"
CHUNK_ID = "ep-test:c1"
TAKE_ID = "take-001"

SAMPLE_TRANSCRIPT = {
    "transcript": [
        {"word": "你好", "start": 0.0, "end": 0.5, "score": 0.95},
        {"word": "世界", "start": 0.5, "end": 1.0, "score": 0.90},
    ],
    "language": "zh",
    "duration_s": 1.0,
    "model": "large-v3",
}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _make_tiny_wav(seconds: float = 0.5, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        n = int(rate * seconds)
        wf.writeframes(b"\x00\x00" * n)
    return buf.getvalue()


@dataclass
class FakeStorage:
    bucket: str = "tts-harness"
    objects: dict[str, bytes] = field(default_factory=dict)

    def s3_uri(self, key: str) -> str:
        return f"s3://{self.bucket}/{key}"

    async def upload_bytes(
        self, key: str, data: bytes, content_type: str | None = None
    ) -> str:
        self.objects[key] = data
        return self.s3_uri(key)

    async def download_bytes(self, key: str) -> bytes:
        if key not in self.objects:
            raise KeyError(key)
        return self.objects[key]


def _mock_transport(
    status_code: int = 200,
    response_json: dict | None = None,
    raise_exc: Exception | None = None,
) -> httpx.MockTransport:
    """Create a mock httpx transport that returns a fixed response."""

    async def handler(request: httpx.Request) -> httpx.Response:
        if raise_exc is not None:
            raise raise_exc
        body = response_json if response_json is not None else SAMPLE_TRANSCRIPT
        return httpx.Response(
            status_code=status_code,
            json=body,
        )

    return httpx.MockTransport(handler)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture()
async def engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture()
async def session_factory(engine) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    yield maker


@pytest_asyncio.fixture()
async def seeded(session_factory):
    """Seed one episode + one pending chunk with a take; return session_factory."""
    wav_key = chunk_take_key(EP_ID, CHUNK_ID, TAKE_ID)

    async with session_factory() as session:
        await EpisodeRepo(session).create(
            EpisodeCreate(
                id=EP_ID,
                title="Test Episode",
                script_uri="s3://tts-harness/episodes/ep-test/script.json",
            )
        )
        chunk_repo = ChunkRepo(session)
        await chunk_repo.bulk_insert(
            [
                ChunkInput(
                    id=CHUNK_ID,
                    episode_id=EP_ID,
                    shot_id="shot01",
                    idx=0,
                    text="你好世界",
                    text_normalized="你好世界",
                    char_count=4,
                )
            ]
        )
        # Simulate P2 done: add take + set selected + set status.
        await TakeRepo(session).append(
            TakeAppend(
                id=TAKE_ID,
                chunk_id=CHUNK_ID,
                audio_uri=f"s3://tts-harness/{wav_key}",
                duration_s=0.5,
            )
        )
        await chunk_repo.set_selected_take(CHUNK_ID, TAKE_ID)
        await chunk_repo.set_status(CHUNK_ID, "synth_done")
        await session.commit()
    return session_factory


@pytest.fixture()
def storage() -> FakeStorage:
    """Pre-seed with a tiny WAV at the expected key."""
    s = FakeStorage()
    wav_key = chunk_take_key(EP_ID, CHUNK_ID, TAKE_ID)
    s.objects[wav_key] = _make_tiny_wav()
    return s


@pytest.fixture(autouse=True)
def wire_p3_deps(seeded, storage):
    """Configure p3_transcribe module-level deps and clean up after."""
    transport = _mock_transport()
    client_factory = lambda: httpx.AsyncClient(transport=transport)

    configure_p3_dependencies(
        session_factory=seeded,
        storage=storage,
        http_client_factory=client_factory,
        whisperx_url="http://test-whisperx:7860",
    )
    yield
    # Reset module globals.
    p3_module._session_factory = None
    p3_module._storage = None
    p3_module._http_client_factory = None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_happy_path(seeded, storage):
    """P3 happy path: synth_done → transcribed, transcript in MinIO."""
    result = await run_p3_transcribe(CHUNK_ID, language="zh")

    assert result.chunk_id == CHUNK_ID
    assert result.word_count == 2
    assert "transcript.json" in result.transcript_uri

    # Verify transcript uploaded to MinIO.
    transcript_key = chunk_transcript_key(EP_ID, CHUNK_ID)
    assert transcript_key in storage.objects
    stored = json.loads(storage.objects[transcript_key])
    assert len(stored["transcript"]) == 2

    # Verify chunk status changed.
    async with seeded() as session:
        chunk = await ChunkRepo(session).get(CHUNK_ID)
        assert chunk.status == "transcribed"

    # Verify events.
    async with seeded() as session:
        events = await EventRepo(session).list_since(EP_ID)
        kinds = [e.kind for e in events]
        assert "stage_started" in kinds
        assert "stage_finished" in kinds


@pytest.mark.asyncio
async def test_missing_chunk(seeded, storage):
    """P3 with nonexistent chunk raises DomainError('not_found')."""
    with pytest.raises(DomainError, match="chunk not found"):
        await run_p3_transcribe("nonexistent:chunk")


@pytest.mark.asyncio
async def test_chunk_no_selected_take(seeded, storage):
    """P3 with chunk missing selected_take_id raises DomainError."""
    # Clear selected_take_id.
    async with seeded() as session:
        await ChunkRepo(session).set_selected_take(CHUNK_ID, None)
        await session.commit()

    with pytest.raises(DomainError, match="no selected_take_id"):
        await run_p3_transcribe(CHUNK_ID)


@pytest.mark.asyncio
async def test_whisperx_503(seeded, storage):
    """WhisperX returning 503 raises HTTPStatusError (Prefect retries)."""
    transport = _mock_transport(status_code=503, response_json={"error": "overloaded"})
    configure_p3_dependencies(
        session_factory=seeded,
        storage=storage,
        http_client_factory=lambda: httpx.AsyncClient(transport=transport),
        whisperx_url="http://test-whisperx:7860",
    )

    with pytest.raises(httpx.HTTPStatusError):
        await run_p3_transcribe(CHUNK_ID)

    # Chunk status should NOT have changed.
    async with seeded() as session:
        chunk = await ChunkRepo(session).get(CHUNK_ID)
        assert chunk.status == "synth_done"


@pytest.mark.asyncio
async def test_whisperx_timeout(seeded, storage):
    """WhisperX timeout raises ReadTimeout (Prefect retries)."""
    transport = _mock_transport(raise_exc=httpx.ReadTimeout("timeout"))
    configure_p3_dependencies(
        session_factory=seeded,
        storage=storage,
        http_client_factory=lambda: httpx.AsyncClient(transport=transport),
        whisperx_url="http://test-whisperx:7860",
    )

    with pytest.raises(httpx.ReadTimeout):
        await run_p3_transcribe(CHUNK_ID)


@pytest.mark.asyncio
async def test_empty_transcript(seeded, storage):
    """WhisperX returning empty transcript list → valid P3Result with word_count=0."""
    empty_transcript = {
        "transcript": [],
        "language": "zh",
        "duration_s": 0.5,
    }
    transport = _mock_transport(response_json=empty_transcript)
    configure_p3_dependencies(
        session_factory=seeded,
        storage=storage,
        http_client_factory=lambda: httpx.AsyncClient(transport=transport),
        whisperx_url="http://test-whisperx:7860",
    )

    result = await run_p3_transcribe(CHUNK_ID)
    assert result.word_count == 0
    assert result.chunk_id == CHUNK_ID

    # chunk status should still transition to transcribed.
    async with seeded() as session:
        chunk = await ChunkRepo(session).get(CHUNK_ID)
        assert chunk.status == "transcribed"


@pytest.mark.asyncio
async def test_take_wav_missing_from_storage(seeded, storage):
    """Take WAV missing from storage → DomainError('not_found')."""
    # Remove the WAV from fake storage.
    storage.objects.clear()

    with pytest.raises(DomainError, match="take WAV missing"):
        await run_p3_transcribe(CHUNK_ID)
