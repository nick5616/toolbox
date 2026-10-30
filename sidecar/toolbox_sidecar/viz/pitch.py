"""Vocal pitch with pYIN and held notes (SPEC.md §5.3)."""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

PYIN_SR = 16000
PYIN_HOP = 320  # 50 frames per second
PYIN_FPS = PYIN_SR / PYIN_HOP
FMIN, FMAX = 65.0, 1000.0
MIDI_LO, MIDI_HI = 40.0, 84.0
GAP_MS = 150
HELD_MIN_MS = 600
HELD_TOL = 0.5  # semitones


def prepare_signal(y: np.ndarray, sr: int, stems: bool) -> np.ndarray:
    """16 kHz mono; without a vocals stem the mix is band-passed to 300 Hz–4 kHz first."""
    import librosa
    from scipy.signal import butter, sosfilt

    y16 = librosa.resample(y.astype(np.float32), orig_sr=sr, target_sr=PYIN_SR)
    if not stems:
        sos = butter(4, [300.0, 4000.0], btype="bandpass", fs=PYIN_SR, output="sos")
        y16 = sosfilt(sos, y16).astype(np.float32)
    return y16


def run_pyin(y16: np.ndarray, check: Callable[[], None] | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(midi per 20 ms frame with NaN when unvoiced, voiced flags)."""
    import librosa

    if len(y16) < 2048:
        return np.full(1, np.nan), np.zeros(1, dtype=bool)
    # Long inputs go in 60 s slices so cancellation is honoured; slices are hop-aligned.
    step = 60 * PYIN_SR // PYIN_HOP * PYIN_HOP
    f0s, vs = [], []
    for a in range(0, len(y16), step):
        if check:
            check()
        seg = y16[a : a + step + 1024]  # a little overlap for the last frames
        f0, voiced, _ = librosa.pyin(seg, fmin=FMIN, fmax=FMAX, sr=PYIN_SR, frame_length=1024, hop_length=PYIN_HOP)
        n = min(step // PYIN_HOP, len(f0)) if a + step < len(y16) else len(f0)
        f0s.append(f0[:n])
        vs.append(voiced[:n])
    f0 = np.concatenate(f0s)
    voiced = np.concatenate(vs) & np.isfinite(f0)
    midi = np.where(voiced, librosa.hz_to_midi(np.where(np.isfinite(f0) & (f0 > 0), f0, 440.0)), np.nan)
    return midi, voiced


def _median_filter_voiced(midi: np.ndarray, voiced: np.ndarray, size: int = 5) -> np.ndarray:
    out = midi.copy()
    half = size // 2
    for i in np.flatnonzero(voiced):
        win = midi[max(0, i - half) : i + half + 1]
        win = win[np.isfinite(win)]
        if win.size:
            out[i] = np.median(win)
    return out


def bridge_gaps(voiced: np.ndarray, midi: np.ndarray, fps: float, gap_ms: float = GAP_MS) -> tuple[np.ndarray, np.ndarray]:
    """Fills unvoiced gaps ≤ gap_ms between voiced frames (pitch held from the left)."""
    v = voiced.copy()
    m = midi.copy()
    max_gap = int(gap_ms / 1000.0 * fps)
    idx = np.flatnonzero(voiced)
    for a, b in zip(idx[:-1], idx[1:]):
        gap = b - a - 1
        if 0 < gap <= max_gap:
            v[a + 1 : b] = True
            m[a + 1 : b] = m[a]
    return v, m


def held_notes(midi: np.ndarray, voiced: np.ndarray, fps: float) -> list[list[int]]:
    """[[startMs, endMs, midi]] for voiced runs ≥ 600 ms within ±0.5 semitone of their median."""
    out: list[list[int]] = []
    n = len(voiced)
    i = 0
    ms = lambda f: int(round(f / fps * 1000.0))
    min_len = int(np.ceil(HELD_MIN_MS / 1000.0 * fps))
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j < n and voiced[j]:
            j += 1
        s = i
        while s < j:
            e = s + 1
            # grow while the next frame stays near the running median (sampled to keep it cheap)
            while e < j and abs(midi[e] - np.median(midi[s : e + 1])) <= HELD_TOL:
                e += 1
            if e - s >= min_len:
                med = np.median(midi[s:e])
                if np.all(np.abs(midi[s:e] - med) <= HELD_TOL * 1.5):
                    out.append([ms(s), ms(e), int(round(float(med)))])
            s = e
        i = j
    return out


def pitch_channels(
    midi: np.ndarray, voiced: np.ndarray, frames: int, fps: int
) -> tuple[np.ndarray, np.ndarray, list[list[int]]]:
    """(pitch 0..1 at fps, voiced 0/1 at fps, held notes). Pitch holds its last value."""
    midi = _median_filter_voiced(midi, voiced)
    voiced, midi = bridge_gaps(voiced, midi, PYIN_FPS)
    held = held_notes(midi, voiced, PYIN_FPS)
    # Hold the last voiced pitch through silence.
    filled = midi.copy()
    last = 0.5 * (MIDI_LO + MIDI_HI)
    first = np.flatnonzero(voiced)
    if first.size:
        last = float(midi[first[0]])
    for i in range(len(filled)):
        if voiced[i] and np.isfinite(midi[i]):
            last = float(midi[i])
        filled[i] = last
    idx = np.clip(np.floor(np.arange(frames) / fps * PYIN_FPS).astype(np.int64), 0, len(filled) - 1)
    pitch = np.clip((filled[idx] - MIDI_LO) / (MIDI_HI - MIDI_LO), 0.0, 1.0).astype(np.float32)
    return pitch, voiced[idx].astype(np.float32), held
