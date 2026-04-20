"""Worker bootstrap — call once when the Prefect worker process starts.

Sets up DB engine, MinIO client, and injects into all task modules via
their ``configure_*_dependencies()`` functions. This is the single
wiring point; tasks themselves never read environment variables or
construct clients.

Usage (in Prefect worker entrypoint or ``__main__``):

    from server.flows.worker_bootstrap import bootstrap
    bootstrap()

For P1, which uses a ``P1Context`` dataclass instead of the module-level
DI pattern, use :func:`get_p1_context` after bootstrapping.
"""

from __future__ import annotations

import logging
import os

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
)

from server.core.runtime_mode import apply_desktop_defaults
from server.core.storage import StorageBackend, build_storage_from_env
from server.flows.tasks.p1_chunk import P1Context

log = logging.getLogger(__name__)

# Module-level state set by bootstrap().
_session_factory: async_sessionmaker[AsyncSession] | None = None
_storage: StorageBackend | None = None
_bootstrapped = False


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def bootstrap() -> None:
    """Initialize all task dependencies from environment variables.

    Safe to call multiple times — subsequent calls are no-ops.
    """
    global _session_factory, _storage, _bootstrapped

    if _bootstrapped:
        log.debug("worker_bootstrap: already bootstrapped, skipping")
        return

    apply_desktop_defaults()
    from server.core.db import get_sessionmaker

    _session_factory = get_sessionmaker()

    _storage = build_storage_from_env()

    # Wire P2.
    from server.flows.tasks.p2_synth import configure_p2_dependencies
    from server.core.voxcpm_client import VoxCPMClient

    voxcpm_url = _env("VOXCPM_URL", "http://127.0.0.1:8877")

    def _voxcpm_factory() -> VoxCPMClient:
        return VoxCPMClient(url=voxcpm_url)

    configure_p2_dependencies(
        session_factory=_session_factory,
        storage=_storage,
        voxcpm_client_factory=_voxcpm_factory,
    )

    # Wire P3 (kept for backward compat).
    from server.flows.tasks.p3_transcribe import configure_p3_dependencies

    whisperx_url = _env("WHISPERX_URL", "http://whisperx-svc:7860")
    configure_p3_dependencies(
        session_factory=_session_factory,
        storage=_storage,
        whisperx_url=whisperx_url,
    )

    # Wire P2v (verify = ASR + quality gate).
    from server.flows.tasks.p2v_verify import configure_p2v_dependencies

    configure_p2v_dependencies(
        session_factory=_session_factory,
        storage=_storage,
        whisperx_url=whisperx_url,
    )

    # Wire P1c (input validation).
    from server.flows.tasks.p1c_check import configure_p1c_dependencies

    configure_p1c_dependencies(
        session_factory=_session_factory,
    )

    # Wire P2c (WAV format check).
    from server.flows.tasks.p2c_check import configure_p2c_dependencies

    configure_p2c_dependencies(
        session_factory=_session_factory,
        storage=_storage,
    )

    # Wire P6v (end-to-end validation).
    from server.flows.tasks.p6v_check import configure_p6v_dependencies

    configure_p6v_dependencies(
        session_factory=_session_factory,
        storage=_storage,
    )

    # Wire P5.
    from server.flows.tasks.p5_subtitles import configure_p5_dependencies

    configure_p5_dependencies(
        session_factory=_session_factory,
        storage=_storage,
    )

    # P6
    from server.flows.tasks.p6_concat import configure_p6_dependencies

    configure_p6_dependencies(
        session_factory=_session_factory,
        storage=_storage,
    )

    # P1 uses a different DI pattern (P1Context dataclass) — wired via
    # get_p1_context() below.

    _bootstrapped = True
    log.info("worker_bootstrap: all task dependencies configured")


def get_p1_context() -> P1Context:
    """Return a P1Context using the bootstrapped session factory + storage.

    Must be called after :func:`bootstrap`.
    """
    if _session_factory is None or _storage is None:
        raise RuntimeError(
            "worker not bootstrapped. Call bootstrap() first."
        )
    return P1Context(session_maker=_session_factory, storage=_storage)


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Return the bootstrapped session factory (for flows that need it)."""
    if _session_factory is None:
        raise RuntimeError("worker not bootstrapped. Call bootstrap() first.")
    return _session_factory


def get_storage() -> StorageBackend:
    """Return the bootstrapped storage instance (for flows that need it)."""
    if _storage is None:
        raise RuntimeError("worker not bootstrapped. Call bootstrap() first.")
    return _storage


__all__ = ["bootstrap", "get_p1_context", "get_session_factory", "get_storage"]
