"""run-episode — main Prefect flow orchestrating P1 → P2 → P3 → P5 → P6.

This flow is the primary entry point for processing a complete episode.
It runs P1 (chunking) first, then fans out P2/P3/P5 across all chunks,
and finishes with P6 (concat) to produce the final episode WAV + SRT.

Stages:
  P1: per-episode, sequential
  P2: per-chunk, fan-out (tags=["fish-api"] for concurrency limit)
  P3: per-chunk, fan-out (HTTP to whisperx-svc)
  P5: per-chunk, fan-out
  P6: per-episode, sequential

Status transitions:
  episode: empty → ready (P1) → running → done (P6)
  chunk: pending → synth_done (P2) → transcribed (P3) → transcribed (stays)
"""

from __future__ import annotations

import logging

from prefect import flow

from server.core.domain import P1Result, P6Result
from server.flows.tasks.p1_chunk import P1Context, p1_chunk
from server.flows.tasks.p2_synth import p2_synth
from server.flows.tasks.p3_transcribe import p3_transcribe
from server.flows.tasks.p5_subtitles import p5_subtitles
from server.flows.tasks.p6_concat import p6_concat

log = logging.getLogger(__name__)


@flow(name="run-episode")
async def run_episode_flow(
    ep_id: str,
    *,
    language: str = "zh",
    padding_ms: int = 200,
    shot_gap_ms: int = 500,
) -> P6Result:
    """Orchestrate the full P1 → P2 → P3 → P5 → P6 pipeline for one episode.

    Parameters
    ----------
    ep_id
        Episode ID.
    language
        Language code passed to WhisperX (default ``"zh"``).
    padding_ms
        Inter-chunk silence padding in ms (P6).
    shot_gap_ms
        Inter-shot gap silence in ms (P6).
    """
    log.info("run-episode starting for %s", ep_id)

    # --- P1: chunking (per-episode) ---
    from server.flows.worker_bootstrap import get_p1_context

    ctx = get_p1_context()
    p1_result: P1Result = await p1_chunk(ep_id, ctx=ctx)
    chunk_ids = [c.id for c in p1_result.chunks]
    log.info("P1 complete: %d chunks", len(chunk_ids))

    # --- P2: TTS synthesis (fan-out, per-chunk) ---
    p2_futures = p2_synth.map(chunk_ids)
    p2_results = [await f.result() for f in p2_futures]
    log.info("P2 complete: %d takes", len(p2_results))

    # --- P3: transcription (fan-out, per-chunk) ---
    p3_futures = p3_transcribe.map(chunk_ids, [language] * len(chunk_ids))
    p3_results = [await f.result() for f in p3_futures]
    log.info("P3 complete: %d transcripts", len(p3_results))

    # --- P5: subtitles (fan-out, per-chunk) ---
    p5_futures = p5_subtitles.map(chunk_ids)
    p5_results = [await f.result() for f in p5_futures]
    log.info("P5 complete: %d subtitles", len(p5_results))

    # --- P6: concat (per-episode) ---
    p6_result: P6Result = await p6_concat(
        ep_id,
        padding_ms=padding_ms,
        shot_gap_ms=shot_gap_ms,
    )
    log.info("P6 complete: %s", p6_result.wav_uri)

    return p6_result


__all__ = ["run_episode_flow"]
