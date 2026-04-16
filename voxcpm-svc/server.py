"""Resident local VoxCPM HTTP service.

Run this service with the existing VoxCPM CUDA environment so the harness
server can synthesize through a lightweight HTTP bridge instead of importing
GPU dependencies directly.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import soundfile as sf
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

logger = logging.getLogger("voxcpm-svc")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def _default_model_path() -> str:
    return str(Path(__file__).resolve().parents[2] / "pretrained_models" / "VoxCPM2")


VOXCPM_MODEL_PATH = os.environ.get("VOXCPM_MODEL_PATH", _default_model_path())
VOXCPM_DEVICE = os.environ.get("VOXCPM_DEVICE", "cuda:0")
VOXCPM_OPTIMIZE = os.environ.get("VOXCPM_OPTIMIZE", "1").lower() in {"1", "true", "yes", "on"}
VOXCPM_ENABLE_DENOISER = os.environ.get("VOXCPM_ENABLE_DENOISER", "0").lower() in {"1", "true", "yes", "on"}
VOXCPM_OUTPUT_SAMPLE_RATE = int(os.environ.get("VOXCPM_OUTPUT_SAMPLE_RATE", "44100"))
VOXCPM_STUB_MODE = os.environ.get("VOXCPM_STUB_MODE", "0") == "1"
VOXCPM_SERVICE_NAME = os.environ.get("VOXCPM_SERVICE_NAME", "VoxCPM2")


@dataclass
class ServiceState:
    model_loaded: bool = False
    load_error: str | None = None
    model: Any = None
    sample_rate: int = 48000
    device: str = VOXCPM_DEVICE
    model_name: str = VOXCPM_SERVICE_NAME


STATE = ServiceState()


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1)
    reference_audio_path: str | None = None
    prompt_audio_path: str | None = None
    prompt_text: str | None = None
    cfg_value: float = 2.0
    inference_timesteps: int = 10
    max_len: int = 4096
    normalize: bool = False
    denoise: bool = False
    speed: float = 1.0


class HealthResponse(BaseModel):
    model_loaded: bool
    device: str
    model: str
    sample_rate: int
    error: str | None = None


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None


def _load_model_blocking() -> None:
    if VOXCPM_STUB_MODE:
        logger.warning("VOXCPM_STUB_MODE=1 - skipping real model load")
        STATE.model_loaded = True
        return

    try:
        from voxcpm import VoxCPM

        model_path = Path(VOXCPM_MODEL_PATH)
        if not model_path.exists():
            raise FileNotFoundError(f"VoxCPM model path not found: {model_path}")

        logger.info(
            "loading VoxCPM model path=%s device=%s optimize=%s denoiser=%s",
            model_path,
            VOXCPM_DEVICE,
            VOXCPM_OPTIMIZE,
            VOXCPM_ENABLE_DENOISER,
        )
        t0 = time.time()
        STATE.model = VoxCPM.from_pretrained(
            str(model_path),
            load_denoiser=VOXCPM_ENABLE_DENOISER,
            optimize=VOXCPM_OPTIMIZE,
            device=VOXCPM_DEVICE,
        )
        STATE.sample_rate = int(getattr(STATE.model.tts_model, "sample_rate", 48000))
        STATE.model_loaded = True
        logger.info("VoxCPM model loaded in %.1fs", time.time() - t0)
    except Exception as exc:  # noqa: BLE001
        STATE.load_error = f"{type(exc).__name__}: {exc}"
        logger.exception("VoxCPM model load failed")


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    loop = asyncio.get_running_loop()
    load_task = loop.run_in_executor(None, _load_model_blocking)
    try:
        yield
    finally:
        if not load_task.done():
            load_task.cancel()


app = FastAPI(
    title="voxcpm-svc",
    version="0.1.0",
    description="Resident local VoxCPM service for tts-agent-harness.",
    lifespan=lifespan,
)


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(
        model_loaded=STATE.model_loaded,
        device=STATE.device,
        model=STATE.model_name,
        sample_rate=STATE.sample_rate,
        error=STATE.load_error,
    )


@app.get("/readyz")
async def readyz() -> JSONResponse:
    if STATE.model_loaded:
        return JSONResponse({"status": "ready"}, status_code=200)
    payload: dict[str, Any] = {"status": "loading"}
    if STATE.load_error:
        payload["error"] = STATE.load_error
    return JSONResponse(payload, status_code=503)


@app.post(
    "/synthesize",
    response_model=None,
    responses={503: {"model": ErrorResponse}, 400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def synthesize(body: SynthesizeRequest) -> Response:
    if not STATE.model_loaded:
        return JSONResponse(
            ErrorResponse(
                error="model_not_loaded",
                detail=STATE.load_error or "model is still loading",
            ).model_dump(),
            status_code=503,
        )

    try:
        wav_bytes = await asyncio.get_running_loop().run_in_executor(
            None,
            _run_synthesize_blocking,
            body,
        )
    except FileNotFoundError as exc:
        return JSONResponse(
            ErrorResponse(error="missing_file", detail=str(exc)).model_dump(),
            status_code=400,
        )
    except ValueError as exc:
        return JSONResponse(
            ErrorResponse(error="invalid_request", detail=str(exc)).model_dump(),
            status_code=400,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("synthesize failed")
        return JSONResponse(
            ErrorResponse(error="synthesize_failed", detail=f"{type(exc).__name__}: {exc}").model_dump(),
            status_code=500,
        )

    return Response(content=wav_bytes, media_type="audio/wav")


def _run_synthesize_blocking(body: SynthesizeRequest) -> bytes:
    if VOXCPM_STUB_MODE:
        return _make_stub_wav()

    if body.reference_audio_path and not Path(body.reference_audio_path).exists():
        raise FileNotFoundError(f"reference_audio_path not found: {body.reference_audio_path}")
    if body.prompt_audio_path and not Path(body.prompt_audio_path).exists():
        raise FileNotFoundError(f"prompt_audio_path not found: {body.prompt_audio_path}")

    wav = STATE.model.generate(
        text=body.text,
        reference_wav_path=body.reference_audio_path,
        prompt_wav_path=body.prompt_audio_path,
        prompt_text=body.prompt_text,
        cfg_value=body.cfg_value,
        inference_timesteps=body.inference_timesteps,
        max_len=body.max_len,
        normalize=body.normalize,
        denoise=body.denoise,
    )

    with io.BytesIO() as buffer:
        sf.write(buffer, wav, STATE.sample_rate, format="WAV")
        wav_bytes = buffer.getvalue()

    if STATE.sample_rate != VOXCPM_OUTPUT_SAMPLE_RATE or abs(body.speed - 1.0) > 0.01:
        return _postprocess_wav(
            wav_bytes,
            speed=body.speed,
            sample_rate=VOXCPM_OUTPUT_SAMPLE_RATE,
        )
    return wav_bytes


def _postprocess_wav(
    wav_bytes: bytes,
    *,
    speed: float,
    sample_rate: int,
) -> bytes:
    if speed <= 0:
        raise ValueError("speed must be greater than 0")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as src:
        src.write(wav_bytes)
        src_path = Path(src.name)
    dst_path = src_path.with_name(f"{src_path.stem}_speed.wav")

    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(src_path),
        ]
        if abs(speed - 1.0) > 0.01:
            cmd.extend(["-filter:a", f"atempo={speed}"])
        if sample_rate > 0:
            cmd.extend(["-ar", str(sample_rate)])
        cmd.extend([
            "-ac",
            "1",
            str(dst_path),
        ])
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0 or not dst_path.exists():
            logger.warning("ffmpeg postprocess failed, returning original audio: %s", proc.stderr.strip())
            return wav_bytes
        return dst_path.read_bytes()
    finally:
        for path in (src_path, dst_path):
            try:
                path.unlink()
            except OSError:
                pass


def _make_stub_wav(sample_rate: int = 16000, seconds: float = 0.5) -> bytes:
    import numpy as np

    wav = np.zeros(int(sample_rate * seconds), dtype="float32")
    with io.BytesIO() as buffer:
        sf.write(buffer, wav, sample_rate, format="WAV")
        return buffer.getvalue()


@app.exception_handler(Exception)
async def _global_exc(request: Request, exc: Exception):  # noqa: ARG001
    logger.exception("unhandled error")
    return JSONResponse(
        ErrorResponse(error="internal_error", detail=f"{type(exc).__name__}: {exc}").model_dump(),
        status_code=500,
    )
