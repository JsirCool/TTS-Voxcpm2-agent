"""Storage backends for the TTS Agent Harness.

The original project used MinIO only. Desktop mode adds a local filesystem
backend with the same async-friendly surface so higher layers can switch
storage mode without changing business logic.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import shutil
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path, PurePosixPath
from typing import Protocol, runtime_checkable
from urllib.parse import quote

from minio import Minio
from minio.error import S3Error

from server.core.runtime_mode import desktop_mode_enabled

log = logging.getLogger(__name__)


def episode_script_key(episode_id: str) -> str:
    return f"episodes/{episode_id}/script.json"


def chunk_take_key(episode_id: str, chunk_id: str, take_id: str) -> str:
    return f"episodes/{episode_id}/chunks/{chunk_id}/takes/{take_id}.wav"


def chunk_transcript_key(episode_id: str, chunk_id: str) -> str:
    return f"episodes/{episode_id}/chunks/{chunk_id}/transcript.json"


def chunk_subtitle_key(episode_id: str, chunk_id: str) -> str:
    return f"episodes/{episode_id}/chunks/{chunk_id}/subtitle.srt"


def final_wav_key(episode_id: str) -> str:
    return f"episodes/{episode_id}/final/episode.wav"


def final_srt_key(episode_id: str) -> str:
    return f"episodes/{episode_id}/final/episode.srt"


def chunk_log_key(episode_id: str, chunk_id: str, stage: str) -> str:
    return f"episodes/{episode_id}/logs/{chunk_id}/{stage}.log"


def storage_uri_to_key(uri: str) -> str:
    raw = (uri or "").strip()
    if not raw:
        return raw
    if "://" not in raw:
        return raw.lstrip("/")
    _scheme, rest = raw.split("://", 1)
    rest = rest.split("?", 1)[0].strip("/")
    parts = [part for part in PurePosixPath(rest).parts if part not in ("", ".")]
    if len(parts) <= 1:
        return ""
    return "/".join(parts[1:])


@runtime_checkable
class StorageBackend(Protocol):
    @property
    def bucket(self) -> str: ...

    async def ensure_bucket(self) -> None: ...

    async def upload_bytes(self, key: str, data: bytes, content_type: str | None = None) -> str: ...

    async def upload_file(self, key: str, path: Path) -> str: ...

    async def download_bytes(self, key: str) -> bytes: ...

    async def exists(self, key: str) -> bool: ...

    async def get_presigned_url(self, key: str, expires: timedelta = timedelta(hours=1)) -> str: ...

    async def delete(self, key: str) -> None: ...

    async def get_bucket_size_bytes(self) -> int: ...

    async def delete_prefix(self, prefix: str) -> int: ...

    async def sync_prefix_to_mirror(self, prefix: str = "") -> int: ...


class _MirrorMixin:
    def _resolve_mirror_root(self, mirror_dir: str | Path | None) -> Path:
        if mirror_dir is not None:
            return Path(mirror_dir).expanduser().resolve()
        raw = os.environ.get("HARNESS_STORAGE_MIRROR_DIR")
        if raw:
            return Path(raw).expanduser().resolve()
        return (Path(__file__).resolve().parents[2] / "storage-mirror").resolve()

    @property
    def mirror_root(self) -> Path:
        return self._mirror_root / self._bucket

    def _mirror_parts(self, key: str) -> list[str]:
        normalized = key.strip().strip("/")
        if not normalized:
            return []
        return [quote(part, safe="._-() ") for part in PurePosixPath(normalized).parts if part not in (".", "")]

    def mirror_path(self, key: str) -> Path:
        path = self.mirror_root
        for part in self._mirror_parts(key):
            path = path / part
        return path.resolve()

    def _write_mirror_bytes_sync(self, key: str, data: bytes) -> None:
        path = self.mirror_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def _copy_file_to_mirror_sync(self, key: str, source: Path) -> None:
        path = self.mirror_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, path)

    def _delete_mirror_key_sync(self, key: str) -> None:
        path = self.mirror_path(key)
        if path.exists():
            path.unlink()
        self._prune_empty_parents(path.parent)

    def _delete_mirror_prefix_sync(self, prefix: str) -> None:
        prefix_path = self.mirror_path(prefix)
        if prefix_path.is_file():
            prefix_path.unlink()
        elif prefix_path.exists():
            shutil.rmtree(prefix_path, ignore_errors=True)
        self._prune_empty_parents(prefix_path.parent)

    def _prune_empty_parents(self, start: Path) -> None:
        bucket_root = self.mirror_root
        current = start
        while current != bucket_root and current.exists():
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent

    async def _mirror_bytes(self, key: str, data: bytes) -> None:
        try:
            await asyncio.to_thread(self._write_mirror_bytes_sync, key, data)
        except Exception:  # pragma: no cover
            log.exception("failed to mirror object %s to %s", key, self.mirror_path(key))

    async def _mirror_file(self, key: str, path: Path) -> None:
        try:
            await asyncio.to_thread(self._copy_file_to_mirror_sync, key, path)
        except Exception:  # pragma: no cover
            log.exception("failed to mirror local file %s to %s", path, self.mirror_path(key))

    async def _delete_mirror_key(self, key: str) -> None:
        try:
            await asyncio.to_thread(self._delete_mirror_key_sync, key)
        except Exception:  # pragma: no cover
            log.exception("failed to delete mirrored object %s", key)

    async def _delete_mirror_prefix(self, prefix: str) -> None:
        try:
            await asyncio.to_thread(self._delete_mirror_prefix_sync, prefix)
        except Exception:  # pragma: no cover
            log.exception("failed to delete mirrored prefix %s", prefix)


@dataclass
class MinIOSettings:
    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    secure: bool = False


class MinIOStorage(_MirrorMixin):
    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        *,
        secure: bool = False,
        mirror_dir: str | Path | None = None,
    ) -> None:
        self._client = Minio(
            endpoint,
            access_key=access_key,
            secret_key=secret_key,
            secure=secure,
        )
        self._bucket = bucket
        self._bucket_ready = False
        self._mirror_root = self._resolve_mirror_root(mirror_dir)

    @property
    def bucket(self) -> str:
        return self._bucket

    def object_uri(self, key: str) -> str:
        return f"s3://{self._bucket}/{key}"

    def s3_uri(self, key: str) -> str:
        return self.object_uri(key)

    async def ensure_bucket(self) -> None:
        if self._bucket_ready:
            return

        def _ensure() -> None:
            if not self._client.bucket_exists(self._bucket):
                self._client.make_bucket(self._bucket)

        await asyncio.to_thread(_ensure)
        self._bucket_ready = True

    async def upload_bytes(self, key: str, data: bytes, content_type: str | None = None) -> str:
        await self.ensure_bucket()

        def _put() -> None:
            self._client.put_object(
                self._bucket,
                key,
                io.BytesIO(data),
                length=len(data),
                content_type=content_type or "application/octet-stream",
            )

        await asyncio.to_thread(_put)
        await self._mirror_bytes(key, data)
        return self.object_uri(key)

    async def upload_file(self, key: str, path: Path) -> str:
        await self.ensure_bucket()
        p = Path(path)

        def _fput() -> None:
            self._client.fput_object(self._bucket, key, str(p))

        await asyncio.to_thread(_fput)
        await self._mirror_file(key, p)
        return self.object_uri(key)

    async def download_bytes(self, key: str) -> bytes:
        await self.ensure_bucket()

        def _get() -> bytes:
            response = None
            try:
                response = self._client.get_object(self._bucket, key)
                return response.read()
            finally:
                if response is not None:
                    response.close()
                    response.release_conn()

        return await asyncio.to_thread(_get)

    async def exists(self, key: str) -> bool:
        await self.ensure_bucket()

        def _stat() -> bool:
            try:
                self._client.stat_object(self._bucket, key)
                return True
            except S3Error as exc:
                if exc.code in ("NoSuchKey", "NoSuchObject", "NotFound"):
                    return False
                raise

        return await asyncio.to_thread(_stat)

    async def get_presigned_url(self, key: str, expires: timedelta = timedelta(hours=1)) -> str:
        await self.ensure_bucket()

        def _sign() -> str:
            return self._client.presigned_get_object(self._bucket, key, expires=expires)

        return await asyncio.to_thread(_sign)

    async def delete(self, key: str) -> None:
        await self.ensure_bucket()

        def _del() -> None:
            self._client.remove_object(self._bucket, key)

        await asyncio.to_thread(_del)
        await self._delete_mirror_key(key)

    async def get_bucket_size_bytes(self) -> int:
        await self.ensure_bucket()

        def _sum() -> int:
            total = 0
            for obj in self._client.list_objects(self._bucket, recursive=True):
                total += obj.size or 0
            return total

        return await asyncio.to_thread(_sum)

    async def delete_prefix(self, prefix: str) -> int:
        await self.ensure_bucket()

        def _del_prefix() -> int:
            objects = list(self._client.list_objects(self._bucket, prefix=prefix, recursive=True))
            for obj in objects:
                self._client.remove_object(self._bucket, obj.object_name)
            return len(objects)

        deleted = await asyncio.to_thread(_del_prefix)
        await self._delete_mirror_prefix(prefix)
        return deleted

    async def sync_prefix_to_mirror(self, prefix: str = "") -> int:
        await self.ensure_bucket()

        def _sync() -> int:
            count = 0
            for obj in self._client.list_objects(self._bucket, prefix=prefix, recursive=True):
                path = self.mirror_path(obj.object_name)
                path.parent.mkdir(parents=True, exist_ok=True)
                self._client.fget_object(self._bucket, obj.object_name, str(path))
                count += 1
            return count

        return await asyncio.to_thread(_sync)


@dataclass
class LocalFSSettings:
    root_dir: Path
    bucket: str


class LocalFSStorage(_MirrorMixin):
    def __init__(
        self,
        root_dir: str | Path,
        bucket: str,
        *,
        mirror_dir: str | Path | None = None,
    ) -> None:
        self._root_dir = Path(root_dir).expanduser().resolve()
        self._bucket = bucket
        self._bucket_ready = False
        self._mirror_root = self._resolve_mirror_root(mirror_dir)

    @property
    def bucket(self) -> str:
        return self._bucket

    @property
    def bucket_root(self) -> Path:
        return (self._root_dir / self._bucket).resolve()

    def object_path(self, key: str) -> Path:
        path = self.bucket_root
        for part in PurePosixPath(key.strip("/")).parts:
            if part in ("", ".", ".."):
                continue
            path = path / part
        return path.resolve()

    def object_uri(self, key: str) -> str:
        return f"localfs://{self._bucket}/{key}"

    def s3_uri(self, key: str) -> str:
        return self.object_uri(key)

    async def ensure_bucket(self) -> None:
        if self._bucket_ready:
            return
        await asyncio.to_thread(self.bucket_root.mkdir, parents=True, exist_ok=True)
        self._bucket_ready = True

    async def upload_bytes(self, key: str, data: bytes, content_type: str | None = None) -> str:
        del content_type
        await self.ensure_bucket()
        path = self.object_path(key)

        def _write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

        await asyncio.to_thread(_write)
        await self._mirror_bytes(key, data)
        return self.object_uri(key)

    async def upload_file(self, key: str, path: Path) -> str:
        await self.ensure_bucket()
        source = Path(path)
        target = self.object_path(key)

        def _copy() -> None:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

        await asyncio.to_thread(_copy)
        await self._mirror_file(key, source)
        return self.object_uri(key)

    async def download_bytes(self, key: str) -> bytes:
        await self.ensure_bucket()
        path = self.object_path(key)
        return await asyncio.to_thread(path.read_bytes)

    async def exists(self, key: str) -> bool:
        await self.ensure_bucket()
        return await asyncio.to_thread(self.object_path(key).exists)

    async def get_presigned_url(self, key: str, expires: timedelta = timedelta(hours=1)) -> str:
        del expires
        await self.ensure_bucket()
        return self.object_uri(key)

    async def delete(self, key: str) -> None:
        await self.ensure_bucket()
        path = self.object_path(key)

        def _delete() -> None:
            if path.exists():
                path.unlink()

        await asyncio.to_thread(_delete)
        await self._delete_mirror_key(key)

    async def get_bucket_size_bytes(self) -> int:
        await self.ensure_bucket()

        def _sum() -> int:
            total = 0
            for candidate in self.bucket_root.rglob("*"):
                if candidate.is_file():
                    total += candidate.stat().st_size
            return total

        return await asyncio.to_thread(_sum)

    async def delete_prefix(self, prefix: str) -> int:
        await self.ensure_bucket()
        prefix_path = self.object_path(prefix)

        def _delete_prefix() -> int:
            if not prefix_path.exists():
                return 0
            if prefix_path.is_file():
                prefix_path.unlink()
                return 1
            files = [item for item in prefix_path.rglob("*") if item.is_file()]
            count = len(files)
            shutil.rmtree(prefix_path, ignore_errors=True)
            return count

        deleted = await asyncio.to_thread(_delete_prefix)
        await self._delete_mirror_prefix(prefix)
        return deleted

    async def sync_prefix_to_mirror(self, prefix: str = "") -> int:
        await self.ensure_bucket()
        prefix_path = self.object_path(prefix)

        def _sync() -> int:
            if not prefix_path.exists():
                return 0
            count = 0
            if prefix_path.is_file():
                rel_key = str(prefix).strip("/")
                self._write_mirror_bytes_sync(rel_key, prefix_path.read_bytes())
                return 1
            for candidate in prefix_path.rglob("*"):
                if not candidate.is_file():
                    continue
                relative = candidate.relative_to(self.bucket_root).as_posix()
                self._write_mirror_bytes_sync(relative, candidate.read_bytes())
                count += 1
            return count

        return await asyncio.to_thread(_sync)


def build_storage_from_env() -> StorageBackend:
    mode = os.environ.get("STORAGE_MODE", "").strip().lower()
    if not mode:
        mode = "local_fs" if desktop_mode_enabled() else "minio"

    bucket = os.environ.get("MINIO_BUCKET", "tts-harness")
    if mode == "local_fs":
        root = os.environ.get("HARNESS_LOCAL_STORAGE_DIR")
        if not root:
            root = str((Path(__file__).resolve().parents[2] / ".desktop-runtime" / "data" / "storage").resolve())
        return LocalFSStorage(
            root_dir=root,
            bucket=bucket,
        )

    return MinIOStorage(
        endpoint=os.environ.get("MINIO_ENDPOINT", "localhost:59000"),
        access_key=os.environ.get("MINIO_ACCESS_KEY", "minioadmin"),
        secret_key=os.environ.get("MINIO_SECRET_KEY", "minioadmin"),
        bucket=bucket,
        secure=os.environ.get("MINIO_SECURE", "false").lower() == "true",
    )


__all__ = [
    "StorageBackend",
    "MinIOSettings",
    "MinIOStorage",
    "LocalFSSettings",
    "LocalFSStorage",
    "build_storage_from_env",
    "storage_uri_to_key",
    "episode_script_key",
    "chunk_take_key",
    "chunk_transcript_key",
    "chunk_subtitle_key",
    "final_wav_key",
    "final_srt_key",
    "chunk_log_key",
]
