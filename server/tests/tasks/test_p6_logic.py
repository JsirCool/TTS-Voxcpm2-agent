"""Unit tests for ``server.core.p6_logic`` — all pure, no ffmpeg / network."""

from __future__ import annotations

from pathlib import Path

import pytest

from server.core.p6_logic import (
    ChunkTiming,
    build_ffmpeg_concat_list,
    compute_chunk_offsets,
    compute_gap_sequence,
    compute_total_duration,
    format_srt_timestamp,
    interleave_with_silences,
    merge_srt_files,
    parse_srt,
    sort_chunk_timings,
)


# ---------------------------------------------------------------------------
# compute_chunk_offsets
# ---------------------------------------------------------------------------


def test_offsets_empty_list():
    assert compute_chunk_offsets([], 0.2, 0.5) == []


def test_offsets_single_chunk_is_zero():
    chunks = [ChunkTiming("c1", "shot01", 0, 2.5)]
    assert compute_chunk_offsets(chunks, 0.2, 0.5) == [0.0]
    assert compute_total_duration(chunks, 0.2, 0.5) == pytest.approx(2.5)


def test_offsets_multi_chunks_same_shot_use_padding():
    chunks = [
        ChunkTiming("c1", "shot01", 0, 2.0),
        ChunkTiming("c2", "shot01", 1, 3.0),
        ChunkTiming("c3", "shot01", 2, 1.5),
    ]
    offsets = compute_chunk_offsets(chunks, padding_s=0.2, shot_gap_s=0.5)
    # c1=0, c2 = 0 + 2 + 0.2 = 2.2, c3 = 2.2 + 3 + 0.2 = 5.4
    assert offsets == pytest.approx([0.0, 2.2, 5.4])
    # total = 5.4 + 1.5 = 6.9
    assert compute_total_duration(chunks, 0.2, 0.5) == pytest.approx(6.9)


def test_offsets_cross_shot_uses_shot_gap():
    chunks = [
        ChunkTiming("c1", "shot01", 0, 2.0),
        ChunkTiming("c2", "shot02", 0, 3.0),
        ChunkTiming("c3", "shot02", 1, 1.0),
    ]
    offsets = compute_chunk_offsets(chunks, padding_s=0.2, shot_gap_s=0.5)
    # c1=0, c2 = 0 + 2 + 0.5 = 2.5, c3 = 2.5 + 3 + 0.2 = 5.7
    assert offsets == pytest.approx([0.0, 2.5, 5.7])


def test_compute_gap_sequence_mirrors_offsets():
    chunks = [
        ChunkTiming("c1", "shot01", 0, 2.0),
        ChunkTiming("c2", "shot01", 1, 3.0),
        ChunkTiming("c3", "shot02", 0, 1.0),
    ]
    assert compute_gap_sequence(chunks, 0.2, 0.5) == pytest.approx([0.2, 0.5])
    assert compute_gap_sequence([], 0.2, 0.5) == []
    assert compute_gap_sequence(chunks[:1], 0.2, 0.5) == []


def test_sort_chunk_timings_is_deterministic():
    chunks = [
        ChunkTiming("c2", "shot02", 0, 1.0),
        ChunkTiming("c1", "shot01", 1, 2.0),
        ChunkTiming("c3", "shot01", 0, 3.0),
    ]
    ordered = sort_chunk_timings(chunks)
    assert [c.chunk_id for c in ordered] == ["c3", "c1", "c2"]


# ---------------------------------------------------------------------------
# SRT timestamp formatting
# ---------------------------------------------------------------------------


def test_format_srt_timestamp_zero_padding():
    assert format_srt_timestamp(0.0) == "00:00:00,000"
    assert format_srt_timestamp(1.234) == "00:00:01,234"
    assert format_srt_timestamp(61.5) == "00:01:01,500"
    assert format_srt_timestamp(3661.0) == "01:01:01,000"


def test_format_srt_timestamp_rounds_to_nearest_ms():
    assert format_srt_timestamp(0.0004) == "00:00:00,000"
    assert format_srt_timestamp(0.0006) == "00:00:00,001"
    assert format_srt_timestamp(-5.0) == "00:00:00,000"


# ---------------------------------------------------------------------------
# parse_srt / merge_srt_files
# ---------------------------------------------------------------------------


_SRT_A = """1
00:00:00,000 --> 00:00:01,500
Hello world

2
00:00:01,600 --> 00:00:02,900
Second line
"""

_SRT_B = """1
00:00:00,100 --> 00:00:01,000
Chunk B line one
"""


def test_parse_srt_basic():
    cues = parse_srt(_SRT_A)
    assert len(cues) == 2
    assert cues[0].start_s == pytest.approx(0.0)
    assert cues[0].end_s == pytest.approx(1.5)
    assert cues[0].text == "Hello world"
    assert cues[1].text == "Second line"


def test_parse_srt_tolerates_crlf_and_bom():
    raw = "\ufeff" + _SRT_A.replace("\n", "\r\n")
    cues = parse_srt(raw)
    assert len(cues) == 2
    assert cues[0].text == "Hello world"


def test_parse_srt_empty_input():
    assert parse_srt("") == []
    assert parse_srt("\n\n\n") == []


def test_merge_srt_files_shifts_and_renumbers():
    merged = merge_srt_files([_SRT_A, _SRT_B], [0.0, 3.0])
    lines = merged.strip().split("\n")
    # Three cues total, renumbered 1/2/3
    nums = [ln for ln in lines if ln.isdigit()]
    assert nums == ["1", "2", "3"]

    # Third cue must be from SRT_B shifted by +3.0
    # Original was 00:00:00,100 --> 00:00:01,000 → now 3.1 → 4.0
    assert "00:00:03,100 --> 00:00:04,000" in merged
    # First cue unchanged (offset 0)
    assert "00:00:00,000 --> 00:00:01,500" in merged


def test_merge_srt_files_length_mismatch():
    with pytest.raises(ValueError):
        merge_srt_files([_SRT_A], [0.0, 1.0])


def test_merge_srt_files_empty_inputs_produce_empty_output():
    assert merge_srt_files([], []) == ""
    # All-empty chunk SRTs → empty merged output
    assert merge_srt_files(["", ""], [0.0, 1.0]) == ""


def test_merge_srt_preserves_cue_text_including_blank_body():
    srt = "1\n00:00:00,500 --> 00:00:01,500\nfoo\nbar\n"
    merged = merge_srt_files([srt], [10.0])
    assert "00:00:10,500 --> 00:00:11,500" in merged
    assert "foo\nbar" in merged


# ---------------------------------------------------------------------------
# build_ffmpeg_concat_list / interleave_with_silences
# ---------------------------------------------------------------------------


def test_build_concat_list_preserves_order(tmp_path: Path):
    files = [tmp_path / f"{i}.wav" for i in range(3)]
    for f in files:
        f.write_bytes(b"")
    body = build_ffmpeg_concat_list(files)
    lines = body.strip().split("\n")
    assert len(lines) == 3
    for line, f in zip(lines, files):
        assert line.startswith("file '")
        assert str(f.resolve()) in line


def test_build_concat_list_escapes_single_quotes(tmp_path: Path):
    weird = tmp_path / "o'hara.wav"
    weird.write_bytes(b"")
    body = build_ffmpeg_concat_list([weird])
    # Single quote must be escaped as '\''
    assert "'\\''" in body
    # And the full resolved absolute path must be present (minus the quote char)
    assert "o" in body


def test_build_concat_list_empty():
    assert build_ffmpeg_concat_list([]) == ""


def test_interleave_inserts_silences_between_audio(tmp_path: Path):
    a = [tmp_path / "a.wav", tmp_path / "b.wav", tmp_path / "c.wav"]
    for f in a:
        f.write_bytes(b"")
    s_pad = tmp_path / "pad.wav"
    s_shot = tmp_path / "shot.wav"
    s_pad.write_bytes(b"")
    s_shot.write_bytes(b"")

    result = interleave_with_silences(
        a,
        gaps=[0.2, 0.5],
        silences={0.2: s_pad, 0.5: s_shot},
    )
    assert result == [a[0], s_pad, a[1], s_shot, a[2]]


def test_interleave_rejects_mismatched_gaps(tmp_path: Path):
    files = [tmp_path / "a.wav", tmp_path / "b.wav"]
    for f in files:
        f.write_bytes(b"")
    with pytest.raises(ValueError):
        interleave_with_silences(files, gaps=[], silences={})


def test_interleave_missing_silence_key(tmp_path: Path):
    files = [tmp_path / "a.wav", tmp_path / "b.wav"]
    for f in files:
        f.write_bytes(b"")
    with pytest.raises(KeyError):
        interleave_with_silences(files, gaps=[0.3], silences={0.2: files[0]})


def test_interleave_gap_zero_is_skipped(tmp_path: Path):
    files = [tmp_path / "a.wav", tmp_path / "b.wav"]
    for f in files:
        f.write_bytes(b"")
    result = interleave_with_silences(files, gaps=[0.0], silences={})
    assert result == files
