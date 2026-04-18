from __future__ import annotations

from server.core.domain import FishTTSParams
from server.core.voxcpm_client import (
    VoxCPMClient,
    build_params_from_env,
    serialize_active_params,
)


def test_build_payload_keeps_control_prompt_for_voice_design():
    client = VoxCPMClient()

    payload = client.build_payload(
        "hello world",
        FishTTSParams(control_prompt="warm female voice"),
    )

    assert payload["text"] == "(warm female voice)hello world"


def test_build_payload_ignores_control_prompt_for_ultimate_cloning():
    client = VoxCPMClient()

    payload = client.build_payload(
        "hello world",
        FishTTSParams(
            control_prompt="stale prompt",
            prompt_audio_path="111.m4a",
            prompt_text="hello everyone",
        ),
    )

    assert payload["text"] == "hello world"
    assert payload["prompt_audio_path"]
    assert payload["prompt_text"] == "hello everyone"


def test_serialize_active_params_keeps_only_mode_specific_fields():
    serialized = serialize_active_params(
        FishTTSParams(
            prompt_audio_path="111.m4a",
            prompt_text="hello everyone",
            control_prompt="should not survive",
            reference_audio_path="ref.wav",
        ),
    )

    assert serialized["tts_mode"] == "ultimate_cloning"
    assert serialized["prompt_audio_path"] == "111.m4a"
    assert serialized["prompt_text"] == "hello everyone"
    assert "control_prompt" not in serialized
    assert "reference_audio_path" not in serialized


def test_build_params_from_env_skips_voice_profile_by_default(monkeypatch):
    monkeypatch.setenv("VOXCPM_REFERENCE_AUDIO_PATH", "ref.wav")
    monkeypatch.setenv("VOXCPM_PROMPT_AUDIO_PATH", "prompt.wav")
    monkeypatch.setenv("VOXCPM_PROMPT_TEXT", "prompt text")
    monkeypatch.setenv("VOXCPM_CONTROL_PROMPT", "control")

    params = build_params_from_env()

    assert params.reference_audio_path is None
    assert params.prompt_audio_path is None
    assert params.prompt_text is None
    assert params.control_prompt is None


def test_build_params_from_env_can_opt_into_voice_profile(monkeypatch):
    monkeypatch.setenv("VOXCPM_PROMPT_AUDIO_PATH", "prompt.wav")
    monkeypatch.setenv("VOXCPM_PROMPT_TEXT", "prompt text")

    params = build_params_from_env(include_voice_profile=True)

    assert params.prompt_audio_path == "prompt.wav"
    assert params.prompt_text == "prompt text"
