from __future__ import annotations

import asyncio
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx

from server.core.domain import DomainError
from server.core.tts_presets import get_voice_source_dir, to_relative_audio_path

CleanupMode = Literal["light", "vocal_isolate"]
ApplyMode = Literal["controllable_cloning", "ultimate_cloning"]

_SAFE_STEM_RE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass
class MediaToolStatus:
    available: bool
    detail: str | None = None


@dataclass
class MediaProbeResult:
    duration_s: float
    audio_streams: int
    sample_rate: int | None = None


@dataclass
class MediaProcessResult:
    absolute_path: Path
    relative_audio_path: str
    duration_s: float
    cleanup_mode: CleanupMode


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _safe_stem(name: str) -> str:
    stem = Path(name).stem.strip() or "clip"
    safe = _SAFE_STEM_RE.sub("-", stem).strip("._-")
    return safe or "clip"


def _trimmed_error(prefix: str, completed: subprocess.CompletedProcess[str]) -> str:
    detail = (completed.stderr or completed.stdout or "").strip()
    if detail:
        detail = detail[:400]
        return f"{prefix}: {detail}"
    return prefix


def _run_command(cmd: list[str], *, code: str, prefix: str) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        raise DomainError(code, _trimmed_error(prefix, completed))
    return completed


def ffmpeg_status() -> MediaToolStatus:
    path = shutil.which("ffmpeg")
    if path:
        return MediaToolStatus(True, path)
    return MediaToolStatus(False, "ffmpeg not found in PATH")


def ffprobe_status() -> MediaToolStatus:
    path = shutil.which("ffprobe")
    if path:
        return MediaToolStatus(True, path)
    return MediaToolStatus(False, "ffprobe not found in PATH")


def demucs_status() -> MediaToolStatus:
    if shutil.which("demucs"):
        return MediaToolStatus(True, "demucs executable found in PATH")
    if importlib.util.find_spec("demucs") is not None:
        return MediaToolStatus(True, "demucs Python module available")
    return MediaToolStatus(False, "Demucs is not installed in the current Python runtime")


def _require_ffmpeg() -> str:
    status = ffmpeg_status()
    if not status.available:
        raise DomainError("ffmpeg_unavailable", status.detail or "ffmpeg is unavailable")
    return shutil.which("ffmpeg") or "ffmpeg"


def _require_ffprobe() -> str:
    status = ffprobe_status()
    if not status.available:
        raise DomainError("ffprobe_unavailable", status.detail or "ffprobe is unavailable")
    return shutil.which("ffprobe") or "ffprobe"


def probe_media(source_path: Path) -> MediaProbeResult:
    ffprobe = _require_ffprobe()
    completed = _run_command(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(source_path),
        ],
        code="media_probe_failed",
        prefix="ffprobe failed",
    )
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise DomainError("media_probe_failed", f"ffprobe returned invalid JSON: {exc}") from exc

    streams = payload.get("streams") if isinstance(payload.get("streams"), list) else []
    audio_streams = [item for item in streams if isinstance(item, dict) and item.get("codec_type") == "audio"]
    if not audio_streams:
        raise DomainError("invalid_input", "source file has no audio stream")

    duration_candidates: list[float] = []
    format_info = payload.get("format") if isinstance(payload.get("format"), dict) else {}
    for raw in [format_info.get("duration"), *[item.get("duration") for item in audio_streams]]:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            duration_candidates.append(value)
    if not duration_candidates:
        raise DomainError("media_probe_failed", "unable to determine source duration")

    sample_rate: int | None = None
    raw_sample_rate = audio_streams[0].get("sample_rate")
    try:
        sample_rate = int(raw_sample_rate) if raw_sample_rate is not None else None
    except (TypeError, ValueError):
        sample_rate = None

    return MediaProbeResult(
        duration_s=max(duration_candidates),
        audio_streams=len(audio_streams),
        sample_rate=sample_rate,
    )


def validate_trim_bounds(duration_s: float, start_s: float, end_s: float) -> tuple[float, float]:
    if start_s < 0:
        raise DomainError("invalid_input", "start_s must be greater than or equal to 0")
    if end_s <= start_s:
        raise DomainError("invalid_input", "end_s must be greater than start_s")
    if start_s >= duration_s:
        raise DomainError("invalid_input", "start_s is outside the source duration")
    if end_s > duration_s + 0.05:
        raise DomainError("invalid_input", f"end_s exceeds source duration ({duration_s:.2f}s)")
    return round(start_s, 3), round(min(end_s, duration_s), 3)


def build_output_relative_path(
    source_name: str,
    start_s: float,
    end_s: float,
    cleanup_mode: CleanupMode,
    *,
    now: str | None = None,
) -> Path:
    safe_stem = _safe_stem(source_name)
    stamp = now or _utc_stamp()
    start_ms = int(round(start_s * 1000))
    end_ms = int(round(end_s * 1000))
    filename = f"{stamp}__{start_ms:08d}-{end_ms:08d}__{cleanup_mode}.wav"
    return Path("imported") / safe_stem / filename


def _extract_segment(source_path: Path, output_path: Path, *, start_s: float, end_s: float) -> None:
    ffmpeg = _require_ffmpeg()
    _run_command(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-ss",
            f"{start_s:.3f}",
            "-to",
            f"{end_s:.3f}",
            "-i",
            str(source_path),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        code="media_process_failed",
        prefix="ffmpeg segment extraction failed",
    )


def _normalize_audio(input_path: Path, output_path: Path, *, cleanup_mode: CleanupMode) -> None:
    ffmpeg = _require_ffmpeg()
    filters = ["highpass=f=80", "lowpass=f=7600"]
    if cleanup_mode == "light":
        filters.append("afftdn=nf=-20")
    filters.append("loudnorm=I=-16:TP=-1.5:LRA=11")
    _run_command(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-af",
            ",".join(filters),
            str(output_path),
        ],
        code="media_process_failed",
        prefix="ffmpeg audio normalization failed",
    )


def _run_demucs(segment_path: Path, workspace_dir: Path) -> Path:
    status = demucs_status()
    if not status.available:
        raise DomainError("demucs_unavailable", status.detail or "Demucs is unavailable")

    output_dir = workspace_dir / "demucs"
    module_available = importlib.util.find_spec("demucs") is not None
    if module_available:
        cmd = [
            sys.executable,
            "-m",
            "demucs.separate",
            "-n",
            "htdemucs",
            "--two-stems",
            "vocals",
            "-o",
            str(output_dir),
            str(segment_path),
        ]
    else:
        demucs_exe = shutil.which("demucs")
        if not demucs_exe:
            raise DomainError("demucs_unavailable", "Demucs backend was detected but could not be executed")
        cmd = [
            demucs_exe,
            "-n",
            "htdemucs",
            "--two-stems",
            "vocals",
            "-o",
            str(output_dir),
            str(segment_path),
        ]

    _run_command(
        cmd,
        code="media_process_failed",
        prefix="Demucs vocal separation failed",
    )
    vocals = next(output_dir.glob("**/vocals.wav"), None)
    if vocals is None or not vocals.exists():
        raise DomainError("media_process_failed", "Demucs did not produce a vocals.wav output")
    return vocals


def process_media_to_clone_source(
    source_path: Path,
    source_name: str,
    *,
    start_s: float,
    end_s: float,
    cleanup_mode: CleanupMode,
    voice_source_dir: Path | None = None,
) -> MediaProcessResult:
    metadata = probe_media(source_path)
    start_s, end_s = validate_trim_bounds(metadata.duration_s, start_s, end_s)
    target_root = (voice_source_dir or get_voice_source_dir()).resolve()

    with tempfile.TemporaryDirectory(prefix="tts-media-") as temp_dir:
        workspace_dir = Path(temp_dir)
        segment_path = workspace_dir / "segment.wav"
        _extract_segment(source_path, segment_path, start_s=start_s, end_s=end_s)

        working_source = segment_path
        if cleanup_mode == "vocal_isolate":
            working_source = _run_demucs(segment_path, workspace_dir)

        normalized_path = workspace_dir / "final.wav"
        _normalize_audio(working_source, normalized_path, cleanup_mode=cleanup_mode)

        normalized_probe = probe_media(normalized_path)
        if normalized_probe.duration_s <= 0.1:
            raise DomainError("invalid_input", "processed clip is empty or too short")

        relative_path = build_output_relative_path(source_name, start_s, end_s, cleanup_mode)
        destination = target_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(normalized_path, destination)

    return MediaProcessResult(
        absolute_path=destination,
        relative_audio_path=to_relative_audio_path(destination) or relative_path.as_posix(),
        duration_s=normalized_probe.duration_s,
        cleanup_mode=cleanup_mode,
    )


async def _transcribe_once(audio_path: Path, *, whisperx_url: str, language: str) -> tuple[str, str]:
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            with audio_path.open("rb") as stream:
                response = await client.post(
                    f"{whisperx_url.rstrip('/')}/transcribe",
                    files={"audio": (audio_path.name, stream, "audio/wav")},
                    data={"language": language, "return_word_timestamps": "true"},
                )
    except Exception as exc:  # noqa: BLE001
        raise DomainError("whisperx_unavailable", f"WhisperX request failed: {type(exc).__name__}: {exc}") from exc

    if response.status_code >= 400:
        detail = response.text[:300] if response.text else f"HTTP {response.status_code}"
        raise DomainError("whisperx_unavailable", f"WhisperX returned {response.status_code}: {detail}")

    payload = response.json()
    transcript = payload.get("transcript") if isinstance(payload.get("transcript"), list) else []
    words = [
        str(item.get("word") or "").strip()
        for item in transcript
        if isinstance(item, dict) and str(item.get("word") or "").strip()
    ]
    if language == "zh":
        text = "".join(words).replace(" ", "")
    else:
        text = " ".join(words)
        text = re.sub(r"\s+([,.!?;:])", r"\1", text)
    detected_language = str(payload.get("language") or language)
    return text.strip(), detected_language


def _transcript_score(text: str, *, language: str) -> int:
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if language == "zh":
        return cjk * 4 + len(text)
    return latin * 3 + len(text)


async def transcribe_audio_for_prompt(audio_path: Path, *, whisperx_url: str) -> str:
    candidates: list[tuple[str, str]] = []
    for language in ("zh", "en"):
        text, detected_language = await _transcribe_once(audio_path, whisperx_url=whisperx_url, language=language)
        if text:
            candidates.append((text, detected_language))
    if not candidates:
        raise DomainError("invalid_input", "WhisperX did not detect usable speech text in the processed clip")
    best_text, best_language = max(
        candidates,
        key=lambda item: (_transcript_score(item[0], language=item[1]), len(item[0])),
    )
    return best_text.strip()


async def process_media_with_optional_transcript(
    source_path: Path,
    source_name: str,
    *,
    start_s: float,
    end_s: float,
    cleanup_mode: CleanupMode,
    apply_mode: ApplyMode,
    whisperx_url: str | None = None,
) -> tuple[MediaProcessResult, str | None]:
    result = await asyncio.to_thread(
        process_media_to_clone_source,
        source_path,
        source_name,
        start_s=start_s,
        end_s=end_s,
        cleanup_mode=cleanup_mode,
    )
    detected_text: str | None = None
    if apply_mode == "ultimate_cloning":
        if not whisperx_url:
            raise DomainError("whisperx_unavailable", "WhisperX URL is not configured")
        detected_text = await transcribe_audio_for_prompt(result.absolute_path, whisperx_url=whisperx_url)
    return result, detected_text


__all__ = [
    "ApplyMode",
    "CleanupMode",
    "MediaProcessResult",
    "MediaProbeResult",
    "MediaToolStatus",
    "build_output_relative_path",
    "demucs_status",
    "ffmpeg_status",
    "ffprobe_status",
    "probe_media",
    "process_media_to_clone_source",
    "process_media_with_optional_transcript",
    "transcribe_audio_for_prompt",
    "validate_trim_bounds",
]
