"""MinIO (S3-compatible) object storage wrapper.

The ``minio`` package is synchronous; we run every call through
``asyncio.to_thread`` so repositories and Prefect tasks can await it without
blocking the loop. The surface intentionally mirrors the shape that higher
layers need — no generic "list objects" or "create bucket" plumbing beyond
the bucket auto-provisioning helper.

Path helpers (``*_key`` functions) enforce the MinIO layout frozen in
ADR-002 §3.3. Callers **must** use these helpers instead of hand-crafted
strings; otherwise a future layout migration becomes a grep-and-pray.
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
from urllib.parse import quote

from minio import Minio
from minio.error import S3Error

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Path helpers (ADR-002 §3.3)
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Storage wrapper
# ---------------------------------------------------------------------------


@dataclass
class MinIOSettings:
    endpoint: str
    access_key: str
    secret_key: str
    bucket: str
    secure: bool = False


class MinIOStorage:
    """Async-friendly facade around the sync ``minio`` client.

    All I/O methods are coroutines; they delegate to ``asyncio.to_thread`` so
    we do not block the event loop. Bucket provisioning happens lazily on
    first use via :meth:`ensure_bucket`.
    """

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

    @staticmethod
    def _resolve_mirror_root(mirror_dir: str | Path | None) -> Path:
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
        except Exception:  # pragma: no cover - mirror is best-effort
            log.exception("failed to mirror MinIO object %s to %s", key, self.mirror_path(key))

    async def _mirror_file(self, key: str, path: Path) -> None:
        try:
            await asyncio.to_thread(self._copy_file_to_mirror_sync, key, path)
        except Exception:  # pragma: no cover - mirror is best-effort
            log.exception("failed to mirror local file %s to %s", path, self.mirror_path(key))

    async def _delete_mirror_key(self, key: str) -> None:
        try:
            await asyncio.to_thread(self._delete_mirror_key_sync, key)
        except Exception:  # pragma: no cover - mirror is best-effort
            log.exception("failed to delete mirrored MinIO object %s", key)

    async def _delete_mirror_prefix(self, prefix: str) -> None:
        try:
            await asyncio.to_thread(self._delete_mirror_prefix_sync, prefix)
        except Exception:  # pragma: no cover - mirror is best-effort
            log.exception("failed to delete mirrored MinIO prefix %s", prefix)

    # --- bucket lifecycle ------------------------------------------------

    async def ensure_bucket(self) -> None:
        if self._bucket_ready:
            return

        def _ensure() -> None:
            if not self._client.bucket_exists(self._bucket):
                self._client.make_bucket(self._bucket)

        await asyncio.to_thread(_ensure)
        self._bucket_ready = True

    @property
    def bucket(self) -> str:
        return self._bucket

    def s3_uri(self, key: str) -> str:
        return f"s3://{self._bucket}/{key}"

    # --- uploads ---------------------------------------------------------

    async def upload_bytes(
        self,
        key: str,
        data: bytes,
        content_type: str | None = None,
    ) -> str:
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
        return self.s3_uri(key)

    async def upload_file(self, key: str, path: Path) -> str:
        await self.ensure_bucket()
        p = Path(path)

        def _fput() -> None:
            self._client.fput_object(self._bucket, key, str(p))

        await asyncio.to_thread(_fput)
        await self._mirror_file(key, p)
        return self.s3_uri(key)

    # --- reads -----------------------------------------------------------

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

    async def get_presigned_url(
        self, key: str, expires: timedelta = timedelta(hours=1)
    ) -> str:
        await self.ensure_bucket()

        def _sign() -> str:
            return self._client.presigned_get_object(
                self._bucket, key, expires=expires
            )

        return await asyncio.to_thread(_sign)

    async def delete(self, key: str) -> None:
        await self.ensure_bucket()

        def _del() -> None:
            self._client.remove_object(self._bucket, key)

        await asyncio.to_thread(_del)
        await self._delete_mirror_key(key)

    async def get_bucket_size_bytes(self) -> int:
        """Return total size of all objects in the bucket (bytes)."""
        await self.ensure_bucket()

        def _sum() -> int:
            total = 0
            for obj in self._client.list_objects(self._bucket, recursive=True):
                total += obj.size or 0
            return total

        return await asyncio.to_thread(_sum)

    async def delete_prefix(self, prefix: str) -> int:
        """Delete all objects under *prefix*. Returns count of deleted objects."""
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
        """Backfill existing bucket objects into the local mirror directory."""
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


__all__ = [
    "MinIOSettings",
    "MinIOStorage",
    "episode_script_key",
    "chunk_take_key",
    "chunk_transcript_key",
    "chunk_subtitle_key",
    "final_wav_key",
    "final_srt_key",
    "chunk_log_key",
]
