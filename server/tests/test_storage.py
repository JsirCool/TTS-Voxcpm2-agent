"""Storage wrapper tests — require docker (testcontainers MinIO)."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from .conftest import requires_docker


@requires_docker
async def test_upload_bytes_and_download(minio_client):
    key = "episodes/ep1/script.json"
    uri = await minio_client.upload_bytes(key, b'{"hello": 1}', content_type="application/json")
    assert uri == f"s3://{minio_client.bucket}/{key}"
    assert minio_client.mirror_path(key).read_bytes() == b'{"hello": 1}'

    data = await minio_client.download_bytes(key)
    assert data == b'{"hello": 1}'


@requires_docker
async def test_upload_file_roundtrip(tmp_path: Path, minio_client):
    src = tmp_path / "audio.wav"
    src.write_bytes(b"RIFFxxxxWAVE")
    key = "episodes/ep1/chunks/c1/takes/t1.wav"
    uri = await minio_client.upload_file(key, src)
    assert key in uri
    assert minio_client.mirror_path(key).read_bytes() == b"RIFFxxxxWAVE"
    data = await minio_client.download_bytes(key)
    assert data == b"RIFFxxxxWAVE"


@requires_docker
async def test_exists(minio_client):
    key = "episodes/ep1/logs/c1/p2.log"
    assert (await minio_client.exists(key)) is False
    await minio_client.upload_bytes(key, b"log\n")
    assert (await minio_client.exists(key)) is True


@requires_docker
async def test_presigned_url(minio_client):
    key = "episodes/ep1/final/episode.wav"
    await minio_client.upload_bytes(key, b"fake-wav")
    url = await minio_client.get_presigned_url(key, expires=timedelta(minutes=5))
    assert url.startswith("http://") or url.startswith("https://")
    assert minio_client.bucket in url


@requires_docker
async def test_delete(minio_client):
    key = "episodes/ep1/chunks/c1/transcript.json"
    await minio_client.upload_bytes(key, b"{}")
    assert await minio_client.exists(key)
    assert minio_client.mirror_path(key).exists()
    await minio_client.delete(key)
    assert (await minio_client.exists(key)) is False
    assert minio_client.mirror_path(key).exists() is False


@requires_docker
async def test_sync_prefix_to_mirror(minio_client):
    key = "episodes/ep-sync/chunks/c1/takes/t1.wav"
    await minio_client.upload_bytes(key, b"mirror-me")
    minio_client.mirror_path(key).unlink()

    synced = await minio_client.sync_prefix_to_mirror("episodes/ep-sync")
    assert synced >= 1
    assert minio_client.mirror_path(key).read_bytes() == b"mirror-me"


def test_path_helpers_match_adr():
    from server.core.storage import (
        chunk_log_key,
        chunk_subtitle_key,
        chunk_take_key,
        chunk_transcript_key,
        episode_script_key,
        final_srt_key,
        final_wav_key,
    )

    assert episode_script_key("ep1") == "episodes/ep1/script.json"
    assert (
        chunk_take_key("ep1", "c1", "t1")
        == "episodes/ep1/chunks/c1/takes/t1.wav"
    )
    assert chunk_transcript_key("ep1", "c1") == "episodes/ep1/chunks/c1/transcript.json"
    assert chunk_subtitle_key("ep1", "c1") == "episodes/ep1/chunks/c1/subtitle.srt"
    assert final_wav_key("ep1") == "episodes/ep1/final/episode.wav"
    assert final_srt_key("ep1") == "episodes/ep1/final/episode.srt"
    assert chunk_log_key("ep1", "c1", "p2") == "episodes/ep1/logs/c1/p2.log"


@pytest.mark.asyncio
async def test_localfs_upload_and_download(tmp_path: Path):
    from server.core.storage import LocalFSStorage

    storage = LocalFSStorage(
        root_dir=tmp_path / "storage",
        bucket="tts-harness",
        mirror_dir=tmp_path / "mirror",
    )
    key = "episodes/ep-local/script.json"
    uri = await storage.upload_bytes(key, b'{"hello": 2}')

    assert uri == "localfs://tts-harness/episodes/ep-local/script.json"
    assert await storage.exists(key) is True
    assert await storage.download_bytes(key) == b'{"hello": 2}'
    assert storage.mirror_path(key).read_bytes() == b'{"hello": 2}'


@pytest.mark.asyncio
async def test_localfs_upload_file_and_delete_prefix(tmp_path: Path):
    from server.core.storage import LocalFSStorage

    storage = LocalFSStorage(
        root_dir=tmp_path / "storage",
        bucket="tts-harness",
        mirror_dir=tmp_path / "mirror",
    )
    src = tmp_path / "sample.wav"
    src.write_bytes(b"RIFFdemoWAVE")

    await storage.upload_file("episodes/ep1/chunks/c1/takes/t1.wav", src)
    await storage.upload_bytes("episodes/ep1/chunks/c1/transcript.json", b"{}")

    deleted = await storage.delete_prefix("episodes/ep1")
    assert deleted == 2
    assert not (tmp_path / "storage" / "tts-harness" / "episodes" / "ep1").exists()


@pytest.mark.asyncio
async def test_localfs_windows_compatible_paths_support_chunk_ids_with_colons(tmp_path: Path):
    from server.core.storage import LocalFSStorage

    storage = LocalFSStorage(
        root_dir=tmp_path / "storage",
        bucket="tts-harness",
        mirror_dir=tmp_path / "mirror",
        windows_compatible_paths=True,
    )
    key = "episodes/面试/chunks/面试:shot01:1/takes/t1.wav"

    await storage.upload_bytes(key, b"voice")

    stored_parts = storage.object_path(key).relative_to(storage.bucket_root).parts
    assert stored_parts[3].startswith("~fs~")
    assert ":" not in stored_parts[3]
    assert await storage.exists(key) is True
    assert await storage.download_bytes(key) == b"voice"
    assert storage.mirror_path(key).read_bytes() == b"voice"

    storage.mirror_path(key).unlink()
    synced = await storage.sync_prefix_to_mirror("episodes/面试")
    assert synced == 1
    assert storage.mirror_path(key).read_bytes() == b"voice"


def test_storage_uri_to_key_supports_multiple_backends():
    from server.core.storage import storage_uri_to_key

    assert storage_uri_to_key("s3://tts-harness/episodes/ep1/script.json") == "episodes/ep1/script.json"
    assert storage_uri_to_key("localfs://tts-harness/episodes/ep1/script.json") == "episodes/ep1/script.json"
    assert storage_uri_to_key("episodes/ep1/script.json") == "episodes/ep1/script.json"
