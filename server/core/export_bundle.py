"""Build Remotion-friendly export bundles for an episode."""

from __future__ import annotations

import hashlib
import io
import json
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
    compute_chunk_offsets,
    generate_silence,
    parse_srt,
    sort_chunk_timings,
)
from server.core.repositories import TakeRepo
from server.core.storage import MinIOStorage, chunk_subtitle_key

DEFAULT_EXPORT_FPS = 30
PADDING_S = 0.2
SHOT_GAP_S = 0.5


@dataclass
class ExportBundle:
    episode_id: str
    files: dict[str, bytes]
    durations: list[dict[str, Any]]
    subtitles: dict[str, list[dict[str, Any]]]
    manifest: dict[str, Any]


def compute_export_cache_key(
    *,
    episode_id: str,
    episode_title: str | None,
    chunks: Sequence[Chunk],
    selected_takes: dict[str, Any],
    fps: int = DEFAULT_EXPORT_FPS,
) -> str:
    payload: dict[str, Any] = {
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
    storage: MinIOStorage,
    fps: int = DEFAULT_EXPORT_FPS,
    selected_takes: dict[str, Any] | None = None,
    episode_title: str | None = None,
    cache_key: str | None = None,
) -> ExportBundle:
    items_by_shot: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for chunk in sorted(chunks, key=lambda item: (item.shot_id, item.idx)):
        if chunk.selected_take_id and chunk.status in ("verified", "synth_done", "needs_review"):
            take = selected_takes.get(chunk.selected_take_id) if selected_takes is not None else None
            if take is None:
                take = await take_repo.select(chunk.selected_take_id)
            if take:
                items_by_shot[chunk.shot_id].append({"chunk": chunk, "take": take})

    if not items_by_shot:
        raise ValueError("no exportable chunks")

    files: dict[str, bytes] = {}
    durations: list[dict[str, Any]] = []
    subtitles_by_shot: dict[str, list[dict[str, Any]]] = {}
    manifest_shots: list[dict[str, Any]] = []
    cumulative_start_s = 0.0

    for shot_id, items in items_by_shot.items():
        timings = sort_chunk_timings([
            ChunkTiming(
                chunk_id=item["chunk"].id,
                shot_id=shot_id,
                idx=item["chunk"].idx,
                duration_s=float(item["take"].duration_s or 0.0),
            )
            for item in items
        ])
        offsets = compute_chunk_offsets(timings, PADDING_S, SHOT_GAP_S)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            concat_entries: list[Path] = []
            sil_padding = tmp_path / "sil_padding.wav"
            await generate_silence(sil_padding, PADDING_S, sample_rate=44100)

            for index, item in enumerate(items):
                take = item["take"]
                audio_key = (
                    take.audio_uri.split("//", 1)[-1].split("/", 1)[-1]
                    if take.audio_uri.startswith("s3://")
                    else take.audio_uri
                )
                wav_bytes = await storage.download_bytes(audio_key)
                chunk_wav = tmp_path / f"chunk_{index:03d}.wav"
                chunk_wav.write_bytes(wav_bytes)
                if index > 0:
                    concat_entries.append(sil_padding)
                concat_entries.append(chunk_wav)

            if len(concat_entries) == 1:
                shot_wav_bytes = concat_entries[0].read_bytes()
            else:
                concat_list = tmp_path / "concat.txt"
                concat_list.write_text(
                    "\n".join(f"file '{path.resolve()}'" for path in concat_entries),
                    encoding="utf-8",
                )
                shot_wav = tmp_path / f"{shot_id}.wav"
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
                        "44100",
                        "-ac",
                        "1",
                        "-c:a",
                        "pcm_s16le",
                        str(shot_wav),
                    ],
                    capture_output=True,
                    timeout=30,
                    check=False,
                )
                if proc.returncode != 0:
                    raise RuntimeError(proc.stderr.decode("utf-8", errors="replace") or "ffmpeg concat failed")
                shot_wav_bytes = shot_wav.read_bytes()

        files[f"{shot_id}.wav"] = shot_wav_bytes

        try:
            with io.BytesIO(shot_wav_bytes) as wav_buffer:
                with wave.open(wav_buffer) as wav_file:
                    duration_s = wav_file.getnframes() / wav_file.getframerate()
        except Exception:
            duration_s = sum(float(item["take"].duration_s or 0.0) for item in items)

        durations.append({
            "id": shot_id,
            "duration_s": round(duration_s, 3),
            "file": f"{shot_id}.wav",
        })

        shot_subtitles: list[dict[str, Any]] = []
        subtitle_index = len([cue for cues in subtitles_by_shot.values() for cue in cues])
        for timing, offset in zip(timings, offsets):
            sub_key = chunk_subtitle_key(episode_id, timing.chunk_id)
            try:
                srt_bytes = await storage.download_bytes(sub_key)
                cues = parse_srt(srt_bytes.decode("utf-8"))
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

        start_s = round(cumulative_start_s, 3)
        end_s = round(cumulative_start_s + duration_s, 3)
        manifest_shots.append({
            "id": shot_id,
            "audioFile": f"{shot_id}.wav",
            "durationS": round(duration_s, 3),
            "startS": start_s,
            "endS": end_s,
            "startFrame": int(round(start_s * fps)),
            "endFrame": int(round(end_s * fps)),
            "chunkIds": [item["chunk"].id for item in items],
            "subtitleCount": len(shot_subtitles),
            "subtitles": shot_subtitles,
        })
        cumulative_start_s += duration_s

    manifest = {
        "episodeId": episode_id,
        "episodeTitle": episode_title or episode_id,
        "fps": fps,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "cacheKey": cache_key,
        "paddingS": PADDING_S,
        "shotGapS": SHOT_GAP_S,
        "durationsFile": "durations.json",
        "subtitlesFile": "subtitles.json",
        "totalDurationS": round(cumulative_start_s, 3),
        "totalFrames": int(ceil(cumulative_start_s * fps)),
        "shotCount": len(manifest_shots),
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
