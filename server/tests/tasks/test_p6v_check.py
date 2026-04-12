"""Unit tests for the P6v end-to-end validation check gate.

Tests cover:
  1. Happy path — good subtitles pass
  2. Low coverage → error
  3. Overlapping subtitles → error
"""

from __future__ import annotations

import pytest

from server.flows.tasks.p6v_check import validate_subtitles


def test_validate_subtitles_happy_path():
    """Well-formed subtitles with good coverage pass."""
    subs = [
        {"start": 0.0, "end": 2.0, "text": "Hello"},
        {"start": 2.0, "end": 4.0, "text": "World"},
        {"start": 4.0, "end": 5.0, "text": "!"},
    ]
    errors, warnings = validate_subtitles(subs, audio_duration=5.5)
    assert errors == []
    # Coverage = 5.0 / 5.5 = ~90.9%, above 80%
    assert not any("coverage" in w for w in warnings)


def test_validate_subtitles_low_coverage():
    """Coverage < 80% → error."""
    subs = [
        {"start": 0.0, "end": 1.0, "text": "Short"},
    ]
    # 1.0 / 10.0 = 10%, well below 80%
    errors, warnings = validate_subtitles(subs, audio_duration=10.0)
    assert any("coverage" in e for e in errors)


def test_validate_subtitles_overlap():
    """Overlapping subtitles → error."""
    subs = [
        {"start": 0.0, "end": 3.0, "text": "First"},
        {"start": 2.0, "end": 4.0, "text": "Second"},  # overlaps with First
    ]
    errors, warnings = validate_subtitles(subs, audio_duration=5.0)
    assert any("overlap" in e for e in errors)


def test_validate_subtitles_gap_warning():
    """Gap > 0.5s between subtitles → warning."""
    subs = [
        {"start": 0.0, "end": 2.0, "text": "First"},
        {"start": 3.0, "end": 5.0, "text": "Second"},  # 1.0s gap
    ]
    errors, warnings = validate_subtitles(subs, audio_duration=5.0)
    # Coverage is 4.0/5.0 = 80%, just at threshold
    assert any("gap" in w for w in warnings)


def test_validate_subtitles_invalid_duration():
    """Audio duration <= 0 → error."""
    subs = [{"start": 0.0, "end": 1.0, "text": "Hello"}]
    errors, warnings = validate_subtitles(subs, audio_duration=0.0)
    assert any("invalid" in e for e in errors)


def test_validate_subtitles_empty():
    """No subtitles → warning."""
    errors, warnings = validate_subtitles([], audio_duration=5.0)
    assert errors == []
    assert any("no subtitles" in w for w in warnings)
