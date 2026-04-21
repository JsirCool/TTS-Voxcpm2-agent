"""Build Remotion-friendly export bundles for an episode."""

from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import tempfile
import wave
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from math import ceil
from pathlib import Path
from typing import Any, Sequence

from server.core.models import Chunk
from server.core.p6_logic import (
    ChunkTiming,
    compute_timeline_layout,
    generate_silence,
    merge_srt_files,
    parse_srt,
    run_ffmpeg_timeline_mix,
    sort_chunk_timings,
)
from server.core.repositories import TakeRepo
from server.core.runtime_mode import repo_root
from server.core.storage import (
    LocalFSStorage,
    StorageBackend,
    chunk_subtitle_key,
    final_srt_key,
    storage_uri_to_key,
)

DEFAULT_EXPORT_FPS = 30
PADDING_S = 0.0
SHOT_GAP_S = 0.0
EXPORT_BUNDLE_VERSION = 2


def _localfs_storage_from_uri(uri: str) -> LocalFSStorage | None:
    raw = (uri or "").strip()
    if not raw.startswith("localfs://"):
        return None
    bucket_and_key = raw.split("://", 1)[1].split("?", 1)[0].strip("/")
    bucket = bucket_and_key.split("/", 1)[0] or os.environ.get("MINIO_BUCKET", "tts-harness")
    root = os.environ.get("HARNESS_LOCAL_STORAGE_DIR")
    if root is None:
        root = str((repo_root() / ".desktop-runtime" / "data" / "storage").resolve())
    return LocalFSStorage(root_dir=Path(root), bucket=bucket)


async def _download_bytes(
    storage: StorageBackend,
    key: str,
    *,
    fallback_storage: StorageBackend | None = None,
) -> bytes:
    try:
        return await storage.download_bytes(key)
    except Exception:
        if fallback_storage is None:
            raise
        return await fallback_storage.download_bytes(key)


@dataclass
class ExportBundle:
    episode_id: str
    files: dict[str, bytes]
    durations: list[dict[str, Any]]
    subtitles: dict[str, list[dict[str, Any]]]
    manifest: dict[str, Any]


async def _concat_wav_sequence(
    wav_blobs: Sequence[bytes],
    *,
    gap_s: float = 0.0,
    output_name: str,
) -> bytes:
    if not wav_blobs:
        raise ValueError("no wav blobs to concatenate")
    if len(wav_blobs) == 1 and gap_s <= 0:
        return wav_blobs[0]

    sample_rate = 44100
    channels = 1
    try:
        with io.BytesIO(wav_blobs[0]) as wav_buffer:
            with wave.open(wav_buffer) as wav_file:
                sample_rate = wav_file.getframerate()
                channels = wav_file.getnchannels()
    except Exception:
        pass

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        concat_entries: list[Path] = []
        sil_gap: Path | None = None
        if gap_s > 0:
            sil_gap = tmp_path / "sil_gap.wav"
            await generate_silence(
                sil_gap,
                gap_s,
                sample_rate=sample_rate,
                channels=channels,
            )

        for index, wav_bytes in enumerate(wav_blobs):
            chunk_wav = tmp_path / f"audio_{index:03d}.wav"
            chunk_wav.write_bytes(wav_bytes)
            if index > 0 and sil_gap is not None:
                concat_entries.append(sil_gap)
            concat_entries.append(chunk_wav)

        if len(concat_entries) == 1:
            return concat_entries[0].read_bytes()

        concat_list = tmp_path / "concat.txt"
        concat_list.write_text(
            "\n".join(f"file '{path.resolve()}'" for path in concat_entries),
            encoding="utf-8",
        )
        output_path = tmp_path / output_name
        proc = subprocess.run(
            [
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
                str(concat_list),
                "-ar",
                str(sample_rate),
                "-ac",
                str(channels),
                "-c:a",
                "pcm_s16le",
                str(output_path),
            ],
            capture_output=True,
            timeout=30,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace") or "ffmpeg concat failed")
        return output_path.read_bytes()


async def _mix_wav_sequence(
    wav_blobs: Sequence[bytes],
    offsets: Sequence[float],
    *,
    output_name: str,
) -> bytes:
    if not wav_blobs:
        raise ValueError("no wav blobs to mix")
    if len(wav_blobs) != len(offsets):
        raise ValueError("wav blob count does not match offsets")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        audio_paths: list[Path] = []
        for index, wav_bytes in enumerate(wav_blobs):
            chunk_wav = tmp_path / f"audio_{index:03d}.wav"
            chunk_wav.write_bytes(wav_bytes)
            audio_paths.append(chunk_wav)
        output_path = tmp_path / output_name
        await run_ffmpeg_timeline_mix(audio_paths, offsets, output_path)
        return output_path.read_bytes()


def compute_export_cache_key(
    *,
    episode_id: str,
    episode_title: str | None,
    chunks: Sequence[Chunk],
    selected_takes: dict[str, Any],
    fps: int = DEFAULT_EXPORT_FPS,
) -> str:
    payload: dict[str, Any] = {
        "bundleVersion": EXPORT_BUNDLE_VERSION,
        "episodeId": episode_id,
        "episodeTitle": episode_title or episode_id,
        "fps": fps,
        "paddingS": PADDING_S,
        "shotGapS": SHOT_GAP_S,
        "chunks": [],
    }
    for chunk in sorted(chunks, key=lambda item: (item.shot_id, item.idx, item.id)):
        if not chunk.selected_take_id:
            continue
        take = selected_takes.get(chunk.selected_take_id)
        if take is None:
            continue
        payload["chunks"].append({
            "id": chunk.id,
            "shotId": chunk.shot_id,
            "idx": chunk.idx,
            "status": chunk.status,
            "subtitleText": chunk.subtitle_text,
            "selectedTakeId": chunk.selected_take_id,
            "nextGapMs": getattr(chunk, "next_gap_ms", None),
            "take": {
                "id": take.id,
                "audioUri": take.audio_uri,
                "durationS": float(take.duration_s or 0.0),
                "createdAt": take.created_at.isoformat() if getattr(take, "created_at", None) else None,
                "params": take.params or {},
            },
        })
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:16]


async def build_export_bundle(
    *,
    episode_id: str,
    chunks: Sequence[Chunk],
    take_repo: TakeRepo,
    storage: StorageBackend,
    fps: int = DEFAULT_EXPORT_FPS,
    selected_takes: dict[str, Any] | None = None,
    episode_title: str | None = None,
    cache_key: str | None = None,
) -> ExportBundle:
    items_by_shot: dict[str, list[dict[str, Any]]] = defaultdict(list)
    export_items: list[dict[str, Any]] = []
    for chunk in sorted(chunks, key=lambda item: (item.shot_id, item.idx)):
        if chunk.selected_take_id and chunk.status in ("verified", "synth_done", "needs_review"):
            take = selected_takes.get(chunk.selected_take_id) if selected_takes is not None else None
            if take is None:
                take = await take_repo.select(chunk.selected_take_id)
            if take:
                item = {"chunk": chunk, "take": take}
                items_by_shot[chunk.shot_id].append(item)
                export_items.append(item)

    if not export_items:
        raise ValueError("no exportable chunks")

    files: dict[str, bytes] = {}
    durations: list[dict[str, Any]] = []
    subtitles_by_shot: dict[str, list[dict[str, Any]]] = {}
    manifest_shots: list[dict[str, Any]] = []
    chunk_timings = sort_chunk_timings([
        ChunkTiming(
            chunk_id=item["chunk"].id,
            shot_id=item["chunk"].shot_id,
            idx=item["chunk"].idx,
            duration_s=float(item["take"].duration_s or 0.0),
            next_gap_ms=getattr(item["chunk"], "next_gap_ms", None),
        )
        for item in export_items
    ])
    final_layout = compute_timeline_layout(chunk_timings, PADDING_S, SHOT_GAP_S)
    final_offsets = final_layout.offsets
    final_offset_by_chunk = {
        timing.chunk_id: offset
        for timing, offset in zip(chunk_timings, final_offsets)
    }
    effective_gap_ms_by_chunk = {
        timing.chunk_id: int(round(gap * 1000))
        for timing, gap in zip(chunk_timings, final_layout.effective_gaps)
    }
    chunk_manifest_by_id: dict[str, dict[str, Any]] = {}
    for timing, start_s in zip(chunk_timings, final_offsets):
        chunk_obj = next(item["chunk"] for item in export_items if item["chunk"].id == timing.chunk_id)
        chunk_manifest_by_id[timing.chunk_id] = {
            "id": timing.chunk_id,
            "shotId": timing.shot_id,
            "idx": timing.idx,
            "startS": round(start_s, 3),
            "durationS": round(float(timing.duration_s), 3),
            "nextGapMs": getattr(chunk_obj, "next_gap_ms", None),
            "effectiveGapMs": effective_gap_ms_by_chunk.get(timing.chunk_id),
        }
    raw_srt_by_chunk: dict[str, str] = {}
    audio_blobs_by_chunk: dict[str, bytes] = {}
    shot_gap_count = max(len(items_by_shot) - 1, 0)
    localfs_fallback: StorageBackend | None = None
    for item in export_items:
        localfs_fallback = _localfs_storage_from_uri(item["take"].audio_uri)
        if localfs_fallback is not None:
            break

    for _shot_index, (shot_id, items) in enumerate(items_by_shot.items()):
        timings = sort_chunk_timings([
            ChunkTiming(
                chunk_id=item["chunk"].id,
                shot_id=shot_id,
                idx=item["chunk"].idx,
                duration_s=float(item["take"].duration_s or 0.0),
                next_gap_ms=getattr(item["chunk"], "next_gap_ms", None),
            )
            for item in items
        ])
        shot_layout = compute_timeline_layout(timings, PADDING_S, SHOT_GAP_S)
        offsets = shot_layout.offsets
        chunk_wav_blobs: list[bytes] = []
        for item in items:
            take = item["take"]
            audio_key = storage_uri_to_key(take.audio_uri)
            wav_bytes = await _download_bytes(
                storage,
                audio_key,
                fallback_storage=_localfs_storage_from_uri(take.audio_uri),
            )
            chunk_wav_blobs.append(wav_bytes)
            audio_blobs_by_chunk[item["chunk"].id] = wav_bytes
        shot_wav_bytes = await _mix_wav_sequence(
            chunk_wav_blobs,
            offsets,
            output_name=f"{shot_id}.wav",
        )

        files[f"{shot_id}.wav"] = shot_wav_bytes

        try:
            with io.BytesIO(shot_wav_bytes) as wav_buffer:
                with wave.open(wav_buffer) as wav_file:
                    duration_s = wav_file.getnframes() / wav_file.getframerate()
        except Exception:
            duration_s = shot_layout.total_duration_s

        durations.append({
            "id": shot_id,
            "duration_s": round(duration_s, 3),
            "file": f"{shot_id}.wav",
            "chunks": [
                chunk_manifest_by_id[timing.chunk_id]
                for timing in timings
            ],
        })

        shot_subtitles: list[dict[str, Any]] = []
        subtitle_index = len([cue for cues in subtitles_by_shot.values() for cue in cues])
        for timing, offset in zip(timings, offsets):
            sub_key = chunk_subtitle_key(episode_id, timing.chunk_id)
            try:
                srt_bytes = await _download_bytes(
                    storage,
                    sub_key,
                    fallback_storage=localfs_fallback,
                )
                raw_srt = srt_bytes.decode("utf-8")
                raw_srt_by_chunk[timing.chunk_id] = raw_srt
                cues = parse_srt(raw_srt)
            except Exception:
                continue
            for cue in cues:
                subtitle_index += 1
                shot_subtitles.append({
                    "id": f"sub_{subtitle_index:03d}",
                    "text": cue.text,
                    "start": round(cue.start_s + offset, 3),
                    "end": round(cue.end_s + offset, 3),
                })

        if shot_subtitles:
            subtitles_by_shot[shot_id] = shot_subtitles

        global_starts = [final_offset_by_chunk[timing.chunk_id] for timing in timings]
        start_s = round(min(global_starts), 3)
        end_s = round(max(
            final_offset_by_chunk[timing.chunk_id] + float(timing.duration_s)
            for timing in timings
        ), 3)
        manifest_shots.append({
            "id": shot_id,
            "audioFile": f"{shot_id}.wav",
            "durationS": round(duration_s, 3),
            "startS": start_s,
            "endS": end_s,
            "startFrame": int(round(start_s * fps)),
            "endFrame": int(round(end_s * fps)),
            "chunkIds": [item["chunk"].id for item in items],
            "chunks": [
                chunk_manifest_by_id[timing.chunk_id]
                for timing in timings
            ],
            "subtitleCount": len(shot_subtitles),
            "subtitles": shot_subtitles,
        })

    final_wav_bytes = await _mix_wav_sequence(
        [audio_blobs_by_chunk[timing.chunk_id] for timing in chunk_timings],
        final_offsets,
        output_name="episode.wav",
    )
    files["episode.wav"] = final_wav_bytes

    merged_srt_inputs: list[str] = []
    merged_srt_offsets: list[float] = []
    for timing in chunk_timings:
        raw_srt = raw_srt_by_chunk.get(timing.chunk_id)
        if raw_srt is None:
            continue
        merged_srt_inputs.append(raw_srt)
        merged_srt_offsets.append(final_offset_by_chunk[timing.chunk_id])
    if merged_srt_inputs:
        final_srt_text = merge_srt_files(merged_srt_inputs, merged_srt_offsets)
        final_srt_bytes = final_srt_text.encode("utf-8")
    else:
        try:
            final_srt_bytes = await _download_bytes(
                storage,
                final_srt_key(episode_id),
                fallback_storage=localfs_fallback,
            )
        except Exception:
            final_srt_bytes = b""
    files["episode.srt"] = final_srt_bytes

    manifest = {
        "episodeId": episode_id,
        "episodeTitle": episode_title or episode_id,
        "bundleVersion": EXPORT_BUNDLE_VERSION,
        "fps": fps,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "cacheKey": cache_key,
        "paddingS": PADDING_S,
        "shotGapS": SHOT_GAP_S,
        "finalAudioFile": "episode.wav",
        "finalSubtitleFile": "episode.srt",
        "durationsFile": "durations.json",
        "subtitlesFile": "subtitles.json",
        "totalDurationS": round(final_layout.total_duration_s, 3),
        "totalFrames": int(ceil(final_layout.total_duration_s * fps)),
        "shotCount": len(manifest_shots),
        "shotGapCount": shot_gap_count,
        "chunks": [
            chunk_manifest_by_id[timing.chunk_id]
            for timing in chunk_timings
        ],
        "shots": manifest_shots,
    }

    files["subtitles.json"] = json.dumps(
        subtitles_by_shot,
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")
    files["durations.json"] = json.dumps(
        durations,
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")
    files["remotion-manifest.json"] = json.dumps(
        manifest,
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")

    return ExportBundle(
        episode_id=episode_id,
        files=files,
        durations=durations,
        subtitles=subtitles_by_shot,
        manifest=manifest,
    )


def write_export_bundle_to_directory(
    bundle: ExportBundle,
    directory: str,
    *,
    nest_episode_dir: bool = True,
) -> str:
    base_directory = Path(directory).expanduser().resolve()
    target_root = base_directory / bundle.episode_id if nest_episode_dir else base_directory
    target_root.mkdir(parents=True, exist_ok=True)
    for relative_path, content in bundle.files.items():
        output_path = target_root / relative_path
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(content)
    return str(target_root)
