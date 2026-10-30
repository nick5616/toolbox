"""Tempo, beats and downbeats (SPEC.md §5.2)."""

from __future__ import annotations

import numpy as np

BEATS_PER_BAR = 4
KICK_WINDOW_MS = 70.0


def track_beats(onset_env: np.ndarray, fps: int) -> tuple[float, np.ndarray]:
    """(tempo bpm, beat times in ms) from the mix onset envelope on the output grid."""
    import librosa

    if onset_env.size < 8 or float(onset_env.max()) <= 1e-6:
        return 0.0, np.zeros(0)
    tempo, frames = librosa.beat.beat_track(onset_envelope=onset_env.astype(np.float32), sr=fps, hop_length=1)
    t = float(np.asarray(tempo).reshape(-1)[0])
    ms = np.asarray(frames, dtype=np.float64) / fps * 1000.0
    return round(t, 1), ms


def downbeat_phase(
    beats_ms: np.ndarray,
    kick_env: np.ndarray,
    fps: int,
    chord_change: np.ndarray | None = None,
) -> int:
    """The phase p in 0..3 whose beats (i % 4 == p) carry the most kick, plus 0.5 per chord change."""
    n = len(beats_ms)
    if n < BEATS_PER_BAR:
        return 0
    half = max(1, int(round(KICK_WINDOW_MS / 1000.0 * fps)))
    strength = np.zeros(n)
    for i, t in enumerate(beats_ms):
        c = int(round(t / 1000.0 * fps))
        lo, hi = max(0, c - half), min(len(kick_env), c + half + 1)
        strength[i] = float(kick_env[lo:hi].max()) if hi > lo else 0.0
    if chord_change is not None and len(chord_change) == n:
        strength = strength + 0.5 * chord_change.astype(np.float64)
    scores = [float(strength[p::BEATS_PER_BAR].mean()) if len(strength[p::BEATS_PER_BAR]) else 0.0 for p in range(BEATS_PER_BAR)]
    return int(np.argmax(scores))
