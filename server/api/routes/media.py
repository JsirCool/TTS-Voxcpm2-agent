from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import Field

from server.core.bilibili_import import (
    BilibiliDownloadTarget,
    bilibili_status,
    build_preview_url,
    guess_media_type,
    import_bilibili_media,
    import_bilibili_media_via_subprocess,
    load_bilibili_source_sidecar,
    resolve_bilibili_official_subtitles,
)
from server.core.domain import DomainError, FishTTSParams, _CamelBase
from server.core.media_processing import (
    ApplyMode,
    CleanupMode,
    SubtitleCue,
    demucs_status,
    ffmpeg_status,
    ffprobe_status,
    process_media_with_optional_transcript,
    resolve_voice_library_path,
    resolve_whisperx_subtitles,
    voice_source_root,
    write_trial_audio,
    write_voice_asset_metadata,
)
from server.core.tts_presets import normalize_tts_config, validate_tts_config
from server.core.voxcpm_client import (
    DEFAULT_VOXCPM_URL,
    VoxCPMClient,
    VoxCPMClientError,
    VoxCPMServerError,
    VoxCPMUnavailableError,
)

router = APIRouter(tags=["media"])

DEFAULT_WHISPERX_URL = os.environ.get("WHISPERX_URL", "http://127.0.0.1:7860")
TRIAL_SAMPLE_TEXT = (
    "欢迎来到姜Sir的TTS工作台，如果觉得好用，请去GitHub给我点个star，"
    "你的支持是我继续前进的动力"
)


class MediaCapabilitiesResponse(_CamelBase):
    ffmpeg: bool
    ffprobe: bool
    demucs: bool
    whisperx: bool
    bilibili_enabled: bool
    bilibili_public_only: bool
    bilibili_login_supported: bool
    official_subtitles: bool
    subtitle_resolver: bool
    trial_synthesis: bool
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
    preview_url: str
    original_preview_url: str
    asset_relative_path: str
    selected_text: str


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


class SubtitleCueResponse(_CamelBase):
    id: str
    start_s: float
    end_s: float
    text: str


class SubtitleResolveResponse(_CamelBase):
    source_type: Literal["bilibili_official", "whisperx_generated"]
    language: str
    cues: list[SubtitleCueResponse]


class TrialSynthesisRequest(_CamelBase):
    apply_mode: ApplyMode
    asset_relative_path: str
    prompt_text: str | None = None
    base_config: dict[str, Any] = Field(default_factory=dict)


class TrialSynthesisResponse(_CamelBase):
    trial_audio_path: str
    trial_preview_url: str
    duration_s: float
    sample_text: str


async def _probe_service(url: str, path: str) -> tuple[bool, str | None]:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{url.rstrip('/')}{path}")
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"
    if response.is_success:
        return True, None
    detail = response.text[:200] if response.text else f"HTTP {response.status_code}"
    return False, detail


async def _probe_whisperx(url: str) -> tuple[bool, str | None]:
    return await _probe_service(url, "/readyz")


async def _probe_voxcpm(url: str) -> tuple[bool, str | None]:
    return await _probe_service(url, "/healthz")


def _subtitle_cues_to_response(cues: list[SubtitleCue]) -> list[SubtitleCueResponse]:
    return [
        SubtitleCueResponse(
            id=cue.id,
            start_s=cue.start_s,
            end_s=cue.end_s,
            text=cue.text,
        )
        for cue in cues
    ]


def _dict_cues_to_response(cues: list[dict[str, Any]]) -> list[SubtitleCueResponse]:
    return [
        SubtitleCueResponse(
            id=str(item["id"]),
            start_s=float(item["start_s"]),
            end_s=float(item["end_s"]),
            text=str(item["text"]),
        )
        for item in cues
    ]


def _describe_source_metadata(
    *,
    source_relative_path: str | None,
    uploaded_filename: str | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceRelativePath": source_relative_path,
        "uploadedFilename": uploaded_filename,
    }
    if source_relative_path and source_relative_path.startswith("imported/bilibili/"):
        payload["sourceType"] = "bilibili_link"
        sidecar = load_bilibili_source_sidecar(source_relative_path) or {}
        payload["sourceTitle"] = sidecar.get("title")
        payload["owner"] = sidecar.get("owner")
        payload["bvid"] = sidecar.get("bvid")
        payload["cid"] = sidecar.get("cid")
        payload["subtitleTracks"] = sidecar.get("subtitleTracks") or []
    else:
        payload["sourceType"] = "local_file"
        payload["sourceTitle"] = uploaded_filename or source_relative_path
    return payload


def _build_trial_config(
    *,
    apply_mode: ApplyMode,
    asset_relative_path: str,
    prompt_text: str,
    base_config: dict[str, Any],
) -> FishTTSParams:
    config = dict(base_config or {})
    if apply_mode == "controllable_cloning":
        config["reference_audio_path"] = asset_relative_path
        config.pop("prompt_audio_path", None)
        config.pop("prompt_text", None)
    else:
        config["prompt_audio_path"] = asset_relative_path
        config["prompt_text"] = prompt_text.strip()
        config.pop("reference_audio_path", None)
        config.pop("control_prompt", None)

    cleaned = validate_tts_config(normalize_tts_config(config))
    return FishTTSParams(**cleaned)


@router.get("/media/capabilities", response_model=MediaCapabilitiesResponse)
async def get_media_capabilities() -> MediaCapabilitiesResponse:
    ffmpeg = ffmpeg_status()
    ffprobe = ffprobe_status()
    demucs = demucs_status()
    whisperx_ok, whisperx_error = await _probe_whisperx(DEFAULT_WHISPERX_URL)
    voxcpm_ok, _voxcpm_error = await _probe_voxcpm(DEFAULT_VOXCPM_URL)
    bilibili_enabled = bilibili_status()

    return MediaCapabilitiesResponse(
        ffmpeg=ffmpeg.available,
        ffprobe=ffprobe.available,
        demucs=demucs.available,
        whisperx=whisperx_ok,
        bilibili_enabled=bilibili_enabled,
        bilibili_public_only=True,
        bilibili_login_supported=False,
        official_subtitles=bilibili_enabled,
        subtitle_resolver=bilibili_enabled or whisperx_ok,
        trial_synthesis=voxcpm_ok,
        ffmpeg_error=None if ffmpeg.available else ffmpeg.detail,
        ffprobe_error=None if ffprobe.available else ffprobe.detail,
        demucs_error=None if demucs.available else demucs.detail,
        whisperx_error=whisperx_error,
        voice_source_dir=str(voice_source_root()),
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
    source_path = resolve_voice_library_path(path, allowed_prefixes=("imported", "assets"))
    return FileResponse(
        source_path,
        media_type=guess_media_type(source_path),
        filename=source_path.name,
    )


@router.post("/media/subtitles/resolve", response_model=SubtitleResolveResponse)
async def resolve_subtitles(
    media: UploadFile | None = File(None),
    source_relative_path: str | None = Form(None),
) -> SubtitleResolveResponse:
    if bool(media) == bool(source_relative_path):
        raise DomainError("invalid_input", "media 和 source_relative_path 必须二选一")

    if source_relative_path:
        source_path = resolve_voice_library_path(source_relative_path, allowed_prefixes=("imported",))
        if source_relative_path.startswith("imported/bilibili/"):
            official = await asyncio.to_thread(resolve_bilibili_official_subtitles, source_relative_path)
            if official is not None:
                language, cues = official
                return SubtitleResolveResponse(
                    source_type="bilibili_official",
                    language=language,
                    cues=_dict_cues_to_response(cues),
                )

        whisperx_ok, whisperx_error = await _probe_whisperx(DEFAULT_WHISPERX_URL)
        if not whisperx_ok:
            raise DomainError(
                "whisperx_unavailable",
                whisperx_error or "WhisperX 未就绪，无法生成字幕",
            )

        result = await resolve_whisperx_subtitles(source_path, whisperx_url=DEFAULT_WHISPERX_URL)
        return SubtitleResolveResponse(
            source_type=result.source_type,
            language=result.language,
            cues=_subtitle_cues_to_response(result.cues),
        )

    assert media is not None
    filename = media.filename or "clip"
    suffix = Path(filename).suffix or ".bin"
    with tempfile.NamedTemporaryFile(prefix="tts-subtitle-upload-", suffix=suffix, delete=False) as temp:
        temp_path = Path(temp.name)
        temp.write(await media.read())
    try:
        whisperx_ok, whisperx_error = await _probe_whisperx(DEFAULT_WHISPERX_URL)
        if not whisperx_ok:
            raise DomainError(
                "whisperx_unavailable",
                whisperx_error or "WhisperX 未就绪，无法生成字幕",
            )
        result = await resolve_whisperx_subtitles(temp_path, whisperx_url=DEFAULT_WHISPERX_URL)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass

    return SubtitleResolveResponse(
        source_type=result.source_type,
        language=result.language,
        cues=_subtitle_cues_to_response(result.cues),
    )


@router.post("/media/process", response_model=MediaProcessResponse)
async def process_media(
    media: UploadFile | None = File(None),
    source_relative_path: str | None = Form(None),
    start_s: float = Form(...),
    end_s: float = Form(...),
    cleanup_mode: Literal["light", "vocal_isolate"] = Form(...),
    apply_mode: Literal["controllable_cloning", "ultimate_cloning"] = Form(...),
    asset_name: str = Form(...),
    selected_text: str = Form(""),
) -> MediaProcessResponse:
    if bool(media) == bool(source_relative_path):
        raise DomainError("invalid_input", "media 和 source_relative_path 必须二选一")
    if not asset_name.strip():
        raise DomainError("invalid_input", "asset_name 不能为空")

    uploaded_filename: str | None = None
    if source_relative_path:
        source_path = resolve_voice_library_path(source_relative_path, allowed_prefixes=("imported", "assets"))
        source_name = source_path.name
    else:
        assert media is not None
        uploaded_filename = media.filename or "clip"
        suffix = Path(uploaded_filename).suffix or ".bin"
        with tempfile.NamedTemporaryFile(prefix="tts-media-upload-", suffix=suffix, delete=False) as temp:
            temp_path = Path(temp.name)
            temp.write(await media.read())
        source_path = temp_path
        source_name = uploaded_filename

    try:
        if apply_mode == "ultimate_cloning":
            whisperx_ok, whisperx_error = await _probe_whisperx(DEFAULT_WHISPERX_URL)
            if not whisperx_ok:
                raise DomainError(
                    "whisperx_unavailable",
                    whisperx_error or "WhisperX 未就绪，无法自动生成 prompt_text",
                )

        result, detected_text = await process_media_with_optional_transcript(
            source_path,
            source_name,
            start_s=start_s,
            end_s=end_s,
            cleanup_mode=cleanup_mode,
            apply_mode=apply_mode,
            asset_name=asset_name.strip(),
            selected_text=selected_text.strip(),
            whisperx_url=DEFAULT_WHISPERX_URL,
        )
    finally:
        if not source_relative_path:
            try:
                source_path.unlink(missing_ok=True)
            except OSError:
                pass

    final_selected_text = result.selected_text or detected_text or selected_text.strip()
    asset_metadata = _describe_source_metadata(
        source_relative_path=source_relative_path,
        uploaded_filename=uploaded_filename,
    )
    asset_metadata.update(
        {
            "name": asset_name.strip(),
            "assetRelativePath": result.asset_relative_path,
            "previewUrl": build_preview_url(result.preview_relative_path),
            "originalPreviewUrl": build_preview_url(result.original_preview_relative_path),
            "selectedText": final_selected_text,
            "startS": round(start_s, 3),
            "endS": round(end_s, 3),
            "cleanupMode": cleanup_mode,
        }
    )
    write_voice_asset_metadata(result.asset_relative_path, asset_metadata)

    return MediaProcessResponse(
        relative_audio_path=result.relative_audio_path,
        duration_s=result.duration_s,
        cleanup_mode=result.cleanup_mode,
        apply_mode=apply_mode,
        detected_text=detected_text,
        preview_url=build_preview_url(result.preview_relative_path),
        original_preview_url=build_preview_url(result.original_preview_relative_path),
        asset_relative_path=result.asset_relative_path,
        selected_text=final_selected_text,
    )


@router.post("/media/trial-synthesis", response_model=TrialSynthesisResponse)
async def trial_synthesis(body: TrialSynthesisRequest) -> TrialSynthesisResponse:
    prompt_text = (body.prompt_text or "").strip()
    if body.apply_mode == "ultimate_cloning" and not prompt_text:
        raise DomainError("invalid_input", "极致克隆试听需要 prompt_text")

    asset_path = resolve_voice_library_path(body.asset_relative_path, allowed_prefixes=("assets",))
    if not asset_path.exists():
        raise DomainError("not_found", f"声音素材不存在：{body.asset_relative_path}")

    params = _build_trial_config(
        apply_mode=body.apply_mode,
        asset_relative_path=body.asset_relative_path,
        prompt_text=prompt_text,
        base_config=body.base_config,
    )
    client = VoxCPMClient(url=DEFAULT_VOXCPM_URL)
    try:
        audio_bytes = await client.synthesize(TRIAL_SAMPLE_TEXT, params)
    except (VoxCPMUnavailableError, VoxCPMServerError, VoxCPMClientError) as exc:
        raise DomainError("voxcpm_unavailable", str(exc)) from exc
    finally:
        await client.aclose()

    trial = await asyncio.to_thread(
        write_trial_audio,
        body.asset_relative_path,
        audio_bytes,
        apply_mode=body.apply_mode,
    )
    return TrialSynthesisResponse(
        trial_audio_path=trial.relative_audio_path,
        trial_preview_url=build_preview_url(trial.preview_relative_path),
        duration_s=trial.duration_s,
        sample_text=TRIAL_SAMPLE_TEXT,
    )
