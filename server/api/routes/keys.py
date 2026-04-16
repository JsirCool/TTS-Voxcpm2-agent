"""Local service status routes.

Historically this module stored Fish/Groq API keys. The harness now runs
entirely against local services, so the same UI entry point reports the health
of VoxCPM and WhisperX instead.
"""

from __future__ import annotations

import os

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["services"])

DEFAULT_VOXCPM_URL = os.environ.get("VOXCPM_URL", "http://127.0.0.1:8877")
DEFAULT_WHISPERX_URL = os.environ.get("WHISPERX_URL", "http://127.0.0.1:7860")


class KeysBody(BaseModel):
    voxcpm_url: str | None = None
    whisperx_url: str | None = None


class KeysStatus(BaseModel):
    voxcpm: bool
    whisperx: bool
    voxcpm_url: str
    whisperx_url: str
    voxcpm_error: str | None = None
    whisperx_error: str | None = None
    error: str | None = None


async def _probe(url: str) -> tuple[bool, str | None]:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{url.rstrip('/')}/healthz")
            if resp.is_success:
                return True, None
            detail = resp.text[:200] if resp.text else f"HTTP {resp.status_code}"
            return False, detail
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


async def _build_status(
    voxcpm_url: str = DEFAULT_VOXCPM_URL,
    whisperx_url: str = DEFAULT_WHISPERX_URL,
) -> KeysStatus:
    voxcpm_ok, voxcpm_error = await _probe(voxcpm_url)
    whisperx_ok, whisperx_error = await _probe(whisperx_url)

    errors = [item for item in [voxcpm_error, whisperx_error] if item]
    return KeysStatus(
        voxcpm=voxcpm_ok,
        whisperx=whisperx_ok,
        voxcpm_url=voxcpm_url,
        whisperx_url=whisperx_url,
        voxcpm_error=voxcpm_error,
        whisperx_error=whisperx_error,
        error=" | ".join(errors) if errors else None,
    )


@router.post("/keys", response_model=KeysStatus)
async def save_keys(body: KeysBody) -> KeysStatus:
    """Compatibility no-op: return current local service status."""
    return await _build_status(
        voxcpm_url=body.voxcpm_url or DEFAULT_VOXCPM_URL,
        whisperx_url=body.whisperx_url or DEFAULT_WHISPERX_URL,
    )


@router.get("/keys/status", response_model=KeysStatus)
async def keys_status() -> KeysStatus:
    return await _build_status()


@router.delete("/keys", response_model=KeysStatus)
async def delete_keys() -> KeysStatus:
    """Compatibility no-op: local mode has no stored API keys to clear."""
    return await _build_status()
