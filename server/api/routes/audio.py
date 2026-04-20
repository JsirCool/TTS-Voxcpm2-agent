"""Audio serving route — streams WAV files from MinIO."""

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from io import BytesIO

from server.api.deps import get_storage
from server.core.domain import DomainError
from server.core.storage import StorageBackend, storage_uri_to_key

router = APIRouter()


@router.get("/audio/{audio_key:path}")
async def serve_audio(
    audio_key: str,
    storage: StorageBackend = Depends(get_storage),
) -> StreamingResponse:
    """Stream a WAV file from MinIO.

    audio_key is the MinIO object key, e.g.
    episodes/ch04/chunks/ch04:shot01:1/takes/abc123.wav
    """
    # Strip s3://bucket/ prefix if present (audioUri from DB includes it)
    key = storage_uri_to_key(audio_key)

    try:
        data = await storage.download_bytes(key)
    except Exception:
        raise DomainError("not_found", f"audio not found: {audio_key}")

    return StreamingResponse(
        BytesIO(data),
        media_type="audio/wav",
        headers={
            "Content-Length": str(len(data)),
            "Cache-Control": "public, max-age=3600",
        },
    )
