"""Integration test for ``server.flows.tasks.p2_synth.run_p2_synth``.

Scope
-----
- Real SQLAlchemy (SQLite in-memory) so that the repositories and events
  module are exercised against the actual ORM.
- Fake MinIO storage (records uploads in-memory) — verifies we use the
  correct canonical key from ``chunk_take_key``.
- Injected fake :class:`FishTTSClient` that returns a valid (tiny) WAV
  without touching the network.

Scenarios
---------
1. Happy path → chunk transitions pending → synth_done, take row written
   with correct params, selected_take_id set, events include
   stage_started + stage_finished + take_appended.
2. Missing chunk → DomainError("not_found"), no events, no take.
3. Empty text_normalized → DomainError("invalid_input").
4. Fish 401 → FishAuthError propagates, chunk remains pending, no take,
   events include stage_started + stage_failed.
5. MinIO upload failure → original exception propagates, no take row,
   events include stage_failed.
6. Custom params dict merges with env defaults.
"""

from __future__ import annotations

import io
import struct
import wave
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from server.core.domain import ChunkInput, DomainError, EpisodeCreate, FishTTSParams
from server.core.models import Base, Chunk, Event, Take
from server.core.repositories import ChunkRepo, EpisodeRepo
from server.core.storage import chunk_take_key
from server.core.voxcpm_client import VoxCPMUnavailableError
from server.flows.tasks import p2_synth as p2_module
from server.flows.tasks.p2_synth import (
    CHUNK_CONTROL_PROMPT_OVERRIDE_KEY,
    run_p2_synth,
)

EP_ID = "ep-test"
CHUNK_ID = "ep-test:c1"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _make_tiny_wav(seconds: float = 0.1, rate: int = 16000) -> bytes:
    """Produce a valid WAV header + silent PCM frames of known duration."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        n = int(rate * seconds)
        wf.writeframes(b"\x00\x00" * n)
    return buf.getvalue()


class FakeStorage:
    """In-memory MinIO stand-in with the same async surface we use."""

    def __init__(self, bucket: str = "tts-harness") -> None:
        self._bucket = bucket
        self.uploads: dict[str, bytes] = {}
        self.fail_next_upload: Exception | None = None

    @property
    def bucket(self) -> str:
        return self._bucket

    def s3_uri(self, key: str) -> str:
        return f"s3://{self._bucket}/{key}"

    async def upload_bytes(
        self, key: str, data: bytes, content_type: str | None = None
    ) -> str:
        if self.fail_next_upload is not None:
            exc = self.fail_next_upload
            self.fail_next_upload = None
            raise exc
        self.uploads[key] = data
        return self.s3_uri(key)


class FakeVoxCPMClient:
    """Drop-in for the local P2 client used in tests.

    Supports pluggable ``response_factory`` and ``raise_exc`` so a single
    test can configure the behaviour it needs.
    """

    def __init__(
        self,
        *,
        wav_bytes: bytes | None = None,
        raise_exc: Exception | None = None,
    ) -> None:
        self._wav = wav_bytes if wav_bytes is not None else _make_tiny_wav()
        self._raise_exc = raise_exc
        self.calls: list[tuple[str, FishTTSParams]] = []

    async def synthesize(self, text: str, params: FishTTSParams) -> bytes:
        self.calls.append((text, params))
        if self._raise_exc is not None:
            raise self._raise_exc
        return self._wav

    async def aclose(self) -> None:
        return None


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
    """Seed one episode + one pending chunk; yield the session_factory."""
    async with session_factory() as session:
        ep_repo = EpisodeRepo(session)
        await ep_repo.create(
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
                    text="Hello, world.",
                    text_normalized="Hello, world.",
                    char_count=len("Hello, world."),
                )
            ]
        )
        await session.commit()
    return session_factory


@pytest.fixture()
def storage() -> FakeStorage:
    return FakeStorage()


@pytest.fixture()
def fake_voxcpm() -> FakeVoxCPMClient:
    return FakeVoxCPMClient()


@pytest.fixture(autouse=True)
def wire_p2_deps(seeded, storage, fake_voxcpm, monkeypatch):
    """Hook injected dependencies into the p2_synth module.

    ``autouse=True`` guarantees that each test starts with a freshly
    wired p2 module and leaves no globals behind.
    """
    # Clear env so build_params_from_env is predictable.
    monkeypatch.delenv("VOXCPM_REFERENCE_AUDIO_PATH", raising=False)
    monkeypatch.delenv("VOXCPM_PROMPT_AUDIO_PATH", raising=False)
    monkeypatch.delenv("VOXCPM_PROMPT_TEXT", raising=False)
    monkeypatch.delenv("VOXCPM_CONTROL_PROMPT", raising=False)
    monkeypatch.delenv("VOXCPM_CFG_VALUE", raising=False)
    monkeypatch.delenv("VOXCPM_INFERENCE_TIMESTEPS", raising=False)
    monkeypatch.delenv("VOXCPM_MAX_LEN", raising=False)
    monkeypatch.delenv("VOXCPM_NORMALIZE", raising=False)
    monkeypatch.delenv("VOXCPM_DENOISE", raising=False)

    holder = {"client": fake_voxcpm}

    def factory():
        return holder["client"]

    p2_module.configure_p2_dependencies(
        session_factory=seeded,
        storage=storage,  # type: ignore[arg-type]
        voxcpm_client_factory=factory,
    )
    yield
    # teardown: reset module globals.
    p2_module._session_factory = None
    p2_module._storage = None
    p2_module._voxcpm_client_factory = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _load_chunk(session_factory) -> Chunk:
    async with session_factory() as session:
        row = await session.get(Chunk, CHUNK_ID)
        assert row is not None
        return row


async def _list_events(session_factory) -> list[Event]:
    async with session_factory() as session:
        res = await session.execute(select(Event).order_by(Event.id))
        return list(res.scalars().all())


async def _list_takes(session_factory) -> list[Take]:
    async with session_factory() as session:
        res = await session.execute(select(Take))
        return list(res.scalars().all())


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_happy_path_transitions_chunk_and_writes_take(
    seeded, storage, fake_voxcpm
):
    result = await run_p2_synth(CHUNK_ID)

    # Result shape
    assert result.chunk_id == CHUNK_ID
    assert result.take_id
    assert result.audio_uri.startswith("s3://tts-harness/")
    assert result.audio_uri.endswith(".wav")
    assert result.duration_s > 0
    assert result.params["model"] == "voxcpm2"

    # Chunk state advanced.
    chunk = await _load_chunk(seeded)
    assert chunk.status == "synth_done"
    assert chunk.selected_take_id == result.take_id

    # Take row exists with correct key.
    takes = await _list_takes(seeded)
    assert len(takes) == 1
    take = takes[0]
    assert take.id == result.take_id
    assert take.chunk_id == CHUNK_ID
    assert take.audio_uri == result.audio_uri
    assert take.params["temperature"] == 0.7

    # MinIO received the bytes at the canonical key.
    expected_key = chunk_take_key(EP_ID, CHUNK_ID, result.take_id)
    assert expected_key in storage.uploads
    assert storage.uploads[expected_key] == fake_voxcpm._wav

    # Events: stage_started, stage_finished, take_appended.
    events = await _list_events(seeded)
    kinds = [e.kind for e in events]
    assert "stage_started" in kinds
    assert "stage_finished" in kinds
    assert "take_appended" in kinds

    finished = next(e for e in events if e.kind == "stage_finished")
    assert finished.payload["stage"] == "p2"
    assert finished.payload["take_id"] == result.take_id

    # Fish was called with the normalized text.
    assert len(fake_voxcpm.calls) == 1
    text, params = fake_voxcpm.calls[0]
    assert text == "Hello, world."
    assert isinstance(params, FishTTSParams)


async def test_missing_chunk_raises_domain_error(seeded):
    with pytest.raises(DomainError) as excinfo:
        await run_p2_synth("no-such-chunk")
    assert excinfo.value.code == "not_found"

    # No events, no takes.
    events = await _list_events(seeded)
    assert events == []
    takes = await _list_takes(seeded)
    assert takes == []


async def test_empty_text_normalized_raises_domain_error(
    seeded, session_factory
):
    # Mutate the chunk to have an empty text_normalized.
    async with session_factory() as session:
        chunk = await session.get(Chunk, CHUNK_ID)
        chunk.text_normalized = "   "
        await session.commit()

    with pytest.raises(DomainError) as excinfo:
        await run_p2_synth(CHUNK_ID)
    assert excinfo.value.code == "invalid_input"

    takes = await _list_takes(seeded)
    assert takes == []


async def test_voxcpm_unavailable_leaves_chunk_pending_and_emits_stage_failed(
    seeded, fake_voxcpm
):
    fake_voxcpm._raise_exc = VoxCPMUnavailableError(
        "service unavailable", status_code=503
    )

    with pytest.raises(VoxCPMUnavailableError):
        await run_p2_synth(CHUNK_ID)

    chunk = await _load_chunk(seeded)
    assert chunk.status == "pending"
    assert chunk.selected_take_id is None

    takes = await _list_takes(seeded)
    assert takes == []

    events = await _list_events(seeded)
    kinds = [e.kind for e in events]
    assert "stage_started" in kinds
    assert "stage_failed" in kinds
    assert "stage_finished" not in kinds


async def test_minio_upload_failure_leaves_chunk_pending(
    seeded, storage, fake_voxcpm
):
    storage.fail_next_upload = RuntimeError("minio boom")

    with pytest.raises(RuntimeError, match="minio boom"):
        await run_p2_synth(CHUNK_ID)

    # Fish was still called.
    assert len(fake_voxcpm.calls) == 1

    chunk = await _load_chunk(seeded)
    assert chunk.status == "pending"
    assert chunk.selected_take_id is None

    takes = await _list_takes(seeded)
    assert takes == []

    events = await _list_events(seeded)
    kinds = [e.kind for e in events]
    assert "stage_started" in kinds
    assert "stage_failed" in kinds


async def test_custom_params_dict_is_merged_into_call(seeded, fake_voxcpm):
    result = await run_p2_synth(
        CHUNK_ID, {"temperature": 0.2, "reference_id": "voice-x"}
    )
    _, used_params = fake_voxcpm.calls[-1]
    assert used_params.temperature == 0.2
    assert used_params.reference_id == "voice-x"
    # Result params reflect the merged view.
    assert result.params["temperature"] == 0.2
    assert result.params["reference_id"] == "voice-x"


async def test_ultimate_cloning_strips_control_prompt_and_chunk_override(
    seeded, session_factory, fake_voxcpm
):
    async with session_factory() as session:
        chunk = await session.get(Chunk, CHUNK_ID)
        assert chunk is not None
        chunk.extra_metadata = {
            CHUNK_CONTROL_PROMPT_OVERRIDE_KEY: "angry female narration",
        }
        await session.commit()

    result = await run_p2_synth(
        CHUNK_ID,
        {
            "prompt_audio_path": "111.m4a",
            "prompt_text": "hello everyone",
            "control_prompt": "stale prompt should be ignored",
        },
    )
    _, used_params = fake_voxcpm.calls[-1]
    assert used_params.prompt_audio_path == "111.m4a"
    assert used_params.prompt_text == "hello everyone"
    assert used_params.control_prompt is None
    assert result.params["control_prompt"] is None


async def test_p2_synth_task_decorator_has_voxcpm_tag_and_retries():
    """Lock in ADR-001 §4.3 contract: tag + retries are not a drive-by change."""
    from server.flows.tasks.p2_synth import p2_synth

    assert "voxcpm-local" in p2_synth.tags
    assert p2_synth.retries == 3
    assert list(p2_synth.retry_delay_seconds) == [2, 8, 32]
    assert p2_synth.name == "p2-synth"
