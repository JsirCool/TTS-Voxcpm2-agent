"""finalize-take — mini flow: set selected take and run downstream stages.

When a user picks a specific take for a chunk (e.g. after listening to
multiple P2 outputs), this flow:

1. Sets ``chunk.selected_take_id`` to the chosen take.
2. Runs P3 → P5 (downstream per-chunk stages).

P6 is NOT run here — it is per-episode and must be triggered separately
once all chunks are finalized.
"""

from __future__ import annotations

import logging

from prefect import flow

from server.core.domain import DomainError, P3Result, P5Result

log = logging.getLogger(__name__)


@flow(name="finalize-take")
async def finalize_take_flow(
    ep_id: str,
    cid: str,
    take_id: str,
    language: str = "zh",
) -> dict:
    """Set selected take and cascade P3 → P5.

    Parameters
    ----------
    ep_id
        Episode ID (used for event context).
    cid
        Chunk ID.
    take_id
        Take ID to select.
    language
        Language code for P3 transcription.
    """
    log.info("finalize-take: ep=%s cid=%s take=%s", ep_id, cid, take_id)

    # 1. Set selected_take_id in DB.
    await _set_selected_take(cid, take_id, ep_id)

    # 2. Run P3 → P5 downstream.
    from server.flows.tasks.p3_transcribe import p3_transcribe
    from server.flows.tasks.p5_subtitles import p5_subtitles

    p3_result: P3Result = await p3_transcribe(cid, language=language)
    p5_result: P5Result = await p5_subtitles(cid)

    return {
        "p3": p3_result,
        "p5": p5_result,
    }


async def _set_selected_take(chunk_id: str, take_id: str, episode_id: str) -> None:
    """Validate the take exists and set it as the chunk's selected take."""
    from server.flows.tasks.p3_transcribe import _require_deps, _session_scope
    from server.core.repositories import ChunkRepo, TakeRepo
    from server.core.events import write_event

    session_factory, _ = _require_deps()

    async with _session_scope(session_factory) as session:
        chunk = await ChunkRepo(session).get(chunk_id)
        if chunk is None:
            raise DomainError("not_found", f"chunk not found: {chunk_id}")

        take = await TakeRepo(session).select(take_id)
        if take is None:
            raise DomainError("not_found", f"take not found: {take_id}")
        if take.chunk_id != chunk_id:
            raise DomainError(
                "invalid_input",
                f"take {take_id} does not belong to chunk {chunk_id}",
            )

        await ChunkRepo(session).set_selected_take(chunk_id, take_id)
        await write_event(
            session,
            episode_id=episode_id,
            chunk_id=chunk_id,
            kind="take_finalized",
            payload={"take_id": take_id},
        )
        await session.commit()

    log.info("Selected take %s for chunk %s", take_id, chunk_id)


__all__ = ["finalize_take_flow"]
