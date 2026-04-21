"""Integration tests for FastAPI routes.

Uses httpx AsyncClient with in-memory SQLite. Prefect client is always mocked.
"""

from __future__ import annotations

import io
import json
import os
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from server.core.domain import ChunkInput, FishTTSParams
from server.core.bilibili_import import BilibiliImportResult
from server.core.models import Base, Event
from server.core.media_processing import (
    MediaProcessResult,
    MediaToolStatus,
    MediaWaveformResult,
    SubtitleResolveResult,
    SubtitleCue,
    TrialSynthesisResult,
)
from server.core.repositories import ChunkRepo, EpisodeRepo, EventRepo, StageRunRepo, TakeRepo
from server.core.domain import EpisodeCreate, TakeAppend


# ---------------------------------------------------------------------------
# Test-scoped app + client
# ---------------------------------------------------------------------------

_engine = None
_maker = None


async def _override_get_session() -> AsyncIterator[AsyncSession]:
    global _maker
    async with _maker() as session:
        yield session


def _override_get_storage() -> Any:
    """Return a mock storage that captures uploads."""
    storage = MagicMock()
    storage.upload_bytes = AsyncMock(return_value="s3://tts-harness/test/script.json")
    storage.ensure_bucket = AsyncMock()
    return storage


def _make_mock_prefect_client():
    """Build a mock prefect client."""
    client = AsyncMock()
    flow_run = MagicMock()
    flow_run.id = uuid4()
    client.create_flow_run_from_deployment = AsyncMock(return_value=flow_run)
    return client


async def _override_get_prefect_client() -> AsyncIterator[Any]:
    yield _make_mock_prefect_client()


@pytest_asyncio.fixture()
async def client() -> AsyncIterator[AsyncClient]:
    global _engine, _maker

    _engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    _maker = async_sessionmaker(_engine, expire_on_commit=False)

    # Import app after engine setup
    from server.api.main import app
    from server.api.deps import get_session, get_storage, get_prefect_client

    app.dependency_overrides[get_session] = _override_get_session
    app.dependency_overrides[get_storage] = _override_get_storage
    app.dependency_overrides[get_prefect_client] = _override_get_prefect_client

    transport = ASGITransport(app=app)  # type: ignore[arg-type]
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()
    await _engine.dispose()


@pytest_asyncio.fixture()
async def seeded_client(client: AsyncClient) -> AsyncClient:
    """Client with a pre-created episode + chunks."""
    # Create episode
    script = json.dumps({"title": "Test", "segments": [{"id": 1, "text": "hello"}]})
    resp = await client.post(
        "/episodes",
        data={"id": "ep-test", "title": "Test Episode"},
        files={"script": ("script.json", io.BytesIO(script.encode()), "application/json")},
    )
    assert resp.status_code == 201

    # Seed chunks via direct DB
    global _maker
    async with _maker() as session:
        chunk_repo = ChunkRepo(session)
        await chunk_repo.bulk_insert([
            ChunkInput(
                id="ep-test:shot01:0",
                episode_id="ep-test",
                shot_id="shot01",
                idx=0,
                text="hello world",
                text_normalized="hello world",
                char_count=11,
            ),
            ChunkInput(
                id="ep-test:shot01:1",
                episode_id="ep-test",
                shot_id="shot01",
                idx=1,
                text="second chunk",
                text_normalized="second chunk",
                char_count=12,
            ),
        ])
        # Seed a take
        take_repo = TakeRepo(session)
        await take_repo.append(TakeAppend(
            id="take-001",
            chunk_id="ep-test:shot01:0",
            audio_uri="s3://tts-harness/test.wav",
            duration_s=1.5,
            params={"temperature": 0.7},
        ))
        await session.commit()

    return client


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestHealthz:
    async def test_healthz(self, client: AsyncClient):
        resp = await client.get("/healthz")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


class TestAudioRoute:
    async def test_audio_route_accepts_encoded_localfs_uri(self, client: AsyncClient):
        from server.api.main import app
        from server.api.deps import get_storage

        storage = MagicMock()
        storage.download_bytes = AsyncMock(return_value=b"RIFFdemoWAVE")
        app.dependency_overrides[get_storage] = lambda: storage

        audio_uri = (
            "localfs://tts-harness/"
            "episodes/面试/chunks/面试:shot01:1/takes/"
            "tk_37a48e007bc9432daa2ae3d79891991e.wav"
        )
        resp = await client.get(f"/audio/{quote(audio_uri, safe='')}")

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.content == b"RIFFdemoWAVE"
        storage.download_bytes.assert_awaited_once_with(
            "episodes/面试/chunks/面试:shot01:1/takes/tk_37a48e007bc9432daa2ae3d79891991e.wav"
        )


    async def test_audio_route_falls_back_to_localfs_uri(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ):
        from server.api.main import app
        from server.api.deps import get_storage
        from server.core.storage import LocalFSStorage

        storage = MagicMock()
        storage.download_bytes = AsyncMock(side_effect=FileNotFoundError("missing from active backend"))
        app.dependency_overrides[get_storage] = lambda: storage

        root = tmp_path / "storage"
        monkeypatch.setenv("HARNESS_LOCAL_STORAGE_DIR", str(root))
        key = "episodes/ep/chunks/ep:shot01:1/takes/take-001.wav"
        fallback_storage = LocalFSStorage(root, "tts-harness")
        await fallback_storage.upload_bytes(key, b"RIFFfallbackWAVE")

        audio_uri = f"localfs://tts-harness/{key}"
        resp = await client.get(f"/audio/{quote(audio_uri, safe='')}")

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.content == b"RIFFfallbackWAVE"
        storage.download_bytes.assert_awaited_once_with(key)


class TestEpisodeCRUD:
    async def test_create_episode(self, client: AsyncClient):
        script = json.dumps({"title": "My Ep", "segments": []})
        resp = await client.post(
            "/episodes",
            data={"id": "ep-1", "title": "My Episode"},
            files={"script": ("s.json", io.BytesIO(script.encode()), "application/json")},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["id"] == "ep-1"
        assert data["title"] == "My Episode"
        assert data["status"] == "empty"

    async def test_create_duplicate_episode(self, client: AsyncClient):
        script = json.dumps({"title": "Dup", "segments": []})
        files = {"script": ("s.json", io.BytesIO(script.encode()), "application/json")}
        resp1 = await client.post("/episodes", data={"id": "dup"}, files=files)
        assert resp1.status_code == 201

        files2 = {"script": ("s.json", io.BytesIO(script.encode()), "application/json")}
        resp2 = await client.post("/episodes", data={"id": "dup"}, files=files2)
        assert resp2.status_code == 422
        assert resp2.json()["error"] == "invalid_input"

    async def test_create_invalid_json(self, client: AsyncClient):
        resp = await client.post(
            "/episodes",
            data={"id": "bad"},
            files={"script": ("s.json", io.BytesIO(b"not json"), "application/json")},
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_input"

    async def test_list_episodes(self, client: AsyncClient):
        script = json.dumps({"title": "X", "segments": []})
        for i in range(3):
            files = {"script": ("s.json", io.BytesIO(script.encode()), "application/json")}
            await client.post("/episodes", data={"id": f"ep-{i}"}, files=files)

        resp = await client.get("/episodes")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 3

    async def test_list_episodes_counts_verified_chunks_as_done_for_completed_episode(self, seeded_client: AsyncClient):
        global _maker
        async with _maker() as session:
            await EpisodeRepo(session).set_status("ep-test", "done")
            await ChunkRepo(session).set_status("ep-test:shot01:0", "verified")
            await ChunkRepo(session).set_status("ep-test:shot01:1", "verified")
            await session.commit()

        resp = await seeded_client.get("/episodes")
        assert resp.status_code == 200
        episodes = {item["id"]: item for item in resp.json()}
        assert episodes["ep-test"]["doneCount"] == 2

    async def test_get_episode(self, seeded_client: AsyncClient):
        resp = await seeded_client.get("/episodes/ep-test")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "ep-test"
        assert len(data["chunks"]) == 2

    async def test_get_episode_not_found(self, client: AsyncClient):
        resp = await client.get("/episodes/nope")
        assert resp.status_code == 404

    async def test_episode_detail_nested_structure(self, seeded_client: AsyncClient):
        resp = await seeded_client.get("/episodes/ep-test")
        data = resp.json()
        chunk0 = data["chunks"][0]
        assert "takes" in chunk0
        assert "stageRuns" in chunk0
        assert len(chunk0["takes"]) == 1
        assert chunk0["takes"][0]["id"] == "take-001"

    async def test_delete_episode(self, seeded_client: AsyncClient):
        resp = await seeded_client.delete("/episodes/ep-test")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

        resp2 = await seeded_client.get("/episodes/ep-test")
        assert resp2.status_code == 404

    async def test_delete_nonexistent(self, client: AsyncClient):
        resp = await client.delete("/episodes/nope")
        assert resp.status_code == 404


class TestRunEpisode:
    async def test_trigger_run(self, seeded_client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import episodes as episode_routes

        monkeypatch.setattr(
            episode_routes,
            "ensure_voxcpm_service_ready",
            AsyncMock(return_value=None),
        )

        resp = await seeded_client.post("/episodes/ep-test/run")
        assert resp.status_code == 200
        data = resp.json()
        assert "flowRunId" in data

    async def test_trigger_run_rejects_when_voxcpm_unavailable(
        self,
        seeded_client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        from server.api.routes import episodes as episode_routes

        monkeypatch.setattr(
            episode_routes,
            "ensure_voxcpm_service_ready",
            AsyncMock(side_effect=episode_routes.VoxCPMUnavailableError("service unavailable")),
        )

        resp = await seeded_client.post("/episodes/ep-test/run")

        assert resp.status_code == 409
        assert resp.json()["error"] == "voxcpm_unavailable"
        assert "VoxCPM 服务未就绪" in resp.json()["detail"]

        global _maker
        async with _maker() as session:
            episode = await EpisodeRepo(session).get("ep-test")
            assert episode is not None
            assert episode.status != "running"

    async def test_trigger_run_not_found(self, client: AsyncClient):
        resp = await client.post("/episodes/nope/run")
        assert resp.status_code == 404


class TestChunkEdit:
    async def test_edit_chunk(self, seeded_client: AsyncClient):
        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/edit",
            params={"text_normalized": "modified text"},
        )
        assert resp.status_code == 200
        assert resp.json()["updated"] == 1

        # Verify via GET
        resp2 = await seeded_client.get("/episodes/ep-test")
        chunk = resp2.json()["chunks"][0]
        assert chunk["textNormalized"] == "modified text"

    async def test_edit_chunk_not_found(self, client: AsyncClient):
        resp = await client.post(
            "/episodes/ep-test/chunks/nonexistent/edit",
            params={"text_normalized": "x"},
        )
        assert resp.status_code == 404

    async def test_edit_chunk_rejects_control_prompt_in_ultimate_cloning(
        self,
        seeded_client: AsyncClient,
    ):
        global _maker
        async with _maker() as session:
            episode = await EpisodeRepo(session).get("ep-test")
            assert episode is not None
            episode.config = {
                "prompt_audio_path": "111.m4a",
                "prompt_text": "hello everyone",
            }
            await session.commit()

        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/edit",
            params={"control_prompt": "angry female voice"},
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_input"


class TestChunkGap:
    async def test_update_and_reset_chunk_gap(self, seeded_client: AsyncClient):
        resp = await seeded_client.patch(
            "/episodes/ep-test/chunks/ep-test:shot01:0/gap",
            json={"nextGapMs": -250},
        )
        assert resp.status_code == 200
        assert resp.json()["nextGapMs"] == -250

        detail = await seeded_client.get("/episodes/ep-test")
        assert detail.status_code == 200
        assert detail.json()["chunks"][0]["nextGapMs"] == -250

        reset = await seeded_client.patch(
            "/episodes/ep-test/chunks/ep-test:shot01:0/gap",
            json={"nextGapMs": None},
        )
        assert reset.status_code == 200
        assert reset.json()["nextGapMs"] is None

    async def test_update_chunk_gap_rejects_range(self, seeded_client: AsyncClient):
        resp = await seeded_client.patch(
            "/episodes/ep-test/chunks/ep-test:shot01:0/gap",
            json={"nextGapMs": 2501},
        )
        assert resp.status_code == 422

    async def test_update_chunk_gap_rejects_last_chunk_non_null(self, seeded_client: AsyncClient):
        resp = await seeded_client.patch(
            "/episodes/ep-test/chunks/ep-test:shot01:1/gap",
            json={"nextGapMs": 100},
        )
        assert resp.status_code == 409

    async def test_gap_preview_requires_selected_takes(self, seeded_client: AsyncClient):
        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/gap-preview",
            json={"gapMs": 100},
        )
        assert resp.status_code == 409
        assert resp.json()["error"] == "invalid_state"

    async def test_episode_gap_preview_requires_selected_takes(self, seeded_client: AsyncClient):
        resp = await seeded_client.post("/episodes/ep-test/gap-preview")
        assert resp.status_code == 409
        assert resp.json()["error"] == "invalid_state"

    async def test_episode_gap_preview_returns_wav(
        self,
        seeded_client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        from server.api.routes import episodes as episode_routes

        captured: dict[str, Any] = {}

        async def _fake_render_preview_audio(
            *,
            storage: Any,
            chunk_take_pairs: list[tuple[Any, Any]],
            gap_overrides_ms: dict[str, int | None] | None = None,
        ) -> bytes:
            captured["pair_count"] = len(chunk_take_pairs)
            captured["has_storage"] = storage is not None
            captured["gap_overrides_ms"] = gap_overrides_ms
            return b"RIFFpreviewWAVE"

        monkeypatch.setattr(episode_routes, "_render_preview_audio", _fake_render_preview_audio)

        global _maker
        async with _maker() as session:
            take_repo = TakeRepo(session)
            chunk_repo = ChunkRepo(session)
            await take_repo.append(TakeAppend(
                id="take-002",
                chunk_id="ep-test:shot01:1",
                audio_uri="s3://tts-harness/test-2.wav",
                duration_s=1.2,
                params={},
            ))
            await chunk_repo.set_selected_take("ep-test:shot01:0", "take-001")
            await chunk_repo.set_selected_take("ep-test:shot01:1", "take-002")
            await session.commit()

        resp = await seeded_client.post("/episodes/ep-test/gap-preview")

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.content == b"RIFFpreviewWAVE"
        assert captured == {
            "pair_count": 2,
            "has_storage": True,
            "gap_overrides_ms": None,
        }


class TestChunkRetry:
    async def test_retry_chunk(self, seeded_client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import episodes as episode_routes

        monkeypatch.setattr(
            episode_routes,
            "ensure_voxcpm_service_ready",
            AsyncMock(return_value=None),
        )

        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/retry",
            params={"from_stage": "p2"},
        )
        assert resp.status_code == 200
        assert "flowRunId" in resp.json()

    async def test_retry_chunk_rejects_when_voxcpm_unavailable(
        self,
        seeded_client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        from server.api.routes import episodes as episode_routes

        monkeypatch.setattr(
            episode_routes,
            "ensure_voxcpm_service_ready",
            AsyncMock(side_effect=episode_routes.VoxCPMUnavailableError("service unavailable")),
        )

        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/retry",
            params={"from_stage": "p2"},
        )

        assert resp.status_code == 409
        assert resp.json()["error"] == "voxcpm_unavailable"

    async def test_retry_chunk_not_found(self, client: AsyncClient):
        resp = await client.post(
            "/episodes/nope/chunks/bad/retry",
        )
        assert resp.status_code == 404


class TestMediaRoutes:
    async def test_media_capabilities(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import media as media_routes

        monkeypatch.setattr(media_routes, "ffmpeg_status", lambda: MediaToolStatus(True, "ffmpeg"))
        monkeypatch.setattr(media_routes, "ffprobe_status", lambda: MediaToolStatus(True, "ffprobe"))
        monkeypatch.setattr(media_routes, "demucs_status", lambda: MediaToolStatus(False, "missing demucs"))
        monkeypatch.setattr(media_routes, "_probe_whisperx", AsyncMock(return_value=(True, None)))
        monkeypatch.setattr(media_routes, "_probe_voxcpm", AsyncMock(return_value=(True, None)))
        monkeypatch.setattr(media_routes, "bilibili_status", lambda: True)

        resp = await client.get("/media/capabilities")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ffmpeg"] is True
        assert data["ffprobe"] is True
        assert data["demucs"] is False
        assert data["whisperx"] is True
        assert data["voxcpm"] is True
        assert data["bilibiliEnabled"] is True
        assert data["bilibiliPublicOnly"] is True
        assert data["bilibiliLoginSupported"] is False
        assert data["demucsError"] == "missing demucs"
        assert data["voxcpmError"] is None
        assert data["bilibiliImportDir"].endswith(r"voice_sourse\imported\bilibili")

    async def test_import_bilibili_media_success(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import media as media_routes

        monkeypatch.setattr(
            media_routes,
            "import_bilibili_media",
            lambda url, download_target: BilibiliImportResult(
                absolute_path=Path(r"E:\VC\voice_sourse\imported\bilibili\BV1\video\p01.mp4"),
                relative_source_path="imported/bilibili/BV1/video/p01.mp4",
                media_type="video",
                title="Demo title",
                owner="Demo UP",
                duration_s=18.5,
                download_target=download_target,
            ),
        )

        resp = await client.post(
            "/media/import/bilibili",
            json={
                "url": "https://www.bilibili.com/video/BV1Rs411x7qR",
                "downloadTarget": "video",
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "sourceRelativePath": "imported/bilibili/BV1/video/p01.mp4",
            "absolutePath": r"E:\VC\voice_sourse\imported\bilibili\BV1\video\p01.mp4",
            "previewUrl": "/media/source?path=imported%2Fbilibili%2FBV1%2Fvideo%2Fp01.mp4",
            "mediaType": "video",
            "title": "Demo title",
            "owner": "Demo UP",
            "durationS": 18.5,
            "downloadTarget": "video",
        }

    async def test_media_source_streams_imported_file(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        from server.api.routes import media as media_routes

        source = tmp_path / "clip.wav"
        source.write_bytes(b"RIFFdemo")

        monkeypatch.setattr(media_routes, "resolve_voice_library_path", lambda path, allowed_prefixes=("imported", "assets"): source)
        monkeypatch.setattr(media_routes, "guess_media_type", lambda path: "audio/wav")

        resp = await client.get("/media/source", params={"path": "imported/demo/clip.wav"})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("audio/wav")
        assert resp.content == b"RIFFdemo"

    async def test_open_voice_source_folder(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        from server.api.routes import media as media_routes

        opened: list[Path] = []
        voice_dir = tmp_path / "voice_sourse"

        monkeypatch.setattr(media_routes, "voice_source_root", lambda: voice_dir)
        monkeypatch.setattr(media_routes, "_open_directory", lambda path: opened.append(path))

        resp = await client.post("/media/voice-source/open")

        assert resp.status_code == 200
        assert resp.json()["path"] == str(voice_dir)
        assert voice_dir.exists()
        assert opened == [voice_dir]

    async def test_open_bilibili_import_folder(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        from server.api.routes import media as media_routes

        opened: list[Path] = []
        voice_dir = tmp_path / "voice_sourse"
        bilibili_dir = voice_dir / "imported" / "bilibili"

        monkeypatch.setattr(media_routes, "voice_source_root", lambda: voice_dir)
        monkeypatch.setattr(media_routes, "_open_directory", lambda path: opened.append(path))

        resp = await client.post("/media/imported-bilibili/open")

        assert resp.status_code == 200
        assert resp.json()["path"] == str(bilibili_dir)
        assert bilibili_dir.exists()
        assert opened == [bilibili_dir]

    async def test_pick_local_media_source_defaults_to_bilibili_dir(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ):
        from server.api.routes import media as media_routes

        voice_dir = tmp_path / "voice_sourse"
        source = voice_dir / "imported" / "bilibili" / "BV1" / "video" / "p01.mp4"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b"demo-video")

        picked_dirs: list[Path] = []

        def fake_picker(initial_dir: Path) -> Path:
            picked_dirs.append(initial_dir)
            return source

        monkeypatch.setattr(media_routes, "voice_source_root", lambda: voice_dir)
        monkeypatch.setattr(media_routes, "_pick_local_media_file_tk", fake_picker)

        resp = await client.post("/media/local-file/pick")

        assert resp.status_code == 200
        assert resp.json() == {
            "sourceRelativePath": "imported/bilibili/BV1/video/p01.mp4",
            "absolutePath": str(source),
            "previewUrl": "/media/source?path=imported%2Fbilibili%2FBV1%2Fvideo%2Fp01.mp4",
            "mediaType": "video",
            "filename": "p01.mp4",
            "sizeBytes": 10,
        }
        assert picked_dirs == [voice_dir / "imported" / "bilibili"]

    async def test_media_waveform_supports_server_side_source(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import media as media_routes

        imported_source = Path(r"E:\VC\voice_sourse\imported\bilibili\BV1\audio\p01.wav")
        monkeypatch.setattr(
            media_routes,
            "resolve_voice_library_path",
            lambda path, allowed_prefixes=("imported", "assets"): imported_source,
        )
        monkeypatch.setattr(
            media_routes,
            "build_media_waveform",
            lambda path, bins=320: MediaWaveformResult(duration_s=3.2, peaks=[0.1, 0.8, 0.25]),
        )

        resp = await client.post(
            "/media/waveform",
            data={
                "source_relative_path": "imported/bilibili/BV1/audio/p01.wav",
                "bins": "3",
            },
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "durationS": 3.2,
            "bins": 3,
            "peaks": [0.1, 0.8, 0.25],
        }

    async def test_media_waveform_supports_uploaded_media(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import media as media_routes

        monkeypatch.setattr(
            media_routes,
            "build_media_waveform",
            lambda path, bins=320: MediaWaveformResult(duration_s=5.0, peaks=[0.2, 0.6]),
        )

        resp = await client.post(
            "/media/waveform",
            data={"bins": "2"},
            files={"media": ("demo.mp4", io.BytesIO(b"fake-media"), "video/mp4")},
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "durationS": 5.0,
            "bins": 2,
            "peaks": [0.2, 0.6],
        }

    async def test_media_selection_preview_supports_server_side_source(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        from server.api.routes import media as media_routes

        imported_source = Path(r"E:\VC\voice_sourse\imported\bilibili\BV1\audio\p01.wav")
        monkeypatch.setattr(
            media_routes,
            "resolve_voice_library_path",
            lambda path, allowed_prefixes=("imported", "assets"): imported_source,
        )
        monkeypatch.setattr(
            media_routes,
            "build_selection_preview_audio",
            lambda path, start_s, end_s: b"RIFFdemo",
        )

        resp = await client.post(
            "/media/selection-preview",
            data={
                "source_relative_path": "imported/bilibili/BV1/audio/p01.wav",
                "start_s": "0.5",
                "end_s": "1.7",
            },
        )

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("audio/wav")
        assert resp.content == b"RIFFdemo"

    async def test_voice_source_upload_saves_audio(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ):
        from server.api.routes import media as media_routes

        voice_dir = tmp_path / "voice_sourse"
        monkeypatch.setattr(media_routes, "voice_source_root", lambda: voice_dir)

        resp = await client.post(
            "/media/voice-source/upload",
            files={"media": ("prompt.wav", io.BytesIO(b"RIFFdemoWAVE"), "audio/wav")},
        )

        assert resp.status_code == 200
        assert resp.json()["relativeAudioPath"] == "prompt.wav"
        assert resp.json()["filename"] == "prompt.wav"
        assert (voice_dir / "prompt.wav").read_bytes() == b"RIFFdemoWAVE"

    async def test_voice_source_upload_dedupes_existing_file(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ):
        from server.api.routes import media as media_routes

        voice_dir = tmp_path / "voice_sourse"
        voice_dir.mkdir()
        (voice_dir / "prompt.wav").write_bytes(b"old")
        monkeypatch.setattr(media_routes, "voice_source_root", lambda: voice_dir)

        resp = await client.post(
            "/media/voice-source/upload",
            files={"media": ("prompt.wav", io.BytesIO(b"RIFFnewWAVE"), "audio/wav")},
        )

        assert resp.status_code == 200
        assert resp.json()["relativeAudioPath"] == "prompt-1.wav"
        assert (voice_dir / "prompt.wav").read_bytes() == b"old"
        assert (voice_dir / "prompt-1.wav").read_bytes() == b"RIFFnewWAVE"

    async def test_voice_source_upload_rejects_non_audio(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ):
        from server.api.routes import media as media_routes

        monkeypatch.setattr(media_routes, "voice_source_root", lambda: tmp_path / "voice_sourse")

        resp = await client.post(
            "/media/voice-source/upload",
            files={"media": ("notes.txt", io.BytesIO(b"not audio"), "text/plain")},
        )

        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_input"

    async def test_prompt_audio_transcribe_success(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ):
        from server.api.routes import media as media_routes

        source = tmp_path / "prompt.m4a"
        source.write_bytes(b"fake audio")
        transcribe_mock = AsyncMock(return_value="hello prompt")

        monkeypatch.setattr(media_routes, "resolve_audio_path", lambda path: source)
        monkeypatch.setattr(media_routes, "_probe_whisperx", AsyncMock(return_value=(True, None)))
        monkeypatch.setattr(media_routes, "transcribe_source_audio_for_prompt", transcribe_mock)

        resp = await client.post(
            "/media/prompt-audio/transcribe",
            json={"promptAudioPath": "voices/prompt.m4a"},
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "promptText": "hello prompt",
            "audioPath": str(source),
        }
        transcribe_mock.assert_awaited_once_with(source, whisperx_url=media_routes.DEFAULT_WHISPERX_URL)

    async def test_prompt_audio_transcribe_rejects_missing_file(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ):
        from server.api.routes import media as media_routes

        monkeypatch.setattr(media_routes, "resolve_audio_path", lambda path: tmp_path / "missing.wav")

        resp = await client.post(
            "/media/prompt-audio/transcribe",
            json={"promptAudioPath": "missing.wav"},
        )

        assert resp.status_code == 404
        assert resp.json()["error"] == "not_found"

    async def test_prompt_audio_transcribe_rejects_unavailable_whisperx(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ):
        from server.api.routes import media as media_routes

        source = tmp_path / "prompt.wav"
        source.write_bytes(b"RIFFdemo")
        transcribe_mock = AsyncMock(return_value="should not run")

        monkeypatch.setattr(media_routes, "resolve_audio_path", lambda path: source)
        monkeypatch.setattr(media_routes, "_probe_whisperx", AsyncMock(return_value=(False, "loading")))
        monkeypatch.setattr(media_routes, "transcribe_source_audio_for_prompt", transcribe_mock)

        resp = await client.post(
            "/media/prompt-audio/transcribe",
            json={"promptAudioPath": "prompt.wav"},
        )

        assert resp.status_code == 409
        assert resp.json()["error"] == "whisperx_unavailable"
        transcribe_mock.assert_not_awaited()

    async def test_media_process_success(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import media as media_routes

        monkeypatch.setattr(media_routes, "_probe_whisperx", AsyncMock(return_value=(True, None)))
        monkeypatch.setattr(
            media_routes,
            "process_media_with_optional_transcript",
            AsyncMock(
                return_value=(
                    MediaProcessResult(
                        absolute_path=Path(r"E:\VC\voice_sourse\imported\demo\clip.wav"),
                        relative_audio_path="imported/demo/clip.wav",
                        duration_s=2.4,
                        cleanup_mode="light",
                        preview_relative_path="assets/demo/processed.wav",
                        original_preview_relative_path="assets/demo/original.wav",
                        asset_relative_path="assets/demo/processed.wav",
                        selected_text="hello everyone",
                    ),
                    "hello everyone",
                )
            ),
        )

        resp = await client.post(
            "/media/process",
            data={
                "start_s": "0",
                "end_s": "2.4",
                "cleanup_mode": "light",
                "apply_mode": "ultimate_cloning",
                "asset_name": "Demo Voice",
                "selected_text": "hello everyone",
            },
            files={"media": ("demo.mp4", io.BytesIO(b"fake-media"), "video/mp4")},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["relativeAudioPath"] == "imported/demo/clip.wav"
        assert data["durationS"] == 2.4
        assert data["cleanupMode"] == "light"
        assert data["applyMode"] == "ultimate_cloning"
        assert data["detectedText"] == "hello everyone"
        assert data["previewUrl"].endswith("assets%2Fdemo%2Fprocessed.wav")
        assert data["originalPreviewUrl"].endswith("assets%2Fdemo%2Foriginal.wav")
        assert data["assetRelativePath"] == "assets/demo/processed.wav"
        assert data["selectedText"] == "hello everyone"

    async def test_media_process_supports_server_side_source(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import media as media_routes

        imported_source = Path(r"E:\VC\voice_sourse\imported\bilibili\BV1\audio\p01.wav")
        monkeypatch.setattr(media_routes, "_probe_whisperx", AsyncMock(return_value=(True, None)))
        monkeypatch.setattr(media_routes, "load_bilibili_source_sidecar", lambda _: {})
        monkeypatch.setattr(
            media_routes,
            "resolve_voice_library_path",
            lambda path, allowed_prefixes=("imported", "assets"): imported_source,
        )
        process_mock = AsyncMock(
            return_value=(
                MediaProcessResult(
                    absolute_path=Path(r"E:\VC\voice_sourse\imported\demo\clip.wav"),
                    relative_audio_path="imported/demo/clip.wav",
                    duration_s=2.4,
                    cleanup_mode="light",
                    preview_relative_path="assets/demo/processed.wav",
                    original_preview_relative_path="assets/demo/original.wav",
                    asset_relative_path="assets/demo/processed.wav",
                    selected_text="detected transcript",
                ),
                "detected transcript",
            )
        )
        monkeypatch.setattr(media_routes, "process_media_with_optional_transcript", process_mock)

        resp = await client.post(
            "/media/process",
            data={
                "source_relative_path": "imported/bilibili/BV1/audio/p01.wav",
                "start_s": "0",
                "end_s": "2.4",
                "cleanup_mode": "light",
                "apply_mode": "ultimate_cloning",
                "asset_name": "Imported Voice",
            },
        )

        assert resp.status_code == 200
        process_mock.assert_awaited_once()
        args = process_mock.await_args.args
        assert args[0] == imported_source
        assert args[1] == "p01.wav"

    async def test_media_process_rejects_dual_source_input(self, client: AsyncClient):
        resp = await client.post(
            "/media/process",
            data={
                "source_relative_path": "imported/demo/clip.wav",
                "start_s": "0",
                "end_s": "2.4",
                "cleanup_mode": "light",
                "apply_mode": "controllable_cloning",
                "asset_name": "Demo Voice",
            },
            files={"media": ("demo.mp4", io.BytesIO(b"fake-media"), "video/mp4")},
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_input"

    async def test_media_process_rejects_when_whisperx_unavailable(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch):
        from server.api.routes import media as media_routes

        monkeypatch.setattr(media_routes, "_probe_whisperx", AsyncMock(return_value=(False, "WhisperX loading")))

        resp = await client.post(
            "/media/process",
            data={
                "start_s": "0",
                "end_s": "2.4",
                "cleanup_mode": "light",
                "apply_mode": "ultimate_cloning",
                "asset_name": "Demo Voice",
            },
            files={"media": ("demo.mp4", io.BytesIO(b"fake-media"), "video/mp4")},
        )
        assert resp.status_code == 409
        assert resp.json()["error"] == "whisperx_unavailable"

    async def test_media_subtitles_resolve_prefers_bilibili_official(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        from server.api.routes import media as media_routes

        imported_source = Path(r"E:\VC\voice_sourse\imported\bilibili\BV1\audio\p01.wav")
        monkeypatch.setattr(
            media_routes,
            "resolve_voice_library_path",
            lambda path, allowed_prefixes=("imported",): imported_source,
        )
        monkeypatch.setattr(
            media_routes,
            "resolve_bilibili_official_subtitles",
            lambda _: (
                "zh",
                [{"id": "cue_001", "start_s": 0.0, "end_s": 1.2, "text": "大家好"}],
            ),
        )

        resp = await client.post(
            "/media/subtitles/resolve",
            data={"source_relative_path": "imported/bilibili/BV1/audio/p01.wav"},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "sourceType": "bilibili_official",
            "language": "zh",
            "cues": [{"id": "cue_001", "startS": 0.0, "endS": 1.2, "text": "大家好"}],
        }

    async def test_media_subtitles_resolve_requires_confirmation_before_whisperx(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        from server.api.routes import media as media_routes

        imported_source = Path(r"E:\VC\voice_sourse\imported\bilibili\BV1\audio\p01.wav")
        monkeypatch.setattr(
            media_routes,
            "resolve_voice_library_path",
            lambda path, allowed_prefixes=("imported",): imported_source,
        )
        monkeypatch.setattr(media_routes, "resolve_bilibili_official_subtitles", lambda _: None)

        resp = await client.post(
            "/media/subtitles/resolve",
            data={"source_relative_path": "imported/bilibili/BV1/audio/p01.wav"},
        )
        assert resp.status_code == 409
        assert resp.json()["error"] == "subtitle_requires_whisperx"
        assert "WhisperX" in resp.json()["detail"]

    async def test_media_subtitles_resolve_falls_back_to_whisperx_when_confirmed(
        self,
        client: AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ):
        from server.api.routes import media as media_routes

        imported_source = Path(r"E:\VC\voice_sourse\imported\bilibili\BV1\audio\p01.wav")
        monkeypatch.setattr(
            media_routes,
            "resolve_voice_library_path",
            lambda path, allowed_prefixes=("imported",): imported_source,
        )
        monkeypatch.setattr(media_routes, "resolve_bilibili_official_subtitles", lambda _: None)
        monkeypatch.setattr(media_routes, "_probe_whisperx", AsyncMock(return_value=(True, None)))
        monkeypatch.setattr(
            media_routes,
            "resolve_whisperx_subtitles",
            AsyncMock(
                return_value=SubtitleResolveResult(
                    source_type="whisperx_generated",
                    language="zh",
                    cues=[SubtitleCue(id="cue_001", start_s=0.0, end_s=1.1, text="你好")],
                )
            ),
        )

        resp = await client.post(
            "/media/subtitles/resolve",
            data={
                "source_relative_path": "imported/bilibili/BV1/audio/p01.wav",
                "allow_whisperx": "true",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["sourceType"] == "whisperx_generated"
        assert resp.json()["cues"][0]["text"] == "你好"

    async def test_media_trial_synthesis_success(self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        from server.api.routes import media as media_routes

        asset_path = tmp_path / "processed.wav"
        asset_path.write_bytes(b"RIFFdemo")
        monkeypatch.setattr(
            media_routes,
            "resolve_voice_library_path",
            lambda path, allowed_prefixes=("assets",): asset_path,
        )
        monkeypatch.setattr(
            media_routes,
            "_build_trial_config",
            lambda apply_mode, asset_relative_path, prompt_text, base_config: FishTTSParams(),
        )

        class _FakeClient:
            def __init__(self, *, url: str):
                self.url = url

            async def synthesize(self, text: str, params):
                return b"RIFFdemo"

            async def aclose(self):
                return None

        monkeypatch.setattr(media_routes, "VoxCPMClient", _FakeClient)

        def _fake_write_trial_audio(asset_relative_path, audio_bytes, apply_mode):
            return TrialSynthesisResult(
                absolute_path=Path(r"E:\VC\voice_sourse\assets\demo\trial.wav"),
                relative_audio_path="assets/demo/trial.wav",
                preview_relative_path="assets/demo/trial.wav",
                duration_s=3.2,
                sample_text="",
            )

        monkeypatch.setattr(
            media_routes,
            "write_trial_audio",
            _fake_write_trial_audio,
        )

        resp = await client.post(
            "/media/trial-synthesis",
            json={
                "applyMode": "ultimate_cloning",
                "assetRelativePath": "assets/demo/processed.wav",
                "promptText": "大家好，欢迎来到这里。",
                "baseConfig": {"cfg_value": 2.0, "inference_timesteps": 10},
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "trialAudioPath": "assets/demo/trial.wav",
            "trialPreviewUrl": "/media/source?path=assets%2Fdemo%2Ftrial.wav",
            "durationS": 3.2,
            "sampleText": media_routes.TRIAL_SAMPLE_TEXT,
        }


class TestManualReviewConfirm:
    async def test_confirm_review_marks_chunk_verified(self, seeded_client: AsyncClient):
        global _maker
        async with _maker() as session:
            await ChunkRepo(session).set_status("ep-test:shot01:0", "needs_review")
            await session.commit()

        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/confirm-review",
        )
        assert resp.status_code == 200
        assert resp.json() == {"confirmed": True, "status": "verified"}

        resp2 = await seeded_client.get("/episodes/ep-test")
        chunk = next(item for item in resp2.json()["chunks"] if item["id"] == "ep-test:shot01:0")
        assert chunk["status"] == "verified"

        async with _maker() as session:
            stmt = (
                select(Event)
                .where(Event.episode_id == "ep-test")
                .where(Event.chunk_id == "ep-test:shot01:0")
                .where(Event.kind == "review_reset")
                .order_by(Event.id.desc())
            )
            result = await session.execute(stmt)
            event = result.scalars().first()
            assert event is not None
            assert event.payload["confirmed_manually"] is True

    async def test_confirm_review_rejects_non_review_chunk(self, seeded_client: AsyncClient):
        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/confirm-review",
        )
        assert resp.status_code == 409
        assert resp.json()["error"] == "invalid_state"


class TestFinalizeTake:
    async def test_finalize_take(self, seeded_client: AsyncClient):
        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/finalize-take",
            params={"take_id": "take-001"},
        )
        assert resp.status_code == 200
        assert "flowRunId" in resp.json()

    async def test_finalize_take_not_found(self, seeded_client: AsyncClient):
        resp = await seeded_client.post(
            "/episodes/ep-test/chunks/ep-test:shot01:0/finalize-take",
            params={"take_id": "nonexistent-take"},
        )
        assert resp.status_code == 404


class TestAuth:
    async def test_dev_mode_no_token_passes(self, client: AsyncClient):
        """When HARNESS_API_TOKEN is not set, all requests pass."""
        resp = await client.get("/healthz")
        assert resp.status_code == 200

    async def test_valid_token_passes(self):
        """When HARNESS_API_TOKEN is set and correct token is provided."""
        global _engine, _maker

        _engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
        async with _engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        _maker = async_sessionmaker(_engine, expire_on_commit=False)

        from server.api.main import app
        from server.api.deps import get_session, get_storage, get_prefect_client

        app.dependency_overrides[get_session] = _override_get_session
        app.dependency_overrides[get_storage] = _override_get_storage
        app.dependency_overrides[get_prefect_client] = _override_get_prefect_client

        transport = ASGITransport(app=app)  # type: ignore[arg-type]

        with patch.dict(os.environ, {"HARNESS_API_TOKEN": "test-secret"}):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.get(
                    "/healthz",
                    headers={"Authorization": "Bearer test-secret"},
                )
                assert resp.status_code == 200

        app.dependency_overrides.clear()
        await _engine.dispose()

    async def test_wrong_token_rejected(self):
        """When HARNESS_API_TOKEN is set but wrong token provided → 401."""
        global _engine, _maker

        _engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
        async with _engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        _maker = async_sessionmaker(_engine, expire_on_commit=False)

        from server.api.main import app
        from server.api.deps import get_session, get_storage, get_prefect_client

        app.dependency_overrides[get_session] = _override_get_session
        app.dependency_overrides[get_storage] = _override_get_storage
        app.dependency_overrides[get_prefect_client] = _override_get_prefect_client

        transport = ASGITransport(app=app)  # type: ignore[arg-type]

        with patch.dict(os.environ, {"HARNESS_API_TOKEN": "real-secret"}):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.get(
                    "/healthz",
                    headers={"Authorization": "Bearer wrong-token"},
                )
                assert resp.status_code == 401
                assert resp.json()["error"] == "unauthorized"

        app.dependency_overrides.clear()
        await _engine.dispose()

    async def test_missing_token_rejected(self):
        """When HARNESS_API_TOKEN is set but no header → 401."""
        global _engine, _maker

        _engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
        async with _engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        _maker = async_sessionmaker(_engine, expire_on_commit=False)

        from server.api.main import app
        from server.api.deps import get_session, get_storage, get_prefect_client

        app.dependency_overrides[get_session] = _override_get_session
        app.dependency_overrides[get_storage] = _override_get_storage
        app.dependency_overrides[get_prefect_client] = _override_get_prefect_client

        transport = ASGITransport(app=app)  # type: ignore[arg-type]

        with patch.dict(os.environ, {"HARNESS_API_TOKEN": "real-secret"}):
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.get("/healthz")
                assert resp.status_code == 401

        app.dependency_overrides.clear()
        await _engine.dispose()


# ---------------------------------------------------------------------------
# Duplicate endpoint
# ---------------------------------------------------------------------------


class TestDuplicateEpisode:
    async def test_duplicate_episode(self, seeded_client: AsyncClient):
        # Override storage to support download_bytes for the duplicate flow
        from server.api.main import app
        from server.api.deps import get_storage

        mock_storage = MagicMock()
        script_content = json.dumps({"title": "Test", "segments": [{"id": 1, "text": "hello"}]})
        mock_storage.download_bytes = AsyncMock(return_value=script_content.encode())
        mock_storage.upload_bytes = AsyncMock(return_value="s3://tts-harness/episodes/ep-copy/script.json")
        mock_storage.ensure_bucket = AsyncMock()
        app.dependency_overrides[get_storage] = lambda: mock_storage

        resp = await seeded_client.post(
            "/episodes/ep-test/duplicate",
            json={"new_id": "ep-copy"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["id"] == "ep-copy"
        assert data["title"] == "Test Episode"
        assert data["status"] == "empty"

        # Verify the new episode exists
        resp2 = await seeded_client.get("/episodes/ep-copy")
        assert resp2.status_code == 200

    async def test_duplicate_reads_script_from_storage_mirror(self, seeded_client: AsyncClient, tmp_path: Path):
        from server.api.main import app
        from server.api.deps import get_storage

        mirror_root = tmp_path / "mirror"
        mirror_script = mirror_root / "tts-harness" / "episodes" / "ep-test" / "script.json"
        mirror_script.parent.mkdir(parents=True)
        script_content = json.dumps({"title": "Mirror", "segments": [{"id": 1, "text": "hello"}]}).encode()
        mirror_script.write_bytes(script_content)

        mock_storage = MagicMock()
        mock_storage.bucket = "tts-harness"
        mock_storage.download_bytes = AsyncMock(side_effect=FileNotFoundError("missing primary script"))
        mock_storage.upload_bytes = AsyncMock(return_value="s3://tts-harness/episodes/ep-copy/script.json")
        mock_storage.ensure_bucket = AsyncMock()
        app.dependency_overrides[get_storage] = lambda: mock_storage

        with patch.dict(os.environ, {"HARNESS_STORAGE_MIRROR_DIR": str(mirror_root), "MINIO_BUCKET": "tts-harness"}):
            resp = await seeded_client.post(
                "/episodes/ep-test/duplicate",
                json={"new_id": "ep-copy"},
            )

        assert resp.status_code == 201
        mock_storage.upload_bytes.assert_awaited_once_with(
            "episodes/ep-copy/script.json",
            script_content,
            "application/json",
        )

    async def test_duplicate_mirrors_script_to_desktop_localfs(self, seeded_client: AsyncClient, tmp_path: Path):
        from server.api.main import app
        from server.api.deps import get_storage

        script_content = json.dumps({"title": "Local", "segments": [{"id": 1, "text": "hello"}]}).encode()
        local_root = tmp_path / "local-storage"

        mock_storage = MagicMock()
        mock_storage.bucket = "tts-harness"
        mock_storage.download_bytes = AsyncMock(return_value=script_content)
        mock_storage.upload_bytes = AsyncMock(return_value="s3://tts-harness/episodes/ep-copy/script.json")
        mock_storage.ensure_bucket = AsyncMock()
        app.dependency_overrides[get_storage] = lambda: mock_storage

        with patch.dict(
            os.environ,
            {
                "HARNESS_DESKTOP_MODE": "1",
                "HARNESS_LOCAL_STORAGE_DIR": str(local_root),
                "MINIO_BUCKET": "tts-harness",
            },
        ):
            resp = await seeded_client.post(
                "/episodes/ep-test/duplicate",
                json={"new_id": "ep-copy"},
            )

        assert resp.status_code == 201
        target = local_root / "tts-harness" / "episodes" / "ep-copy" / "script.json"
        assert target.read_bytes() == script_content

    async def test_duplicate_not_found(self, client: AsyncClient):
        resp = await client.post(
            "/episodes/nope/duplicate",
            json={"new_id": "ep-copy"},
        )
        assert resp.status_code == 404

    async def test_duplicate_conflict(self, seeded_client: AsyncClient):
        from server.api.main import app
        from server.api.deps import get_storage

        mock_storage = MagicMock()
        mock_storage.download_bytes = AsyncMock(return_value=b'{"title":"T","segments":[]}')
        mock_storage.upload_bytes = AsyncMock(return_value="s3://tts-harness/test/script.json")
        mock_storage.ensure_bucket = AsyncMock()
        app.dependency_overrides[get_storage] = lambda: mock_storage

        # ep-test already exists — using it as new_id should fail
        resp = await seeded_client.post(
            "/episodes/ep-test/duplicate",
            json={"new_id": "ep-test"},
        )
        assert resp.status_code == 422
        assert resp.json()["error"] == "invalid_input"


# ---------------------------------------------------------------------------
# Archive endpoint
# ---------------------------------------------------------------------------


class TestArchiveEpisode:
    async def test_archive_episode(self, seeded_client: AsyncClient):
        resp = await seeded_client.post("/episodes/ep-test/archive")
        assert resp.status_code == 200
        data = resp.json()
        assert "archivedAt" in data
        assert data["archivedAt"] is not None

    async def test_archive_not_found(self, client: AsyncClient):
        resp = await client.post("/episodes/nope/archive")
        assert resp.status_code == 404

    async def test_archived_excluded_from_list(self, seeded_client: AsyncClient):
        # Archive the episode
        await seeded_client.post("/episodes/ep-test/archive")
        # List should exclude archived
        resp = await seeded_client.get("/episodes")
        assert resp.status_code == 200
        ids = [ep["id"] for ep in resp.json()]
        assert "ep-test" not in ids


# ---------------------------------------------------------------------------
# Chunk log endpoint
# ---------------------------------------------------------------------------


class TestChunkLog:
    async def test_get_chunk_log(self, seeded_client: AsyncClient):
        # Seed a stage_run with log_uri
        global _maker
        async with _maker() as session:
            sr_repo = StageRunRepo(session)
            await sr_repo.upsert(
                chunk_id="ep-test:shot01:0",
                stage="p2",
                status="ok",
                log_uri="s3://tts-harness/episodes/ep-test/logs/ep-test:shot01:0/p2.log",
            )
            await session.commit()

        # Override storage to return log content
        from server.api.main import app
        from server.api.deps import get_storage

        mock_storage = MagicMock()
        mock_storage.download_bytes = AsyncMock(return_value=b"[INFO] P2 synth started\n[INFO] P2 synth done")
        mock_storage.ensure_bucket = AsyncMock()
        app.dependency_overrides[get_storage] = lambda: mock_storage

        resp = await seeded_client.get(
            "/episodes/ep-test/chunks/ep-test:shot01:0/log",
            params={"stage": "p2"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["stage"] == "p2"
        assert data["chunkId"] == "ep-test:shot01:0"
        assert "P2 synth" in data["content"]

    async def test_get_chunk_log_no_stage_run(self, seeded_client: AsyncClient):
        resp = await seeded_client.get(
            "/episodes/ep-test/chunks/ep-test:shot01:0/log",
            params={"stage": "p5"},
        )
        assert resp.status_code == 404

    async def test_get_chunk_log_chunk_not_found(self, client: AsyncClient):
        resp = await client.get(
            "/episodes/ep-test/chunks/nonexistent/log",
            params={"stage": "p2"},
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Episode logs endpoint
# ---------------------------------------------------------------------------


class TestEpisodeLogs:
    async def test_get_episode_logs(self, seeded_client: AsyncClient):
        # Events were already created by create_episode in seeded_client
        resp = await seeded_client.get("/episodes/ep-test/logs")
        assert resp.status_code == 200
        data = resp.json()
        assert "lines" in data
        assert len(data["lines"]) >= 1
        # Should contain the episode_created event
        assert any("episode_created" in line for line in data["lines"])

    async def test_get_episode_logs_tail(self, seeded_client: AsyncClient):
        resp = await seeded_client.get("/episodes/ep-test/logs", params={"tail": 1})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["lines"]) <= 1

    async def test_get_episode_logs_not_found(self, client: AsyncClient):
        resp = await client.get("/episodes/nope/logs")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Error handling tests
# ---------------------------------------------------------------------------


class TestErrorHandling:
    """Verify that errors return structured JSON, not bare 500."""

    async def test_legacy_status_compat(self, seeded_client: AsyncClient):
        """DB has 'transcribed' status → API maps to 'verified', no 500."""
        global _maker
        async with _maker() as session:
            chunk_repo = ChunkRepo(session)
            # Directly set legacy status in DB
            from sqlalchemy import text
            await session.execute(
                text("UPDATE chunks SET status = 'transcribed' WHERE id = 'ep-test:shot01:0'")
            )
            await session.commit()

        resp = await seeded_client.get("/episodes/ep-test")
        assert resp.status_code == 200
        data = resp.json()
        chunk = next(c for c in data["chunks"] if c["id"] == "ep-test:shot01:0")
        assert chunk["status"] == "verified"  # mapped, not 'transcribed'

    async def test_not_found_returns_json(self, client: AsyncClient):
        """DomainError(not_found) → 404 with structured JSON."""
        resp = await client.get("/episodes/nonexistent-episode-xyz")
        assert resp.status_code == 404
        data = resp.json()
        assert data["error"] == "not_found"
        assert "detail" in data

    async def test_global_exception_handler(self, client: AsyncClient):
        """Unhandled exceptions → 500 with JSON body, not bare text."""
        # Trigger by requesting an episode with broken DB state
        # We use a mock that raises an unexpected exception
        from server.api.main import app
        from server.api.deps import get_session

        async def _broken_session():
            raise RuntimeError("simulated DB crash")

        app.dependency_overrides[get_session] = _broken_session
        try:
            resp = await client.get("/episodes/anything")
            assert resp.status_code == 500
            data = resp.json()
            assert data["error"] == "internal"
            assert "RuntimeError" in data["detail"]
        finally:
            app.dependency_overrides.pop(get_session, None)
