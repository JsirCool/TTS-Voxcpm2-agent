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
