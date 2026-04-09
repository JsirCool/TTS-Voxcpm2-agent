"""Pure logic for P5 subtitle assignment.

This module has **zero I/O**: no database, no object storage, no Prefect,
no HTTP. It only transforms strings and numbers, which makes it trivially
unit-testable and — more importantly — **deterministic**.

Pipeline (all driven by callers):

1. ``strip_control_markers(text)``      — remove S2-Pro control markers
2. ``split_subtitle_lines(display)``    — split the cleaned text into cues
3. ``distribute_timestamps(lines, T)``  — char-weighted time allocation
4. ``build_srt(cues)``                  — serialize to SRT wire format

The algorithm is documented inline because the "why" matters more than the
"what" for future maintainers.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# 1. Strip S2-Pro control markers
# ---------------------------------------------------------------------------

# Known named pause / breath markers that Fish S2-Pro recognises.
# Anything inside square brackets that matches one of these is dropped.
_NAMED_MARKERS = {
    "break",
    "long break",
    "short break",
    "breath",
    "sigh",
    "laugh",
    "cough",
    "pause",
}

# Matches **any** bracketed token of the form [...] or [^...].
# We deliberately use a greedy strip: bracketed tokens are never part of
# displayable subtitle text in our authoring convention.
_BRACKET_RE = re.compile(r"\[[^\[\]]*\]")


def strip_control_markers(text: str) -> str:
    """Remove S2-Pro control markers from ``text``.

    Stripped tokens:

    - Named pauses: ``[break]``, ``[long break]``, ``[breath]``, ``[sigh]`` ...
    - Phoneme overrides: ``[^tomato]``, ``[^hello]`` ...
    - Any other ``[...]`` bracketed token — authoring convention forbids
      literal square brackets in displayable text, so this is safe.

    The function also collapses the whitespace created by removed markers:
    ``"你好 [break] 世界"`` → ``"你好 世界"`` (single internal space preserved).

    Empty / all-marker input returns an empty string.
    """
    if not text:
        return ""
    stripped = _BRACKET_RE.sub(" ", text)
    # Collapse runs of spaces/tabs but preserve explicit newlines so that
    # split_subtitle_lines() can still honour author-provided breaks.
    stripped = re.sub(r"[ \t]+", " ", stripped)
    # Trim whitespace at line boundaries.
    stripped = re.sub(r" *\n *", "\n", stripped)
    return stripped.strip()


# Keep the marker set public for test visibility.
STRIPPABLE_MARKERS = frozenset(_NAMED_MARKERS)


# ---------------------------------------------------------------------------
# 2. Split into subtitle lines
# ---------------------------------------------------------------------------

# Sentence-terminating punctuation: Chinese + English.
# We keep the terminator attached to the preceding sentence (common SRT
# convention).  Semicolons / commas do **not** split — they would produce
# too many tiny cues.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[。？！?!.…])")


def split_subtitle_lines(display_text: str) -> list[str]:
    """Split display-ready text into subtitle lines (one per SRT cue).

    Rules:

    - Split on Chinese/English full-stop / question / exclamation, keeping
      the terminator with its sentence.
    - Also split on hard newlines (authors may pre-break lines manually).
    - Drop purely-whitespace segments.
    - Strip leading/trailing whitespace on each line.

    A chunk that contains no sentence terminators becomes exactly one line.
    """
    if not display_text or not display_text.strip():
        return []

    lines: list[str] = []
    # First split on explicit newlines so authors can force cue breaks.
    for paragraph in display_text.split("\n"):
        parts = _SENTENCE_SPLIT_RE.split(paragraph)
        for part in parts:
            s = part.strip()
            if s:
                lines.append(s)
    return lines


# ---------------------------------------------------------------------------
# 3. Char-weighted timestamp distribution
# ---------------------------------------------------------------------------


def distribute_timestamps(
    lines: list[str], total_duration: float
) -> list[tuple[float, float]]:
    """Assign ``(start, end)`` seconds to each subtitle line.

    Algorithm (char-weighted, deterministic):

    Let ``T`` be ``total_duration`` and ``C`` be the sum of character counts
    across all lines. Each line ``i`` gets duration
    ``d_i = len(line_i) / C * T`` and is laid out back-to-back:

        start_0 = 0
        end_i   = start_i + d_i
        start_{i+1} = end_i
        end_{last}  = T      # exact, see below

    Rationale
    ---------
    - **Word-level timestamps from WhisperX are per-audio-word**, but cue
      boundaries are per *displayable* sentence which may include words
      that are not spoken (e.g. bracketed control markers were stripped
      upstream). Character weighting is a simple, stable proxy that does
      not rely on a brittle alignment between WhisperX words and display
      characters.
    - Back-to-back layout (no gap) matches the "continuous speech" nature
      of a single TTS take. Gaps would look like dropouts.
    - The last cue's ``end`` is snapped to ``T`` exactly to absorb float
      rounding — guarantees ``end_last <= total_duration`` always.

    Edge cases
    ----------
    - Empty ``lines`` list           → returns ``[]``.
    - ``total_duration <= 0``         → all cues collapse to ``(0.0, 0.0)``.
    - Lines with zero characters      → treated as 1 character each (to
      preserve ordering without division-by-zero).  In practice callers
      should pre-filter empty strings via :func:`split_subtitle_lines`.
    """
    if not lines:
        return []

    # Guard against zero-length lines sneaking in.
    char_counts = [max(len(line), 1) for line in lines]
    total_chars = sum(char_counts)

    if total_duration <= 0 or total_chars <= 0:
        return [(0.0, 0.0) for _ in lines]

    cues: list[tuple[float, float]] = []
    cursor = 0.0
    for i, c in enumerate(char_counts):
        share = c / total_chars
        duration = share * total_duration
        start = cursor
        end = cursor + duration
        cursor = end
        cues.append((start, end))

    # Snap the final end to exactly ``total_duration`` to kill float drift.
    if cues:
        last_start, _ = cues[-1]
        cues[-1] = (last_start, float(total_duration))
    return cues


# ---------------------------------------------------------------------------
# 4. SRT serialization
# ---------------------------------------------------------------------------


def _format_ts(seconds: float) -> str:
    """Format seconds as ``HH:MM:SS,mmm`` — SRT wire format.

    Negative values are clamped to zero (SRT has no negative timestamps).
    Milliseconds round to the nearest integer; carry is propagated up so
    ``999.6 ms`` rolls into the next second cleanly.
    """
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def build_srt(cues: list[tuple[float, float, str]]) -> str:
    """Serialize ``(start, end, text)`` triples to an SRT document.

    Output is LF-terminated and ends with a trailing blank line, which is
    the shape most SRT consumers expect.  Empty ``cues`` returns ``""``.
    """
    if not cues:
        return ""
    blocks: list[str] = []
    for i, (start, end, text) in enumerate(cues, start=1):
        block = (
            f"{i}\n"
            f"{_format_ts(start)} --> {_format_ts(end)}\n"
            f"{text}\n"
        )
        blocks.append(block)
    return "\n".join(blocks) + "\n"


# ---------------------------------------------------------------------------
# Orchestration helper (still pure)
# ---------------------------------------------------------------------------


def compose_srt(
    source_text: str,
    total_duration: float,
) -> tuple[str, int]:
    """One-shot transform: raw chunk text → (srt_document, line_count).

    This is the public entry point used by the Prefect task. Keeping the
    orchestration here (instead of in the task file) means the I/O layer
    shrinks to "read transcript → call compose_srt → upload SRT".
    """
    display = strip_control_markers(source_text)
    lines = split_subtitle_lines(display)
    if not lines:
        return "", 0
    timings = distribute_timestamps(lines, total_duration)
    cues = [(start, end, text) for (start, end), text in zip(timings, lines)]
    return build_srt(cues), len(lines)


__all__ = [
    "STRIPPABLE_MARKERS",
    "strip_control_markers",
    "split_subtitle_lines",
    "distribute_timestamps",
    "build_srt",
    "compose_srt",
]
