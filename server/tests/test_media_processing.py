from __future__ import annotations

from pathlib import Path

import pytest

from server.core.domain import DomainError
from server.core.media_processing import (
    build_output_relative_path,
    demucs_status,
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
