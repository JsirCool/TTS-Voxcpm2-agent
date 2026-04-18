from __future__ import annotations

from server.core.domain import FishTTSParams
from server.core.voxcpm_client import VoxCPMClient


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
