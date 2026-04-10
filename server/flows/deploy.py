"""Prefect deployment registration script.

Registers the three deployments defined in ADR-002 §3.5:

  - run-episode
  - retry-chunk-stage
  - finalize-take

Usage:
    python -m server.flows.deploy

This should be run once after starting the Prefect server, before
submitting any flow runs. It is idempotent — re-running updates
existing deployments.
"""

from __future__ import annotations

import asyncio
import logging

from prefect import serve

from server.flows.run_episode import run_episode_flow
from server.flows.retry_chunk import retry_chunk_stage_flow
from server.flows.finalize_take import finalize_take_flow
from server.flows.concurrency import register_limits

log = logging.getLogger(__name__)


async def register_deployments() -> None:
    """Register all deployments and concurrency limits."""
    # Register concurrency limits first.
    await register_limits()
    log.info("Concurrency limits registered")

    # Create deployment objects.
    run_episode_deploy = run_episode_flow.to_deployment(
        name="run-episode",
        description="Full P1 → P2 → P3 → P5 → P6 pipeline for one episode.",
    )

    retry_chunk_deploy = retry_chunk_stage_flow.to_deployment(
        name="retry-chunk-stage",
        description="Re-run a single chunk from a given stage, optionally cascading downstream.",
    )

    finalize_take_deploy = finalize_take_flow.to_deployment(
        name="finalize-take",
        description="Set selected take and cascade P3 → P5 for a single chunk.",
    )

    log.info("Starting deployment serve...")
    await serve(
        run_episode_deploy,
        retry_chunk_deploy,
        finalize_take_deploy,
    )


def main() -> None:
    """CLI entry point."""
    logging.basicConfig(level=logging.INFO)
    asyncio.run(register_deployments())


if __name__ == "__main__":
    main()


__all__ = ["register_deployments"]
