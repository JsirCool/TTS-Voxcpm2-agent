"""Local VoxCPM HTTP client used by the P2 synth task.

The harness server talks to a resident local ``voxcpm-svc`` process instead of
importing GPU-heavy VoxCPM dependencies directly. That keeps the FastAPI worker
lightweight while still reusing the user's existing CUDA-ready VoxCPM runtime.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx

from .domain import FishTTSParams
from .tts_presets import resolve_audio_path

DEFAULT_VOXCPM_URL = os.environ.get("VOXCPM_URL", "http://127.0.0.1:8877")
DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=10.0)


class VoxCPMError(Exception):
    """Base class for VoxCPM service errors."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class VoxCPMUnavailableError(VoxCPMError):
    """Raised when the local VoxCPM service is unavailable or still loading."""


class VoxCPMClientError(VoxCPMError):
    """Raised on malformed requests or other non-retryable 4xx responses."""


class VoxCPMServerError(VoxCPMError):
    """Raised on retryable 5xx responses from the local service."""


class VoxCPMClient:
    """Async client for the local ``voxcpm-svc`` process."""

    def __init__(
        self,
        *,
        url: str = DEFAULT_VOXCPM_URL,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = url.rstrip("/")
        self._http = http_client
        self._owns_http = http_client is None

    async def aclose(self) -> None:
        if self._owns_http and self._http is not None:
            await self._http.aclose()
            self._http = None

    @asynccontextmanager
    async def _client(self) -> AsyncIterator[httpx.AsyncClient]:
        if self._http is not None:
            yield self._http
            return
        self._http = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)
        yield self._http

    def build_payload(self, text: str, params: FishTTSParams) -> dict[str, Any]:
        """Return the JSON request expected by the local service."""
        text = text.strip()
        control_prompt = (params.control_prompt or "").strip()
        if control_prompt:
            text = f"({control_prompt}){text}"

        reference_audio = resolve_audio_path(params.reference_audio_path)
        prompt_audio = resolve_audio_path(params.prompt_audio_path)

        return {
            "text": text,
            "reference_audio_path": str(reference_audio) if reference_audio else None,
            "prompt_audio_path": str(prompt_audio) if prompt_audio else None,
            "prompt_text": params.prompt_text,
            "cfg_value": params.cfg_value,
            "inference_timesteps": params.inference_timesteps,
            "max_len": params.max_len,
            "normalize": params.normalize,
            "denoise": params.denoise,
            "speed": params.speed,
        }

    async def synthesize(self, text: str, params: FishTTSParams) -> bytes:
        """Synthesize speech through the local VoxCPM HTTP service."""
        if not text or not text.strip():
            raise VoxCPMClientError("cannot synthesize empty text")

        url = f"{self._base_url}/synthesize"
        payload = self.build_payload(text, params)

        try:
            async with self._client() as http:
                response = await http.post(url, json=payload)
        except Exception as exc:  # noqa: BLE001
            detail = str(exc).strip() or type(exc).__name__
            raise VoxCPMUnavailableError(
                f"Failed to connect to VoxCPM service at {url}: {detail}",
            ) from exc

        return self._handle_response(response)

    def _handle_response(self, response: httpx.Response) -> bytes:
        status = response.status_code
        if 200 <= status < 300:
            if not response.content:
                raise VoxCPMClientError(
                    "VoxCPM service returned 2xx with empty body",
                    status_code=status,
                )
            return response.content

        try:
            detail = response.text[:500]
        except Exception:  # pragma: no cover
            detail = "<unreadable>"

        if status in (502, 503, 504):
            raise VoxCPMUnavailableError(
                f"VoxCPM service unavailable ({status}): {detail}",
                status_code=status,
            )
        if 500 <= status < 600:
            raise VoxCPMServerError(
                f"VoxCPM service error {status}: {detail}",
                status_code=status,
            )
        raise VoxCPMClientError(
            f"VoxCPM request failed {status}: {detail}",
            status_code=status,
        )


def build_params_from_env(overrides: dict[str, Any] | None = None) -> FishTTSParams:
    """Construct synthesis params using local VoxCPM-oriented env defaults."""

    def _env_flag(name: str, default: bool) -> bool:
        raw = os.environ.get(name)
        if raw is None:
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def _env_float(name: str, default: float) -> float:
        raw = os.environ.get(name)
        if raw is None:
            return default
        try:
            return float(raw)
        except ValueError:
            return default

    def _env_int(name: str, default: int) -> int:
        raw = os.environ.get(name)
        if raw is None:
            return default
        try:
            return int(raw)
        except ValueError:
            return default

    base: dict[str, Any] = {
        "cfg_value": _env_float("VOXCPM_CFG_VALUE", 2.0),
        "inference_timesteps": _env_int("VOXCPM_INFERENCE_TIMESTEPS", 10),
        "max_len": _env_int("VOXCPM_MAX_LEN", 4096),
        "speed": _env_float("TTS_SPEED", 1.0),
        "normalize": _env_flag("VOXCPM_NORMALIZE", False),
        "denoise": _env_flag("VOXCPM_DENOISE", False),
    }
    if ref := os.environ.get("VOXCPM_REFERENCE_AUDIO_PATH"):
        base["reference_audio_path"] = ref
    if prompt_audio := os.environ.get("VOXCPM_PROMPT_AUDIO_PATH"):
        base["prompt_audio_path"] = prompt_audio
    if prompt_text := os.environ.get("VOXCPM_PROMPT_TEXT"):
        base["prompt_text"] = prompt_text
    if control_prompt := os.environ.get("VOXCPM_CONTROL_PROMPT"):
        base["control_prompt"] = control_prompt
    if overrides:
        base.update(overrides)
    return FishTTSParams(**base)


__all__ = [
    "DEFAULT_VOXCPM_URL",
    "VoxCPMClient",
    "VoxCPMError",
    "VoxCPMUnavailableError",
    "VoxCPMClientError",
    "VoxCPMServerError",
    "build_params_from_env",
]
