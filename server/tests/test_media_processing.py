from __future__ import annotations

from pathlib import Path

import pytest

from server.core.domain import DomainError
from server.core.media_processing import (
    build_output_relative_path,
    demucs_status,
    resolve_whisperx_subtitles,
    transcribe_audio_for_prompt,
    transcribe_source_audio_for_prompt,
    validate_trim_bounds,
)


def test_build_output_relative_path_uses_imported_layout():
    path = build_output_relative_path(
        "My Demo Clip.mp4",
        1.2,
        3.4,
        "light",
        now="20260418T120000Z",
    )
    assert path.as_posix() == "imported/My-Demo-Clip/20260418T120000Z__00001200-00003400__light.wav"


def test_validate_trim_bounds_accepts_valid_window():
    assert validate_trim_bounds(12.0, 1.2349, 4.8888) == (1.235, 4.889)


@pytest.mark.parametrize(
    ("duration_s", "start_s", "end_s", "message"),
    [
        (10.0, -1.0, 2.0, "start_s must be greater than or equal to 0"),
        (10.0, 5.0, 5.0, "end_s must be greater than start_s"),
        (10.0, 12.0, 13.0, "start_s is outside the source duration"),
        (10.0, 8.0, 12.0, "end_s exceeds source duration"),
    ],
)
def test_validate_trim_bounds_rejects_invalid_ranges(duration_s: float, start_s: float, end_s: float, message: str):
    with pytest.raises(DomainError) as exc:
        validate_trim_bounds(duration_s, start_s, end_s)
    assert exc.value.code == "invalid_input"
    assert message in exc.value.message


def test_demucs_status_reports_missing_backend(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("server.core.media_processing.shutil.which", lambda name: None)
    monkeypatch.setattr("server.core.media_processing.importlib.util.find_spec", lambda name: None)
    status = demucs_status()
    assert status.available is False
    assert "Demucs" in (status.detail or "")


@pytest.mark.asyncio
async def test_resolve_whisperx_subtitles_uses_auto_language(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    captured: list[str] = []

    def _fake_extract(_source: Path, output: Path) -> None:
        output.write_bytes(b"RIFFdemo")

    async def _fake_transcribe(_audio_path: Path, *, whisperx_url: str, language: str):
        captured.append(language)
        return [
            {"word": "hello", "start": 0.0, "end": 0.5},
            {"word": "world", "start": 0.5, "end": 1.0},
        ], "en"

    monkeypatch.setattr("server.core.media_processing._extract_full_audio_for_transcription", _fake_extract)
    monkeypatch.setattr("server.core.media_processing._transcribe_words_once", _fake_transcribe)

    source = tmp_path / "clip.wav"
    source.write_bytes(b"RIFFdemo")
    result = await resolve_whisperx_subtitles(source, whisperx_url="http://whisperx")

    assert captured == ["auto"]
    assert result.language == "en"
    assert result.cues[0].text == "hello world"


@pytest.mark.asyncio
async def test_transcribe_audio_for_prompt_uses_auto_language(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    captured: list[str] = []

    async def _fake_transcribe(_audio_path: Path, *, whisperx_url: str, language: str):
        captured.append(language)
        return [
            {"word": "你", "start": 0.0, "end": 0.2},
            {"word": "好", "start": 0.2, "end": 0.4},
        ], "zh"

    monkeypatch.setattr("server.core.media_processing._transcribe_words_once", _fake_transcribe)

    source = tmp_path / "clip.wav"
    source.write_bytes(b"RIFFdemo")
    text = await transcribe_audio_for_prompt(source, whisperx_url="http://whisperx")

    assert captured == ["auto"]
    assert text == "你好"


@pytest.mark.asyncio
async def test_transcribe_source_audio_for_prompt_extracts_working_wav(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    extracted: list[tuple[Path, str]] = []
    transcribed: list[Path] = []

    def _fake_extract(source: Path, output: Path) -> None:
        extracted.append((source, output.name))
        output.write_bytes(b"RIFFdemo")

    async def _fake_transcribe(audio_path: Path, *, whisperx_url: str):
        transcribed.append(audio_path)
        assert audio_path.name == "prompt.wav"
        assert whisperx_url == "http://whisperx"
        return "hello prompt"

    monkeypatch.setattr("server.core.media_processing._extract_full_audio_for_transcription", _fake_extract)
    monkeypatch.setattr("server.core.media_processing.transcribe_audio_for_prompt", _fake_transcribe)

    source = tmp_path / "prompt.m4a"
    source.write_bytes(b"demo")

    text = await transcribe_source_audio_for_prompt(source, whisperx_url="http://whisperx")

    assert text == "hello prompt"
    assert extracted == [(source, "prompt.wav")]
    assert transcribed
