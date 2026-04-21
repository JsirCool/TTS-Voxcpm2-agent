"""Audio serving route — streams WAV files from configured storage."""

import os
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

from server.api.deps import get_storage
from server.core.domain import DomainError
from server.core.runtime_mode import repo_root
from server.core.storage import LocalFSStorage, StorageBackend, storage_uri_to_key

router = APIRouter()


def _fallback_localfs_storage(uri: str) -> LocalFSStorage | None:
    parsed = urlsplit(uri)
    if parsed.scheme != "localfs":
        return None
    root = os.environ.get("HARNESS_LOCAL_STORAGE_DIR")
    if not root:
        root = str((repo_root() / ".desktop-runtime" / "data" / "storage").resolve())
    return LocalFSStorage(
        root_dir=Path(root),
        bucket=parsed.netloc or os.environ.get("MINIO_BUCKET", "tts-harness"),
    )


@router.get("/audio/{audio_key:path}")
async def serve_audio(
    audio_key: str,
    storage: StorageBackend = Depends(get_storage),
) -> StreamingResponse:
    """Stream a WAV file from storage.

    audio_key is the object key, e.g.
    episodes/ch04/chunks/ch04:shot01:1/takes/abc123.wav
    """
    # Strip s3://bucket/ prefix if present (audioUri from DB includes it)
    key = storage_uri_to_key(audio_key)

    try:
        data = await storage.download_bytes(key)
    except Exception as exc:
        fallback = _fallback_localfs_storage(audio_key)
        if fallback is None:
            raise DomainError("not_found", f"audio not found: {audio_key}") from exc
        try:
            data = await fallback.download_bytes(key)
        except Exception as fallback_exc:
            raise DomainError("not_found", f"audio not found: {audio_key}") from fallback_exc

    return StreamingResponse(
        BytesIO(data),
        media_type="audio/wav",
        headers={
            "Content-Length": str(len(data)),
            "Cache-Control": "public, max-age=3600",
        },
    )
