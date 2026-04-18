from __future__ import annotations

import asyncio
import mimetypes
import os
import tempfile
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import httpx
from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import FileResponse

from server.core.domain import DomainError, _CamelBase
from server.core.bilibili_import import (
    BilibiliDownloadTarget,
    bilibili_status,
    build_preview_url,
    guess_media_type,
    import_bilibili_media,
    import_bilibili_media_via_subprocess,
    resolve_imported_source_path,
)
from server.core.media_processing import (
    ApplyMode,
    CleanupMode,
    demucs_status,
    ffmpeg_status,
    ffprobe_status,
    process_media_with_optional_transcript,
)
from server.core.tts_presets import get_voice_source_dir

router = APIRouter(tags=["media"])

DEFAULT_WHISPERX_URL = os.environ.get("WHISPERX_URL", "http://127.0.0.1:7860")


class MediaCapabilitiesResponse(_CamelBase):
    ffmpeg: bool
    ffprobe: bool
    demucs: bool
    whisperx: bool
    bilibili_enabled: bool
    bilibili_public_only: bool
    bilibili_login_supported: bool
    ffmpeg_error: str | None = None
    ffprobe_error: str | None = None
    demucs_error: str | None = None
    whisperx_error: str | None = None
    voice_source_dir: str


class MediaProcessResponse(_CamelBase):
    relative_audio_path: str
    duration_s: float
    cleanup_mode: CleanupMode
    apply_mode: ApplyMode
    detected_text: str | None = None


class BilibiliImportRequest(_CamelBase):
    url: str
    download_target: BilibiliDownloadTarget


class BilibiliImportResponse(_CamelBase):
    source_relative_path: str
    preview_url: str
    media_type: Literal["video", "audio"]
    title: str
    owner: str | None = None
    duration_s: float
    download_target: BilibiliDownloadTarget


async def _probe_whisperx(url: str) -> tuple[bool, str | None]:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{url.rstrip('/')}/readyz")
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"

    if response.is_success:
        return True, None
    detail = response.text[:200] if response.text else f"HTTP {response.status_code}"
    return False, detail


@router.get("/media/capabilities", response_model=MediaCapabilitiesResponse)
async def get_media_capabilities() -> MediaCapabilitiesResponse:
    ffmpeg = ffmpeg_status()
    ffprobe = ffprobe_status()
    demucs = demucs_status()
    whisperx_ok, whisperx_error = await _probe_whisperx(DEFAULT_WHISPERX_URL)
    return MediaCapabilitiesResponse(
        ffmpeg=ffmpeg.available,
        ffprobe=ffprobe.available,
        demucs=demucs.available,
        whisperx=whisperx_ok,
        bilibili_enabled=bilibili_status(),
        bilibili_public_only=True,
        bilibili_login_supported=False,
        ffmpeg_error=None if ffmpeg.available else ffmpeg.detail,
        ffprobe_error=None if ffprobe.available else ffprobe.detail,
        demucs_error=None if demucs.available else demucs.detail,
        whisperx_error=whisperx_error,
        voice_source_dir=str(get_voice_source_dir()),
    )


@router.post("/media/import/bilibili", response_model=BilibiliImportResponse)
async def import_bilibili_media_route(payload: BilibiliImportRequest) -> BilibiliImportResponse:
    try:
        result = await asyncio.to_thread(
            import_bilibili_media,
            payload.url,
            download_target=payload.download_target,
        )
    except DomainError as exc:
        if exc.code != "bilibili_unavailable":
            raise
        result = await asyncio.to_thread(
            import_bilibili_media_via_subprocess,
            payload.url,
            download_target=payload.download_target,
        )
    return BilibiliImportResponse(
        source_relative_path=result.relative_source_path,
        preview_url=build_preview_url(result.relative_source_path),
        media_type=result.media_type,
        title=result.title,
        owner=result.owner,
        duration_s=result.duration_s,
        download_target=result.download_target,
    )


@router.get("/media/source")
async def get_media_source(path: str = Query(..., min_length=1)) -> FileResponse:
    source_path = resolve_imported_source_path(path)
    return FileResponse(
        source_path,
        media_type=guess_media_type(source_path),
        filename=source_path.name,
    )


@router.post("/media/process", response_model=MediaProcessResponse)
async def process_media(
    media: UploadFile | None = File(None),
    source_relative_path: str | None = Form(None),
    start_s: float = Form(...),
    end_s: float = Form(...),
    cleanup_mode: Literal["light", "vocal_isolate"] = Form(...),
    apply_mode: Literal["controllable_cloning", "ultimate_cloning"] = Form(...),
) -> MediaProcessResponse:
    if bool(media) == bool(source_relative_path):
        raise DomainError("invalid_input", "media 和 source_relative_path 必须二选一")

    if apply_mode == "ultimate_cloning":
        whisperx_ok, whisperx_error = await _probe_whisperx(DEFAULT_WHISPERX_URL)
        if not whisperx_ok:
            raise DomainError(
                "whisperx_unavailable",
                whisperx_error or "WhisperX is not ready, unable to generate prompt_text automatically",
            )

    if source_relative_path:
        source_path = resolve_imported_source_path(source_relative_path)
        result, detected_text = await process_media_with_optional_transcript(
            source_path,
            source_path.name,
            start_s=start_s,
            end_s=end_s,
            cleanup_mode=cleanup_mode,
            apply_mode=apply_mode,
            whisperx_url=DEFAULT_WHISPERX_URL,
        )
    else:
        assert media is not None
        filename = media.filename or "clip"
        suffix = Path(filename).suffix or ".bin"

        with tempfile.NamedTemporaryFile(prefix="tts-media-upload-", suffix=suffix, delete=False) as temp:
            temp_path = Path(temp.name)
            temp.write(await media.read())

        try:
            result, detected_text = await process_media_with_optional_transcript(
                temp_path,
                filename,
                start_s=start_s,
                end_s=end_s,
                cleanup_mode=cleanup_mode,
                apply_mode=apply_mode,
                whisperx_url=DEFAULT_WHISPERX_URL,
            )
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    return MediaProcessResponse(
        relative_audio_path=result.relative_audio_path,
        duration_s=result.duration_s,
        cleanup_mode=result.cleanup_mode,
        apply_mode=apply_mode,
        detected_text=detected_text,
    )
