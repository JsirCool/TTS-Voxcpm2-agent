from __future__ import annotations

from server.core.tts_presets import normalize_tts_config


def test_normalize_tts_config_clears_stale_fields_for_ultimate_cloning():
    config = normalize_tts_config(
        {
            "control_prompt": "should be removed",
            "reference_audio_path": "voice_sourse/ref.wav",
            "prompt_audio_path": "voice_sourse/111.m4a",
            "prompt_text": "hello everyone",
            "denoise": True,
        }
    )

    assert config["prompt_audio_path"] == "111.m4a"
    assert config["prompt_text"] == "hello everyone"
    assert "control_prompt" not in config
    assert "reference_audio_path" not in config


def test_normalize_tts_config_keeps_controllable_cloning_fields():
    config = normalize_tts_config(
        {
            "control_prompt": "calm male narration",
            "reference_audio_path": "voice_sourse/ref.wav",
        }
    )

    assert config["reference_audio_path"] == "ref.wav"
    assert config["control_prompt"] == "calm male narration"
    assert "prompt_audio_path" not in config
    assert "prompt_text" not in config


def test_normalize_tts_config_keeps_voice_design_fields_minimal():
    config = normalize_tts_config(
        {
            "control_prompt": "young female voice",
            "denoise": True,
        }
    )

    assert config["control_prompt"] == "young female voice"
    assert "denoise" not in config
    assert "reference_audio_path" not in config
    assert "prompt_audio_path" not in config
    assert "prompt_text" not in config
