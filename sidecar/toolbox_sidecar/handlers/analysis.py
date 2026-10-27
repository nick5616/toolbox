"""analysis handlers: BPM and key detection (SPEC.md §4.6)."""

from __future__ import annotations

import os
from typing import Any

from ..registry import Context, HandlerError, handler

SAMPLE_RATE = 22050
MAX_ANALYSIS_SEC = 180.0
MIN_ANALYSIS_SEC = 1.0

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl–Schmuckler probe-tone profiles, tonic first.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def camelot(pitch_class: int, minor: bool) -> str:
    """Camelot wheel code: C major = 8B, A minor = 8A, G major = 9B, E minor = 9A."""
    relative_major = (pitch_class + 3) % 12 if minor else pitch_class
    number = (relative_major * 7 + 7) % 12 + 1
    return f"{number}{'A' if minor else 'B'}"


def key_name(pitch_class: int, minor: bool) -> str:
    return f"{NOTE_NAMES[pitch_class]} {'minor' if minor else 'major'}"


def rank_keys(chroma_mean: Any) -> list[dict[str, Any]]:
    """All 24 keys sorted by Pearson correlation with chroma_mean (best first)."""
    import numpy as np

    chroma = np.asarray(chroma_mean, dtype=float)
    out: list[dict[str, Any]] = []
    for minor, profile in ((False, MAJOR_PROFILE), (True, MINOR_PROFILE)):
        prof = np.asarray(profile, dtype=float)
        for pc in range(12):
            r = float(np.corrcoef(chroma, np.roll(prof, pc))[0, 1])
            if np.isnan(r):
                r = 0.0
            out.append({"key": key_name(pc, minor), "camelot": camelot(pc, minor), "r": r})
    out.sort(key=lambda k: k["r"], reverse=True)
    return out


def _require_input(params: dict[str, Any]) -> str:
    path = params.get("input")
    if not isinstance(path, str) or not path:
        raise HandlerError("validation", "input is required")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    return path


@handler("analysis.bpm_key")
def analysis_bpm_key(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = _require_input(params)

    ctx.stage("Loading audio")
    import numpy as np
    import librosa

    try:
        total = float(librosa.get_duration(path=path))
    except Exception:
        total = 0.0
    try:
        y, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True, duration=MAX_ANALYSIS_SEC)
    except Exception as e:  # undecodable file
        raise HandlerError("tool_failed", f"Couldn't read audio: {e}", "Is this a valid audio file?") from e
    if total <= 0:
        total = len(y) / sr
    truncated = total > MAX_ANALYSIS_SEC + 0.01
    if len(y) / sr < MIN_ANALYSIS_SEC or float(np.max(np.abs(y), initial=0.0)) < 1e-4:
        raise HandlerError("validation", "Audio is too short or silent to analyse")
    ctx.check_cancelled()

    ctx.stage("Detecting tempo")
    tempo, _beats = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(np.asarray(tempo).reshape(-1)[0]), 1)
    candidates: list[float] = []
    for c in (bpm / 2, bpm, bpm * 2):
        c = round(c, 1)
        if 60 <= c <= 200 and c not in candidates:
            candidates.append(c)
    ctx.check_cancelled()

    ctx.stage("Detecting key")
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    ranked = rank_keys(chroma.mean(axis=1))
    best = ranked[0]
    alternatives = [
        {"key": k["key"], "camelot": k["camelot"], "r": round(k["r"], 2)} for k in ranked[1:4]
    ]
    return {
        "bpm": bpm,
        "bpmCandidates": candidates,
        "key": best["key"],
        "camelot": best["camelot"],
        "confidence": round(best["r"], 2),
        "alternatives": alternatives,
        "durationSec": round(total, 1),
        "truncated": truncated,
    }
