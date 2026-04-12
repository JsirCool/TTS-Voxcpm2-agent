"""Unit tests for the P2c WAV format validation check gate.

Tests cover:
  1. Happy path — valid WAV info passes
  2. Duration out of range → hard fail
  3. Wrong sample rate → hard fail
  4. Wrong channel count → hard fail
  5. Speech rate out of 2-12 chars/s → warning (not fail)
"""

from __future__ import annotations

import pytest

from server.flows.tasks.p2c_check import validate_wav


# ---------------------------------------------------------------------------
# Pure validation tests (no DB, no I/O)
# ---------------------------------------------------------------------------


def test_validate_wav_happy_path():
    """Valid WAV info passes with no errors."""
    info = {"duration": 5.0, "sample_rate": 44100, "channels": 1}
    errors, warnings = validate_wav(info, char_count=30)
    assert errors == []
    assert warnings == []


def test_validate_wav_duration_zero():
    """Duration <= 0 → hard fail."""
    info = {"duration": 0.0, "sample_rate": 44100, "channels": 1}
    errors, warnings = validate_wav(info, char_count=30)
    assert any("invalid" in e for e in errors)


def test_validate_wav_duration_too_long():
    """Duration > 60s → hard fail."""
    info = {"duration": 65.0, "sample_rate": 44100, "channels": 1}
    errors, warnings = validate_wav(info, char_count=30)
    assert any("exceeds 60s" in e for e in errors)


def test_validate_wav_wrong_sample_rate():
    """Sample rate != 44100 → hard fail."""
    info = {"duration": 5.0, "sample_rate": 22050, "channels": 1}
    errors, warnings = validate_wav(info, char_count=30)
    assert any("sample rate" in e for e in errors)


def test_validate_wav_stereo():
    """Channels != 1 → hard fail."""
    info = {"duration": 5.0, "sample_rate": 44100, "channels": 2}
    errors, warnings = validate_wav(info, char_count=30)
    assert any("channels" in e for e in errors)


def test_validate_wav_speech_rate_warning():
    """Speech rate outside 2-12 chars/s → warning, not error."""
    # 100 chars in 5 seconds = 20 chars/s, way over 12
    info = {"duration": 5.0, "sample_rate": 44100, "channels": 1}
    errors, warnings = validate_wav(info, char_count=100)
    assert errors == []
    assert any("speech rate" in w for w in warnings)


def test_validate_wav_multiple_errors():
    """Multiple issues → multiple errors."""
    info = {"duration": 0.0, "sample_rate": 22050, "channels": 2}
    errors, warnings = validate_wav(info, char_count=30)
    assert len(errors) >= 3  # duration, sample_rate, channels
