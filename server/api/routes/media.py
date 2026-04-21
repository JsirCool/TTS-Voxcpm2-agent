from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, Response
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
    MediaWaveformResult,
    build_selection_preview_audio,
    build_media_waveform,
    SubtitleCue,
    demucs_status,
    ffmpeg_status,
    ffprobe_status,
    process_media_with_optional_transcript,
    resolve_voice_library_path,
    resolve_whisperx_subtitles,
    transcribe_source_audio_for_prompt,
    voice_source_root,
    write_trial_audio,
    write_voice_asset_metadata,
)
from server.core.tts_presets import normalize_tts_config, resolve_audio_path, validate_tts_config
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
VOICE_SOURCE_AUDIO_SUFFIXES = {
    ".aac",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".wma",
}
LOCAL_MEDIA_PICK_SUFFIXES = {
    ".m4a",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".qt",
    ".wav",
}
LOCAL_MEDIA_PICK_FILTER = (
    "媒体文件|*.mp4;*.mov;*.mkv;*.qt;*.mp3;*.wav;*.m4a|"
    "所有文件|*.*"
)
VOICE_SOURCE_FILENAME_FORBIDDEN_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
UPLOAD_CHUNK_SIZE = 1024 * 1024


def _quote_powershell_string(value: str) -> str:
    """Escape a string for single-quoted PowerShell literals."""
    return str(value).replace("'", "''")


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
    bilibili_import_dir: str


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
    absolute_path: str
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


class PromptAudioTranscribeRequest(_CamelBase):
    prompt_audio_path: str


class PromptAudioTranscribeResponse(_CamelBase):
    prompt_text: str
    audio_path: str


class OpenFolderResponse(_CamelBase):
    path: str


class VoiceSourceUploadResponse(_CamelBase):
    relative_audio_path: str
    absolute_path: str
    filename: str
    size_bytes: int


class LocalMediaPickResponse(_CamelBase):
    source_relative_path: str
    absolute_path: str
    preview_url: str
    media_type: Literal["video", "audio"]
    filename: str
    size_bytes: int


class MediaWaveformResponse(_CamelBase):
    duration_s: float
    bins: int
    peaks: list[float]


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


def _open_directory(path: Path) -> None:
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
        return
    subprocess.Popen(["xdg-open", str(path)])


def _bilibili_import_root() -> Path:
    return voice_source_root() / "imported" / "bilibili"


def _local_media_pick_root() -> Path:
    return voice_source_root() / "imported" / "local-picker"


def _pick_local_media_file(initial_dir: Path) -> Path | None:
    if os.name != "nt":
        raise OSError("当前仅支持 Windows 桌面环境本机文件选择器")

    folder = initial_dir if initial_dir.exists() else voice_source_root()
    folder.mkdir(parents=True, exist_ok=True)
    script = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$dialog = New-Object System.Windows.Forms.OpenFileDialog;"
        "$dialog.Title = '选择素材文件';"
        f"$dialog.Filter = '{_quote_powershell_string(LOCAL_MEDIA_PICK_FILTER)}';"
        "$dialog.Multiselect = $false;"
        "$dialog.CheckFileExists = $true;"
        "$dialog.RestoreDirectory = $false;"
        f"$dialog.InitialDirectory = '{_quote_powershell_string(str(folder))}';"
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {"
        "  Write-Output $dialog.FileName"
        "}"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-STA", "-Command", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit code {result.returncode}").strip()
        raise OSError(detail)

    selected = result.stdout.strip()
    if not selected:
        return None
    return Path(selected).resolve()


def _safe_voice_source_filename(filename: str | None) -> str:
    raw_name = Path(filename or "prompt-audio.wav").name.strip()
    cleaned = VOICE_SOURCE_FILENAME_FORBIDDEN_RE.sub("_", raw_name).strip(" ._")
    if not cleaned:
        cleaned = "prompt-audio.wav"
    suffix = Path(cleaned).suffix.lower()
    if suffix not in VOICE_SOURCE_AUDIO_SUFFIXES:
        allowed = ", ".join(sorted(VOICE_SOURCE_AUDIO_SUFFIXES))
        raise DomainError(
            "invalid_input",
            f"unsupported audio file type '{suffix or '(none)'}'; allowed: {allowed}",
        )
    return cleaned


def _safe_local_media_filename(filename: str | None) -> str:
    raw_name = Path(filename or "local-media.wav").name.strip()
    cleaned = VOICE_SOURCE_FILENAME_FORBIDDEN_RE.sub("_", raw_name).strip(" ._")
    suffix = Path(cleaned or raw_name).suffix.lower()
    if not cleaned:
        cleaned = f"local-media{suffix or '.wav'}"
    suffix = Path(cleaned).suffix.lower()
    if suffix not in LOCAL_MEDIA_PICK_SUFFIXES:
        allowed = ", ".join(sorted(LOCAL_MEDIA_PICK_SUFFIXES))
        raise DomainError(
            "invalid_input",
            f"unsupported media file type '{suffix or '(none)'}'; allowed: {allowed}",
        )
    return cleaned


def _dedupe_voice_source_path(folder: Path, filename: str) -> Path:
    root = folder.resolve()
    candidate = (root / filename).resolve(strict=False)
    if candidate != root and root not in candidate.parents:
        raise DomainError("invalid_input", "uploaded filename escapes voice_sourse")
    if not candidate.exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    for index in range(1, 1000):
        next_candidate = (root / f"{stem}-{index}{suffix}").resolve(strict=False)
        if not next_candidate.exists():
            return next_candidate

    raise DomainError("invalid_input", f"too many files named like '{filename}'")


def _import_picked_local_media(selected_path: Path) -> tuple[str, Path]:
    source = selected_path.resolve(strict=True)
    if not source.is_file():
        raise DomainError("invalid_input", f"素材不是文件：{source}")

    suffix = source.suffix.lower()
    if suffix not in LOCAL_MEDIA_PICK_SUFFIXES:
        allowed = ", ".join(sorted(LOCAL_MEDIA_PICK_SUFFIXES))
        raise DomainError(
            "invalid_input",
            f"unsupported media file type '{suffix or '(none)'}'; allowed: {allowed}",
        )

    root = voice_source_root().resolve()
    imported_root = (root / "imported").resolve()
    if source == imported_root or imported_root in source.parents:
        return source.relative_to(root).as_posix(), source

    destination_root = _local_media_pick_root()
    destination_root.mkdir(parents=True, exist_ok=True)
    destination = _dedupe_voice_source_path(destination_root, _safe_local_media_filename(source.name))
    shutil.copy2(source, destination)
    return destination.relative_to(root).as_posix(), destination


def _pick_local_media_file_tk(initial_dir: Path) -> Path | None:
    if os.name != "nt":
        raise OSError("当前仅支持 Windows 桌面环境本机文件选择器")

    folder = initial_dir if initial_dir.exists() else voice_source_root()
    folder.mkdir(parents=True, exist_ok=True)
    script = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        f"initialdir = {str(folder)!r}\n"
        "root = tk.Tk()\n"
        "root.withdraw()\n"
        "root.attributes('-topmost', True)\n"
        "root.update_idletasks()\n"
        "path = filedialog.askopenfilename(\n"
        "    title='选择素材文件',\n"
        "    initialdir=initialdir,\n"
        "    filetypes=[('媒体文件', '*.mp4 *.mov *.mkv *.qt *.mp3 *.wav *.m4a'), ('所有文件', '*.*')],\n"
        ")\n"
        "if path:\n"
        "    print(path)\n"
        "root.destroy()\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit code {result.returncode}").strip()
        raise OSError(detail)

    selected = result.stdout.strip()
    if not selected:
        return None
    return Path(selected).resolve()


def _pick_local_media_file(initial_dir: Path) -> Path | None:
    """Backward-compatible alias kept for older call sites."""
    return _pick_local_media_file_tk(initial_dir)


async def _write_uploaded_file(upload: UploadFile, destination: Path) -> int:
    size = 0
    try:
        with destination.open("wb") as out:
            while True:
                chunk = await upload.read(UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                out.write(chunk)
    except OSError as exc:
        raise DomainError("invalid_input", f"failed to save uploaded audio: {exc}") from exc
    finally:
        await upload.close()

    if size <= 0:
        try:
            destination.unlink(missing_ok=True)
        except OSError:
            pass
        raise DomainError("invalid_input", "uploaded audio file is empty")
    return size


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
        bilibili_import_dir=str(_bilibili_import_root()),
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
        absolute_path=str(result.absolute_path),
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


@router.post("/media/waveform", response_model=MediaWaveformResponse)
async def get_media_waveform(
    media: UploadFile | None = File(None),
    source_relative_path: str | None = Form(None),
    bins: int = Form(320),
) -> MediaWaveformResponse:
    if bool(media) == bool(source_relative_path):
        raise DomainError("invalid_input", "media 和 source_relative_path 必须二选一")

    if source_relative_path:
        source_path = resolve_voice_library_path(source_relative_path, allowed_prefixes=("imported", "assets"))
        result = await asyncio.to_thread(build_media_waveform, source_path, bins=bins)
        return MediaWaveformResponse(duration_s=result.duration_s, bins=len(result.peaks), peaks=result.peaks)

    assert media is not None
    filename = media.filename or "waveform"
    suffix = Path(filename).suffix or ".bin"
    with tempfile.NamedTemporaryFile(prefix="tts-waveform-upload-", suffix=suffix, delete=False) as temp:
        temp_path = Path(temp.name)
        temp.write(await media.read())

    try:
        result = await asyncio.to_thread(build_media_waveform, temp_path, bins=bins)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass

    return MediaWaveformResponse(duration_s=result.duration_s, bins=len(result.peaks), peaks=result.peaks)


@router.post("/media/selection-preview")
async def get_media_selection_preview(
    media: UploadFile | None = File(None),
    source_relative_path: str | None = Form(None),
    start_s: float = Form(...),
    end_s: float = Form(...),
) -> Response:
    if bool(media) == bool(source_relative_path):
        raise DomainError("invalid_input", "media 鍜?source_relative_path 蹇呴』浜岄€変竴")

    if source_relative_path:
        source_path = resolve_voice_library_path(source_relative_path, allowed_prefixes=("imported", "assets"))
        audio_bytes = await asyncio.to_thread(
            build_selection_preview_audio,
            source_path,
            start_s=start_s,
            end_s=end_s,
        )
        return Response(content=audio_bytes, media_type="audio/wav")

    assert media is not None
    filename = media.filename or "selection-preview"
    suffix = Path(filename).suffix or ".bin"
    with tempfile.NamedTemporaryFile(prefix="tts-selection-preview-upload-", suffix=suffix, delete=False) as temp:
        temp_path = Path(temp.name)
        temp.write(await media.read())

    try:
        audio_bytes = await asyncio.to_thread(
            build_selection_preview_audio,
            temp_path,
            start_s=start_s,
            end_s=end_s,
        )
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass

    return Response(content=audio_bytes, media_type="audio/wav")


@router.post("/media/voice-source/open", response_model=OpenFolderResponse)
async def open_voice_source_folder() -> OpenFolderResponse:
    folder = voice_source_root()
    try:
        folder.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(_open_directory, folder)
    except OSError as exc:
        raise DomainError("invalid_input", f"无法打开素材文件夹：{exc}") from exc
    return OpenFolderResponse(path=str(folder))


@router.post("/media/imported-bilibili/open", response_model=OpenFolderResponse)
async def open_bilibili_import_folder() -> OpenFolderResponse:
    folder = _bilibili_import_root()
    try:
        folder.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(_open_directory, folder)
    except OSError as exc:
        raise DomainError("invalid_input", f"无法打开 B 站下载目录：{exc}") from exc
    return OpenFolderResponse(path=str(folder))


@router.post("/media/local-file/pick", response_model=LocalMediaPickResponse)
async def pick_local_media_source() -> LocalMediaPickResponse:
    try:
        selected_path = await asyncio.to_thread(_pick_local_media_file_tk, _bilibili_import_root())
    except OSError as exc:
        raise DomainError("invalid_input", f"无法打开本机文件选择器：{exc}") from exc

    if selected_path is None:
        raise DomainError("cancelled", "已取消选择本地文件")

    relative_path, absolute_path = await asyncio.to_thread(_import_picked_local_media, selected_path)
    media_type = guess_media_type(absolute_path)
    return LocalMediaPickResponse(
        source_relative_path=relative_path,
        absolute_path=str(absolute_path),
        preview_url=build_preview_url(relative_path),
        media_type="video" if media_type.startswith("video/") else "audio",
        filename=absolute_path.name,
        size_bytes=absolute_path.stat().st_size,
    )


@router.post("/media/voice-source/upload", response_model=VoiceSourceUploadResponse)
async def upload_voice_source_file(media: UploadFile = File(...)) -> VoiceSourceUploadResponse:
    filename = _safe_voice_source_filename(media.filename)
    folder = voice_source_root()
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise DomainError("invalid_input", f"cannot create voice_sourse folder: {exc}") from exc

    destination = _dedupe_voice_source_path(folder, filename)
    size_bytes = await _write_uploaded_file(media, destination)
    relative_audio_path = destination.relative_to(folder.resolve()).as_posix()
    return VoiceSourceUploadResponse(
        relative_audio_path=relative_audio_path,
        absolute_path=str(destination),
        filename=destination.name,
        size_bytes=size_bytes,
    )


@router.post("/media/prompt-audio/transcribe", response_model=PromptAudioTranscribeResponse)
async def transcribe_prompt_audio(body: PromptAudioTranscribeRequest) -> PromptAudioTranscribeResponse:
    prompt_audio_path = body.prompt_audio_path.strip()
    if not prompt_audio_path:
        raise DomainError("invalid_input", "prompt_audio_path cannot be empty")

    source_path = resolve_audio_path(prompt_audio_path)
    if source_path is None or not source_path.exists():
        raise DomainError("not_found", f"Prompt Audio not found: {prompt_audio_path}")
    if not source_path.is_file():
        raise DomainError("invalid_input", f"Prompt Audio is not a file: {prompt_audio_path}")

    whisperx_ok, whisperx_error = await _probe_whisperx(DEFAULT_WHISPERX_URL)
    if not whisperx_ok:
        raise DomainError(
            "whisperx_unavailable",
            whisperx_error or "WhisperX is not ready, cannot transcribe Prompt Text",
        )

    prompt_text = await transcribe_source_audio_for_prompt(source_path, whisperx_url=DEFAULT_WHISPERX_URL)
    return PromptAudioTranscribeResponse(
        prompt_text=prompt_text,
        audio_path=str(source_path),
    )


@router.post("/media/subtitles/resolve", response_model=SubtitleResolveResponse)
async def resolve_subtitles(
    media: UploadFile | None = File(None),
    source_relative_path: str | None = Form(None),
    allow_whisperx: bool = Form(False),
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

            if not allow_whisperx:
                raise DomainError(
                    "subtitle_requires_whisperx",
                    "未找到 B 站原生字幕。是否启用 WhisperX 自动转写？转写过程可能会有点久。",
                )

        if not allow_whisperx:
            raise DomainError(
                "subtitle_requires_whisperx",
                "当前素材没有可直接读取的原生字幕。是否启用 WhisperX 自动转写？转写过程可能会有点久。",
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
    if not allow_whisperx:
        raise DomainError(
            "subtitle_requires_whisperx",
            "本地文件需要使用 WhisperX 自动转写生成字幕。是否启用？转写过程可能会有点久。",
        )
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
