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
SubtitleSourceType = Literal["bilibili_official", "whisperx_generated"]

_SAFE_STEM_RE = re.compile(r"[^A-Za-z0-9._-]+")
_ASSET_FORBIDDEN_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
_ASSET_SPACE_RE = re.compile(r"\s+")
_PUNCT_END_RE = re.compile(r"[。！？!?；;…]$")


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
class SubtitleCue:
    id: str
    start_s: float
    end_s: float
    text: str


@dataclass
class SubtitleResolveResult:
    source_type: SubtitleSourceType
    language: str
    cues: list[SubtitleCue]


@dataclass
class MediaProcessResult:
    absolute_path: Path
    relative_audio_path: str
    duration_s: float
    cleanup_mode: CleanupMode
    preview_relative_path: str
    original_preview_relative_path: str
    asset_relative_path: str
    selected_text: str


@dataclass
class TrialSynthesisResult:
    absolute_path: Path
    relative_audio_path: str
    preview_relative_path: str
    duration_s: float
    sample_text: str


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _safe_stem(name: str) -> str:
    stem = Path(name).stem.strip() or "clip"
    safe = _SAFE_STEM_RE.sub("-", stem).strip("._-")
    return safe or "clip"


def _safe_asset_slug(name: str) -> str:
    cleaned = _ASSET_FORBIDDEN_RE.sub(" ", (name or "").strip())
    cleaned = _ASSET_SPACE_RE.sub("-", cleaned).strip(" .-_")
    return cleaned or "voice-asset"


def _trimmed_error(prefix: str, completed: subprocess.CompletedProcess[str]) -> str:
    detail = (completed.stderr or completed.stdout or "").strip()
    if detail:
        return f"{prefix}: {detail[:400]}"
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


def voice_source_root() -> Path:
    return get_voice_source_dir().resolve()


def resolve_voice_library_path(
    relative_path: str | Path,
    *,
    allowed_prefixes: tuple[str, ...] = ("imported", "assets"),
) -> Path:
    root = voice_source_root()
    raw = str(relative_path or "").strip()
    if not raw:
        raise DomainError("invalid_input", "source_relative_path 不能为空")

    candidate = (root / raw).resolve(strict=False)
    allowed_roots = [(root / prefix).resolve() for prefix in allowed_prefixes]
    if not any(candidate == allowed_root or allowed_root in candidate.parents for allowed_root in allowed_roots):
        joined = ", ".join(f"voice_sourse/{prefix}" for prefix in allowed_prefixes)
        raise DomainError("invalid_input", f"只允许访问 {joined} 下的素材文件")
    if not candidate.exists():
        raise DomainError("not_found", f"素材不存在：{raw}")
    if not candidate.is_file():
        raise DomainError("invalid_input", f"素材不是文件：{raw}")
    return candidate


def build_asset_directory(asset_name: str, *, voice_source_dir: Path | None = None) -> Path:
    root = (voice_source_dir or voice_source_root()).resolve()
    return root / "assets" / _safe_asset_slug(asset_name)


def build_asset_processed_relative_path(
    asset_name: str,
    *,
    cleanup_mode: CleanupMode,
    now: str | None = None,
) -> Path:
    stamp = now or _utc_stamp()
    slug = _safe_asset_slug(asset_name)
    return Path("assets") / slug / f"{stamp}__{cleanup_mode}__processed.wav"


def build_asset_original_preview_relative_path(
    asset_name: str,
    *,
    now: str | None = None,
) -> Path:
    stamp = now or _utc_stamp()
    slug = _safe_asset_slug(asset_name)
    return Path("assets") / slug / f"{stamp}__original.wav"


def build_asset_sidecar_relative_path(asset_relative_path: str | Path) -> Path:
    return Path(str(asset_relative_path)).with_suffix(".json")


def build_trial_relative_path(
    asset_relative_path: str | Path,
    *,
    apply_mode: ApplyMode,
    now: str | None = None,
) -> Path:
    stamp = now or _utc_stamp()
    relative = Path(str(asset_relative_path))
    mode_tag = "ultimate" if apply_mode == "ultimate_cloning" else "controllable"
    return relative.parent / f"{stamp}__trial__{mode_tag}__{relative.stem}.wav"


def guess_media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".mp4":
        return "video/mp4"
    if suffix == ".m4a":
        return "audio/mp4"
    if suffix == ".mp3":
        return "audio/mpeg"
    if suffix in {".mov", ".qt"}:
        return "video/quicktime"
    if suffix == ".mkv":
        return "video/x-matroska"
    return "audio/wav"


def write_voice_asset_metadata(
    asset_relative_path: str | Path,
    metadata: dict[str, Any],
    *,
    voice_source_dir: Path | None = None,
) -> str:
    root = (voice_source_dir or voice_source_root()).resolve()
    relative = build_asset_sidecar_relative_path(asset_relative_path)
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(metadata)
    payload.setdefault("version", 1)
    payload.setdefault("updatedAt", datetime.now(timezone.utc).isoformat())
    destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return to_relative_audio_path(destination) or relative.as_posix()


def load_voice_asset_metadata(
    asset_relative_path: str | Path,
    *,
    voice_source_dir: Path | None = None,
) -> dict[str, Any] | None:
    root = (voice_source_dir or voice_source_root()).resolve()
    relative = build_asset_sidecar_relative_path(asset_relative_path)
    path = root / relative
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover
        raise DomainError("invalid_state", f"声音素材元数据读取失败：{exc}") from exc
    if not isinstance(payload, dict):
        raise DomainError("invalid_state", "声音素材元数据格式无效")
    return payload


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


def _extract_full_audio_for_transcription(source_path: Path, output_path: Path) -> None:
    ffmpeg = _require_ffmpeg()
    _run_command(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(source_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        code="media_process_failed",
        prefix="ffmpeg transcription extraction failed",
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

    _run_command(cmd, code="media_process_failed", prefix="Demucs vocal separation failed")
    vocals = next(output_dir.glob("**/vocals.wav"), None)
    if vocals is None or not vocals.exists():
        raise DomainError("media_process_failed", "Demucs did not produce a vocals.wav output")
    return vocals


def _write_bytes(destination: Path, data: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)


def process_media_to_clone_source(
    source_path: Path,
    source_name: str,
    *,
    start_s: float,
    end_s: float,
    cleanup_mode: CleanupMode,
    asset_name: str,
    selected_text: str = "",
    voice_source_dir: Path | None = None,
) -> MediaProcessResult:
    metadata = probe_media(source_path)
    start_s, end_s = validate_trim_bounds(metadata.duration_s, start_s, end_s)
    target_root = (voice_source_dir or voice_source_root()).resolve()
    stamp = _utc_stamp()
    processed_relative = build_asset_processed_relative_path(asset_name, cleanup_mode=cleanup_mode, now=stamp)
    original_relative = build_asset_original_preview_relative_path(asset_name, now=stamp)
    processed_destination = target_root / processed_relative
    original_destination = target_root / original_relative
    processed_destination.parent.mkdir(parents=True, exist_ok=True)
    original_destination.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="tts-media-") as temp_dir:
        workspace_dir = Path(temp_dir)
        segment_path = workspace_dir / "segment.wav"
        _extract_segment(source_path, segment_path, start_s=start_s, end_s=end_s)
        shutil.copyfile(segment_path, original_destination)

        working_source = segment_path
        if cleanup_mode == "vocal_isolate":
            working_source = _run_demucs(segment_path, workspace_dir)

        normalized_path = workspace_dir / "final.wav"
        _normalize_audio(working_source, normalized_path, cleanup_mode=cleanup_mode)
        shutil.copyfile(normalized_path, processed_destination)

    normalized_probe = probe_media(processed_destination)
    if normalized_probe.duration_s <= 0.1:
        raise DomainError("invalid_input", "processed clip is empty or too short")

    processed_relative_text = to_relative_audio_path(processed_destination) or processed_relative.as_posix()
    original_relative_text = to_relative_audio_path(original_destination) or original_relative.as_posix()
    return MediaProcessResult(
        absolute_path=processed_destination,
        relative_audio_path=processed_relative_text,
        duration_s=normalized_probe.duration_s,
        cleanup_mode=cleanup_mode,
        preview_relative_path=processed_relative_text,
        original_preview_relative_path=original_relative_text,
        asset_relative_path=processed_relative_text,
        selected_text=selected_text.strip(),
    )


async def _transcribe_words_once(
    audio_path: Path,
    *,
    whisperx_url: str,
    language: str,
) -> tuple[list[dict[str, Any]], str]:
    try:
        async with httpx.AsyncClient(timeout=240) as client:
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
    words: list[dict[str, Any]] = []
    for item in transcript:
        if not isinstance(item, dict):
            continue
        word = str(item.get("word") or "").strip()
        if not word:
            continue
        try:
            start_s = float(item.get("start"))
            end_s = float(item.get("end"))
        except (TypeError, ValueError):
            continue
        if end_s <= start_s:
            continue
        words.append({"word": word, "start": start_s, "end": end_s})
    detected_language = str(payload.get("language") or language)
    return words, detected_language


def _join_words(words: list[str], *, language: str) -> str:
    if language.startswith("zh"):
        return "".join(words).replace(" ", "").strip()
    text = " ".join(words)
    return re.sub(r"\s+([,.!?;:])", r"\1", text).strip()


def _transcript_score(text: str, *, language: str) -> int:
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if language.startswith("zh"):
        return cjk * 4 + len(text)
    return latin * 3 + len(text)


def _should_break_cue(
    current_words: list[dict[str, Any]],
    next_gap: float | None,
    *,
    language: str,
) -> bool:
    if not current_words:
        return False
    text = _join_words([str(item["word"]) for item in current_words], language=language)
    duration = float(current_words[-1]["end"]) - float(current_words[0]["start"])
    if _PUNCT_END_RE.search(str(current_words[-1]["word"])):
        return True
    if next_gap is not None and next_gap >= 0.7:
        return True
    if language.startswith("zh"):
        return len(text) >= 24 or duration >= 4.2
    return len(text) >= 56 or duration >= 4.2


def build_subtitle_cues_from_words(
    words: list[dict[str, Any]],
    *,
    language: str,
) -> list[SubtitleCue]:
    cues: list[SubtitleCue] = []
    current: list[dict[str, Any]] = []
    for index, word in enumerate(words):
        current.append(word)
        next_gap: float | None = None
        if index + 1 < len(words):
            next_gap = float(words[index + 1]["start"]) - float(word["end"])
        if not _should_break_cue(current, next_gap, language=language) and index + 1 < len(words):
            continue
        text = _join_words([str(item["word"]) for item in current], language=language)
        if text:
            cues.append(
                SubtitleCue(
                    id=f"cue_{len(cues) + 1:03d}",
                    start_s=round(float(current[0]["start"]), 3),
                    end_s=round(float(current[-1]["end"]), 3),
                    text=text,
                )
            )
        current = []
    return cues


async def transcribe_audio_for_prompt(audio_path: Path, *, whisperx_url: str) -> str:
    candidates: list[tuple[str, str]] = []
    for language in ("zh", "en"):
        words, detected_language = await _transcribe_words_once(
            audio_path,
            whisperx_url=whisperx_url,
            language=language,
        )
        text = _join_words([str(item["word"]) for item in words], language=detected_language)
        if text:
            candidates.append((text, detected_language))
    if not candidates:
        raise DomainError("invalid_input", "WhisperX did not detect usable speech text in the processed clip")
    best_text, best_language = max(
        candidates,
        key=lambda item: (_transcript_score(item[0], language=item[1]), len(item[0])),
    )
    return best_text.strip() if best_language else best_text.strip()


async def resolve_whisperx_subtitles(
    source_path: Path,
    *,
    whisperx_url: str,
) -> SubtitleResolveResult:
    with tempfile.TemporaryDirectory(prefix="tts-subtitles-") as temp_dir:
        working_audio = Path(temp_dir) / "source.wav"
        await asyncio.to_thread(_extract_full_audio_for_transcription, source_path, working_audio)
        candidates: list[tuple[str, list[dict[str, Any]], str]] = []
        for language in ("zh", "en"):
            words, detected_language = await _transcribe_words_once(
                working_audio,
                whisperx_url=whisperx_url,
                language=language,
            )
            text = _join_words([str(item["word"]) for item in words], language=detected_language)
            if words and text:
                candidates.append((detected_language, words, text))
    if not candidates:
        raise DomainError("subtitle_unavailable", "WhisperX 未能从该素材中识别出可用字幕")
    language, words, _text = max(
        candidates,
        key=lambda item: (_transcript_score(item[2], language=item[0]), len(item[2])),
    )
    cues = build_subtitle_cues_from_words(words, language=language)
    if not cues:
        raise DomainError("subtitle_unavailable", "WhisperX 已返回转录结果，但没有生成可用字幕分段")
    return SubtitleResolveResult(
        source_type="whisperx_generated",
        language=language,
        cues=cues,
    )


async def process_media_with_optional_transcript(
    source_path: Path,
    source_name: str,
    *,
    start_s: float,
    end_s: float,
    cleanup_mode: CleanupMode,
    apply_mode: ApplyMode,
    asset_name: str,
    selected_text: str = "",
    whisperx_url: str | None = None,
) -> tuple[MediaProcessResult, str | None]:
    result = await asyncio.to_thread(
        process_media_to_clone_source,
        source_path,
        source_name,
        start_s=start_s,
        end_s=end_s,
        cleanup_mode=cleanup_mode,
        asset_name=asset_name,
        selected_text=selected_text,
    )
    detected_text: str | None = selected_text.strip() or None
    if apply_mode == "ultimate_cloning" and not detected_text:
        if not whisperx_url:
            raise DomainError("whisperx_unavailable", "WhisperX URL is not configured")
        detected_text = await transcribe_audio_for_prompt(result.absolute_path, whisperx_url=whisperx_url)
    return result, detected_text


def write_trial_audio(
    asset_relative_path: str | Path,
    audio_bytes: bytes,
    *,
    apply_mode: ApplyMode,
    voice_source_dir: Path | None = None,
) -> TrialSynthesisResult:
    root = (voice_source_dir or voice_source_root()).resolve()
    relative_path = build_trial_relative_path(asset_relative_path, apply_mode=apply_mode)
    destination = root / relative_path
    _write_bytes(destination, audio_bytes)
    probe = probe_media(destination)
    relative = to_relative_audio_path(destination) or relative_path.as_posix()
    return TrialSynthesisResult(
        absolute_path=destination,
        relative_audio_path=relative,
        preview_relative_path=relative,
        duration_s=probe.duration_s,
        sample_text="",
    )


__all__ = [
    "ApplyMode",
    "CleanupMode",
    "MediaProcessResult",
    "MediaProbeResult",
    "MediaToolStatus",
    "SubtitleCue",
    "SubtitleResolveResult",
    "SubtitleSourceType",
    "TrialSynthesisResult",
    "build_asset_directory",
    "build_asset_original_preview_relative_path",
    "build_asset_processed_relative_path",
    "build_asset_sidecar_relative_path",
    "build_output_relative_path",
    "build_subtitle_cues_from_words",
    "build_trial_relative_path",
    "demucs_status",
    "ffmpeg_status",
    "ffprobe_status",
    "guess_media_type",
    "load_voice_asset_metadata",
    "probe_media",
    "process_media_to_clone_source",
    "process_media_with_optional_transcript",
    "resolve_voice_library_path",
    "resolve_whisperx_subtitles",
    "transcribe_audio_for_prompt",
    "validate_trim_bounds",
    "voice_source_root",
    "write_trial_audio",
    "write_voice_asset_metadata",
]
