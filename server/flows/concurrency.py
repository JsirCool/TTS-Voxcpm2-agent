"""Register Prefect concurrency limits for the local VoxCPM synth service.

Per ADR-001 section 4.3, P2 synthesis uses a global concurrency limit enforced
via the ``voxcpm-local`` tag on the task. This helper registers or updates
that limit programmatically.

Usage:
    python -m server.flows.concurrency

Or call ``register_limits()`` from the deployment setup script.
"""

from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)

# Local VoxCPM concurrency limit.
# Adjust based on available GPU memory / throughput.
VOXCPM_LOCAL_CONCURRENCY = 3


async def register_limits() -> None:
    """Register all concurrency limits with the Prefect server."""
    from prefect.client.orchestration import get_client

    async with get_client() as client:
        await client.create_concurrency_limit(
            tag="voxcpm-local",
            concurrency_limit=VOXCPM_LOCAL_CONCURRENCY,
        )
        log.info(
            "Registered concurrency limit: voxcpm-local = %d",
            VOXCPM_LOCAL_CONCURRENCY,
        )


def main() -> None:
    """CLI entry point."""
    logging.basicConfig(level=logging.INFO)
    asyncio.run(register_limits())


if __name__ == "__main__":
    main()


__all__ = ["register_limits", "VOXCPM_LOCAL_CONCURRENCY"]
