from __future__ import annotations

from pathlib import Path

import pytest

from server.core.bilibili_import import (
    _build_bilibili_subprocess_env,
    build_bilibili_cache_relative_path,
    build_preview_url,
    extract_video_target,
    resolve_imported_source_path,
)
from server.core.domain import DomainError


def test_extract_video_target_supports_bv_and_page():
    target = extract_video_target("https://www.bilibili.com/video/BV1Rs411x7qR?p=2")
    assert target.bvid == "BV1Rs411x7qR"
    assert target.page_number == 2


def test_extract_video_target_converts_av():
    target = extract_video_target("https://www.bilibili.com/video/av6606306")
    assert target.bvid == "BV1Rs411x7qR"
    assert target.page_number == 1


def test_build_bilibili_cache_relative_path_uses_expected_layout():
    path = build_bilibili_cache_relative_path(
        "BV1Rs411x7qR",
        page_number=3,
        download_target="audio",
        suffix=".wav",
    )
    assert path.as_posix() == "imported/bilibili/BV1Rs411x7qR/audio/p03.wav"


def test_build_preview_url_quotes_relative_path():
    preview_url = build_preview_url("imported/bilibili/BV1/audio/p03.wav")
    assert preview_url == "/media/source?path=imported%2Fbilibili%2FBV1%2Faudio%2Fp03.wav"


def test_resolve_imported_source_path_rejects_escape(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    voice_dir = tmp_path / "voice_sourse"
    voice_dir.mkdir(parents=True)
    monkeypatch.setenv("HARNESS_VOICE_SOURCE_DIR", str(voice_dir))

    with pytest.raises(DomainError) as exc:
        resolve_imported_source_path("../outside.wav")

    assert exc.value.code == "invalid_input"
    assert "voice_sourse/imported" in exc.value.message


def test_build_bilibili_subprocess_env_strips_proxy_variables(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:7890")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    monkeypatch.setenv("PATH", r"C:\Windows\System32")
    env = _build_bilibili_subprocess_env(Path(r"E:\VC\tts-agent-harness"))

    assert env["PYTHONPATH"] == r"E:\VC\tts-agent-harness"
    assert env["PYTHONUTF8"] == "1"
    assert env["PYTHONIOENCODING"] == "utf-8"
    assert env["PATH"] == r"C:\Windows\System32"
    assert "HTTP_PROXY" not in env
    assert "HTTPS_PROXY" not in env
    assert "NO_PROXY" not in env
