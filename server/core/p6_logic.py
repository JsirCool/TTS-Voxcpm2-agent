"""Pure logic for the P6 (ffmpeg concat) stage.

Everything in this module is deterministic and has no implicit I/O except
for the single ``run_ffmpeg_concat`` coroutine, which wraps a subprocess
call so the rest of the stage can stay testable in pure unit form.

The goal is that any bug in offset / SRT math can be reproduced and fixed
without needing ffmpeg, MinIO, or Prefect in the test environment.

Concat rules (per the A7-P6 brief):

1. Chunks are ordered by ``(shot_id ASC, idx ASC)``.
2. Between two chunks of the **same** shot, insert ``padding_s`` seconds of
   silence (default 0.0s).
3. Between two chunks of **different** shots, insert ``shot_gap_s`` seconds
   of silence (default 0.0s). Shot gaps override chunk padding.
4. The first chunk's offset is always 0; no leading silence.
5. Chunks with ``duration_s == 0`` are skipped with a warning by the caller;
   ``compute_chunk_offsets`` still accepts them but will produce meaningless
   output for such inputs, so the task layer must filter first.
6. SRT cues are shifted by the chunk's offset, renumbered from 1, and
   concatenated in chunk order.
"""

from __future__ import annotations

import asyncio
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


# ---------------------------------------------------------------------------
# Chunk ordering / offset computation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ChunkTiming:
    """Minimal shape accepted by :func:`compute_chunk_offsets`.

    Order is the caller's responsibility — this type is deliberately flat so
    the task layer can build it from a SQLAlchemy row / Pydantic model /
    plain dict with equal ease.
    """

    chunk_id: str
    shot_id: str
    idx: int
    duration_s: float
    next_gap_ms: int | None = None


@dataclass(frozen=True)
class TimelineLayout:
    """Resolved audio timeline for a sequence of chunk takes."""

    offsets: list[float]
    requested_gaps: list[float]
    effective_gaps: list[float]
    total_duration_s: float


MIN_NEXT_START_OFFSET_S = 0.05


def sort_chunk_timings(chunks: Iterable[ChunkTiming]) -> list[ChunkTiming]:
    """Return a new list sorted by ``(shot_id, idx)`` (stable, deterministic)."""
    return sorted(chunks, key=lambda c: (c.shot_id, c.idx))


def compute_chunk_offsets(
    chunks: Sequence[ChunkTiming],
    padding_s: float,
    shot_gap_s: float,
) -> list[float]:
    """Return the cumulative start offset (seconds) of each chunk in the final WAV.

    The first chunk always starts at 0.0. For subsequent chunks, the start
    offset is ``previous_offset + previous_duration + gap``, where ``gap``
    is ``shot_gap_s`` if the shot changes and ``padding_s`` otherwise.

    Args:
        chunks:     Chunks in **final** concatenation order. The function
                    does not re-sort; call :func:`sort_chunk_timings` first
                    if the input is not already ordered.
        padding_s:  Silence inserted between chunks of the same shot.
        shot_gap_s: Silence inserted between chunks of different shots.

    Returns:
        A list of floats, same length as ``chunks``, where element ``i`` is
        the start offset of ``chunks[i]`` in the final episode timeline.
    """
    return compute_timeline_layout(chunks, padding_s, shot_gap_s).offsets


def _default_gap_s(prev: ChunkTiming, curr: ChunkTiming, padding_s: float, shot_gap_s: float) -> float:
    return float(shot_gap_s if curr.shot_id != prev.shot_id else padding_s)


def _requested_gap_s(prev: ChunkTiming, curr: ChunkTiming, padding_s: float, shot_gap_s: float) -> float:
    if prev.next_gap_ms is None:
        return _default_gap_s(prev, curr, padding_s, shot_gap_s)
    return float(prev.next_gap_ms) / 1000.0


def compute_timeline_layout(
    chunks: Sequence[ChunkTiming],
    padding_s: float,
    shot_gap_s: float,
    *,
    min_next_start_offset_s: float = MIN_NEXT_START_OFFSET_S,
) -> TimelineLayout:
    """Return offsets plus requested/effective boundary gaps for timeline mixing.

    ``next_gap_ms`` lives on the previous chunk. Positive values add silence;
    negative values overlap the next chunk with the tail of the previous one.
    Very negative values are clamped so the next chunk cannot start before
    ``previous_start + min_next_start_offset_s``.
    """
    if not chunks:
        return TimelineLayout([], [], [], 0.0)

    offsets: list[float] = [0.0]
    requested_gaps: list[float] = []
    effective_gaps: list[float] = []

    for prev, curr in zip(chunks, chunks[1:]):
        requested = _requested_gap_s(prev, curr, padding_s, shot_gap_s)
        previous_start = offsets[-1]
        nominal_start = previous_start + float(prev.duration_s) + requested
        min_start = previous_start + max(0.0, float(min_next_start_offset_s))
        start = max(nominal_start, min_start)
        requested_gaps.append(requested)
        effective_gaps.append(start - (previous_start + float(prev.duration_s)))
        offsets.append(start)

    total_duration = max(
        (offset + max(0.0, float(chunk.duration_s)) for chunk, offset in zip(chunks, offsets)),
        default=0.0,
    )
    return TimelineLayout(offsets, requested_gaps, effective_gaps, total_duration)


def compute_total_duration(
    chunks: Sequence[ChunkTiming],
    padding_s: float,
    shot_gap_s: float,
) -> float:
    """Return the total episode duration produced by :func:`compute_chunk_offsets`."""
    return compute_timeline_layout(chunks, padding_s, shot_gap_s).total_duration_s


def compute_gap_sequence(
    chunks: Sequence[ChunkTiming],
    padding_s: float,
    shot_gap_s: float,
) -> list[float]:
    """Return the gap in seconds between consecutive chunks.

    Length is ``len(chunks) - 1``. The caller uses this to look up the
    right silence file when building the ffmpeg concat list.
    """
    return compute_timeline_layout(chunks, padding_s, shot_gap_s).effective_gaps


# ---------------------------------------------------------------------------
# SRT parsing / merging
# ---------------------------------------------------------------------------


_TIMESTAMP_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)


@dataclass
class SrtCue:
    start_s: float
    end_s: float
    text: str


def _parse_timestamp(h: str, m: str, s: str, ms: str) -> float:
    return (
        int(h) * 3600
        + int(m) * 60
        + int(s)
        + int(ms.ljust(3, "0")[:3]) / 1000.0
    )


def format_srt_timestamp(seconds: float) -> str:
    """Format ``seconds`` as ``HH:MM:SS,mmm`` with zero-padding.

    Negative inputs are clamped to 0; rounding is to the nearest millisecond.
    """
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    ms = total_ms % 1000
    total_s = total_ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(content: str) -> list[SrtCue]:
    """Parse an SRT string into a list of cues.

    Tolerant to:

    * Leading BOM.
    * CRLF or LF line endings.
    * Missing or non-contiguous cue numbers (they are ignored — output
      renumbering happens in :func:`merge_srt_files`).
    * Extra blank lines between cues.
    """
    if not content:
        return []
    text = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    cues: list[SrtCue] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        if not block.strip():
            continue
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        # Find the timestamp line (usually line 0 or 1).
        ts_idx = None
        for i, line in enumerate(lines):
            if _TIMESTAMP_RE.search(line):
                ts_idx = i
                break
        if ts_idx is None:
            continue
        m = _TIMESTAMP_RE.search(lines[ts_idx])
        assert m is not None
        start = _parse_timestamp(m.group(1), m.group(2), m.group(3), m.group(4))
        end = _parse_timestamp(m.group(5), m.group(6), m.group(7), m.group(8))
        body = "\n".join(lines[ts_idx + 1 :]).strip()
        cues.append(SrtCue(start_s=start, end_s=end, text=body))
    return cues


def merge_srt_files(srt_strings: Sequence[str], offsets: Sequence[float]) -> str:
    """Merge per-chunk SRT files into one episode SRT.

    Each chunk's cues are shifted by the corresponding offset and the
    result is renumbered from 1. The returned string always ends with a
    single trailing newline.

    Raises:
        ValueError: if ``len(srt_strings) != len(offsets)``.
    """
    if len(srt_strings) != len(offsets):
        raise ValueError(
            f"merge_srt_files: len(srt_strings)={len(srt_strings)} != "
            f"len(offsets)={len(offsets)}"
        )

    merged: list[SrtCue] = []
    for raw, offset in zip(srt_strings, offsets):
        for cue in parse_srt(raw):
            merged.append(
                SrtCue(
                    start_s=cue.start_s + float(offset),
                    end_s=cue.end_s + float(offset),
                    text=cue.text,
                )
            )

    out_lines: list[str] = []
    for i, cue in enumerate(merged, start=1):
        out_lines.append(str(i))
        out_lines.append(
            f"{format_srt_timestamp(cue.start_s)} --> "
            f"{format_srt_timestamp(cue.end_s)}"
        )
        out_lines.append(cue.text if cue.text else "")
        out_lines.append("")  # blank separator
    return "\n".join(out_lines).rstrip("\n") + "\n" if out_lines else ""


# ---------------------------------------------------------------------------
# ffmpeg concat list
# ---------------------------------------------------------------------------


def _escape_concat_path(p: Path) -> str:
    """Escape a filesystem path for use inside an ffmpeg ``concat`` demuxer list.

    ffmpeg's concat demuxer accepts ``file 'path'`` with single-quote
    wrapping; literal single quotes inside the path must be written as
    ``'\\''``. We always emit an absolute path so the list is position
    independent of the current working directory.
    """
    abs_path = str(Path(p).resolve())
    escaped = abs_path.replace("'", "'\\''")
    return f"file '{escaped}'"


def build_ffmpeg_concat_list(entries: Sequence[Path]) -> str:
    """Build the body of an ffmpeg ``-f concat -safe 0`` list file.

    The caller is responsible for interleaving chunk WAVs and silence WAVs
    in the correct order; this function preserves that order exactly and
    only worries about path escaping.

    Returns:
        A string ending in a single newline, suitable for writing to
        ``list.txt`` and passing to ``ffmpeg -f concat -safe 0 -i list.txt``.
    """
    if not entries:
        return ""
    return "\n".join(_escape_concat_path(e) for e in entries) + "\n"


def interleave_with_silences(
    audio_files: Sequence[Path],
    gaps: Sequence[float],
    silences: dict[float, Path],
) -> list[Path]:
    """Weave chunk WAVs together with the right silence file between each pair.

    ``len(gaps)`` must equal ``len(audio_files) - 1``. Each gap value is
    looked up in ``silences``; missing keys raise ``KeyError`` so bugs
    surface loudly rather than silently producing the wrong audio.
    """
    n = len(audio_files)
    if n == 0:
        return []
    if len(gaps) != n - 1:
        raise ValueError(
            f"interleave_with_silences: len(gaps)={len(gaps)} must equal "
            f"len(audio_files)-1={n - 1}"
        )
    result: list[Path] = [Path(audio_files[0])]
    for gap, audio in zip(gaps, audio_files[1:]):
        if gap > 0:
            if gap not in silences:
                raise KeyError(f"no silence file registered for gap={gap}s")
            result.append(silences[gap])
        result.append(Path(audio))
    return result


# ---------------------------------------------------------------------------
# Subprocess wrappers (the only non-pure code in this module)
# ---------------------------------------------------------------------------


async def run_ffmpeg_concat(list_file: Path, output: Path) -> None:
    """Run ``ffmpeg -f concat -safe 0 -i list_file -c copy output``.

    Uses stream copy (``-c copy``) which is safe because all chunk WAVs +
    silence segments are assumed to share the same codec / sample rate /
    channel layout (16 kHz / mono / 16-bit PCM, per the A7-P6 brief).

    Raises:
        RuntimeError: if ffmpeg exits non-zero. The message includes the
            tail of stderr so Prefect retry logs are actionable.
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_file),
        "-c",
        "copy",
        str(output),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        tail = stderr.decode("utf-8", errors="replace")[-2000:]
        raise RuntimeError(
            f"ffmpeg concat failed (exit={proc.returncode}): "
            f"{shlex.join(cmd)}\n---stderr---\n{tail}"
        )


async def run_ffmpeg_timeline_mix(
    audio_files: Sequence[Path],
    offsets: Sequence[float],
    output: Path,
    *,
    sample_rate: int = 16000,
    channels: int = 1,
) -> None:
    """Render audio files at absolute offsets into one WAV timeline.

    This is used by final P6 rendering and by gap preview so previewed
    negative overlaps match the actual exported episode.
    """
    if not audio_files:
        raise ValueError("run_ffmpeg_timeline_mix requires at least one audio file")
    if len(audio_files) != len(offsets):
        raise ValueError(
            f"run_ffmpeg_timeline_mix: len(audio_files)={len(audio_files)} != "
            f"len(offsets)={len(offsets)}"
        )

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    for path in audio_files:
        cmd.extend(["-i", str(path)])

    filter_parts: list[str] = []
    labels: list[str] = []
    for index, offset in enumerate(offsets):
        delay_ms = int(round(max(0.0, float(offset)) * 1000))
        label = f"a{index}"
        filter_parts.append(
            f"[{index}:a]asetpts=PTS-STARTPTS,aresample={sample_rate},"
            f"adelay={delay_ms}:all=1[{label}]"
        )
        labels.append(f"[{label}]")

    if len(audio_files) == 1:
        filter_parts.append(f"{labels[0]}alimiter=limit=0.95[out]")
    else:
        filter_parts.append(
            f"{''.join(labels)}amix=inputs={len(audio_files)}:"
            "duration=longest:normalize=0,alimiter=limit=0.95[out]"
        )

    cmd.extend(
        [
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[out]",
            "-ac",
            str(channels),
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            str(output),
        ]
    )
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        tail = stderr.decode("utf-8", errors="replace")[-2000:]
        raise RuntimeError(
            f"ffmpeg timeline mix failed (exit={proc.returncode}): "
            f"{shlex.join(cmd)}\n---stderr---\n{tail}"
        )


async def generate_silence(
    path: Path,
    duration_s: float,
    *,
    sample_rate: int = 16000,
    channels: int = 1,
) -> None:
    """Generate a silent WAV at ``path`` of the given duration.

    Uses ``ffmpeg -f lavfi -i anullsrc=...``. The produced file matches
    the P2 chunk WAV format so ``-c copy`` concat is valid.
    """
    cl = "mono" if channels == 1 else "stereo"
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"anullsrc=r={sample_rate}:cl={cl}",
        "-t",
        f"{duration_s:.6f}",
        "-c:a",
        "pcm_s16le",
        str(path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        tail = stderr.decode("utf-8", errors="replace")[-2000:]
        raise RuntimeError(
            f"ffmpeg anullsrc failed (exit={proc.returncode}): "
            f"{shlex.join(cmd)}\n---stderr---\n{tail}"
        )


async def probe_duration_s(path: Path) -> float:
    """Return the duration (seconds) of an audio file via ``ffprobe``.

    Used by the integration test. Not called by the task itself — the task
    trusts ``takes.duration_s`` from the DB.
    """
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        tail = stderr.decode("utf-8", errors="replace")[-2000:]
        raise RuntimeError(
            f"ffprobe failed (exit={proc.returncode}):\n{tail}"
        )
    return float(stdout.decode("utf-8").strip() or 0.0)


__all__ = [
    "ChunkTiming",
    "TimelineLayout",
    "SrtCue",
    "MIN_NEXT_START_OFFSET_S",
    "sort_chunk_timings",
    "compute_timeline_layout",
    "compute_chunk_offsets",
    "compute_total_duration",
    "compute_gap_sequence",
    "parse_srt",
    "merge_srt_files",
    "format_srt_timestamp",
    "build_ffmpeg_concat_list",
    "interleave_with_silences",
    "run_ffmpeg_concat",
    "run_ffmpeg_timeline_mix",
    "generate_silence",
    "probe_duration_s",
]
