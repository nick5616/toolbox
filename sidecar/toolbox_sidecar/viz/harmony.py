"""Chords (per beat, Viterbi-smoothed) and key (SPEC.md §5.3)."""

from __future__ import annotations

from typing import Any

import numpy as np

from ..handlers.analysis import NOTE_NAMES, camelot, rank_keys

#: Chroma frame rate target; the CQT hop must be a multiple of 64.
CHROMA_HOP = 2112
EMIT_SHARPNESS = 30.0


def chroma_hop() -> int:
    return CHROMA_HOP


def compute_chroma(y: np.ndarray, sr: int) -> np.ndarray:
    """(12, F) CQT chroma at about 15 Hz (frame k is centred on k * CHROMA_HOP / sr)."""
    import librosa

    return librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=CHROMA_HOP).astype(np.float32)


def templates() -> tuple[np.ndarray, list[tuple[int, bool]]]:
    """24 unit-norm major/minor triad templates, and (root, minor) per row."""
    rows, meta = [], []
    for root in range(12):
        for minor, third in ((False, 4), (True, 3)):
            v = np.zeros(12)
            v[[root, (root + third) % 12, (root + 7) % 12]] = 1.0
            rows.append(v / np.linalg.norm(v))
            meta.append((root, minor))
    return np.array(rows), meta


def beat_chroma(chroma: np.ndarray, beats_ms: np.ndarray, sr: int, duration_ms: float) -> np.ndarray:
    """(12, B) median chroma of each beat's span (the last beat runs to one beat period or the end)."""
    n_c = chroma.shape[1]
    fr = lambda ms: ms / 1000.0 * sr / CHROMA_HOP
    out = np.zeros((12, len(beats_ms)), dtype=np.float32)
    for i, t in enumerate(beats_ms):
        end = beats_ms[i + 1] if i + 1 < len(beats_ms) else min(duration_ms, t + (t - beats_ms[i - 1] if i else 500.0))
        a = int(np.clip(round(fr(t)), 0, n_c - 1))
        b = int(np.clip(round(fr(end)), a + 1, n_c))
        out[:, i] = np.median(chroma[:, a:b], axis=1)
    return out


def viterbi_chords(bc: np.ndarray, self_p: float = 0.9) -> tuple[np.ndarray, np.ndarray]:
    """Per-beat template indices (Viterbi, self-transition 0.9) and their cosines."""
    import librosa

    temps, _ = templates()
    # Compress so a strong bass note doesn't hide the other chord tones.
    peak = bc.max(axis=0, keepdims=True)
    comp = np.sqrt(np.clip(bc / np.maximum(peak, 1e-9), 0.0, 1.0))
    norms = np.linalg.norm(comp, axis=0, keepdims=True)
    cos = temps @ (comp / (norms + 1e-9))  # (24, B)
    cos = np.where(peak < 1e-6, 0.0, cos)
    emit = np.exp(EMIT_SHARPNESS * cos)
    emit /= emit.sum(axis=0, keepdims=True)
    n = temps.shape[0]
    trans = np.full((n, n), (1.0 - self_p) / (n - 1))
    np.fill_diagonal(trans, self_p)
    path = librosa.sequence.viterbi(emit, trans)
    best = cos[path, np.arange(cos.shape[1])]
    return np.asarray(path), best


def chord_name(root: int, minor: bool) -> str:
    return NOTE_NAMES[root] + ("m" if minor else "")


def decide_chords(
    bc: np.ndarray, beats_ms: np.ndarray, duration_ms: float
) -> tuple[list[dict[str, Any]], np.ndarray, list[int]]:
    """(merged chord list, per-beat change flags, per-beat state index; -1 = N)."""
    n = bc.shape[1]
    if n == 0:
        return [], np.zeros(0, dtype=bool), []
    _, meta = templates()
    path, cos = viterbi_chords(bc)
    states = [int(p) if c >= 0.5 else -1 for p, c in zip(path, cos)]
    change = np.zeros(n, dtype=bool)
    for i in range(1, n):
        change[i] = states[i] != states[i - 1]
    chords: list[dict[str, Any]] = []
    for i, st in enumerate(states):
        start = int(round(beats_ms[i]))
        end = int(round(beats_ms[i + 1])) if i + 1 < n else int(round(max(duration_ms, beats_ms[i] + 1)))
        if i + 1 == n and i > 0:
            end = int(round(min(duration_ms, beats_ms[i] + (beats_ms[i] - beats_ms[i - 1]))))
            end = max(end, start + 1)
        if chords and chords[-1]["_st"] == st:
            chords[-1]["endMs"] = end
            continue
        if st < 0:
            c = {"startMs": start, "endMs": end, "name": "N", "root": -1, "minor": False, "_st": st}
        else:
            root, minor = meta[st]
            c = {"startMs": start, "endMs": end, "name": chord_name(root, minor), "root": root, "minor": bool(minor), "_st": st}
        chords.append(c)
    for c in chords:
        del c["_st"]
    return chords, change, states


def key_from_chroma(chroma: np.ndarray) -> dict[str, Any]:
    ranked = rank_keys(chroma.mean(axis=1))
    best = ranked[0]
    name = best["key"]
    return {"name": name, "camelot": best["camelot"], "minor": name.endswith("minor"), "ranked": ranked}


__all__ = ["camelot", "compute_chroma", "beat_chroma", "decide_chords", "key_from_chroma", "templates"]
