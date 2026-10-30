"""Frame features: levels, bands, onsets, brightness, balance, spectrum, wave, events (SPEC.md §5.2).

Everything is computed at the native frame rate (hop = round(SR / fps)) in chunks and then
interpolated onto the exact output grid t_i = i / fps, so a 3-hour-long drift never builds up.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np

from .io import SR

N_FFT = 2048
N_MELS = 64
CHUNK_FRAMES = 4096
NYQ = SR / 2

MIX_BANDS: list[tuple[str, float, float]] = [
    ("sub", 20, 60),
    ("bass", 60, 250),
    ("lowmid", 250, 500),
    ("mid", 500, 2000),
    ("highmid", 2000, 4000),
    ("presence", 4000, 6000),
    ("brilliance", 6000, 12000),
    ("air", 12000, NYQ),
]
#: Extra mix bands only used for onsets (event fallbacks and the downbeat score).
MIX_EXTRA = [("low", 20, 250)]
DRUM_BANDS = [("kick", 20, 150), ("snare", 150, 2500), ("hats", 6000, NYQ)]

SPEC_BINS = 64
SPEC_LO, SPEC_HI = 30.0, 16000.0
WAVE_WIDTH = 64
WAVE_TAPS = 8  # samples averaged per wave point (512 samples ≈ 16 ms)

MIN_GAP_MS = 110


def hop_for(fps: int) -> int:
    return int(round(SR / fps))


def n_frames(n_samples: int, fps: int) -> int:
    return max(1, int(np.ceil(n_samples / SR * fps - 1e-9)))


# -- normalisation ---------------------------------------------------------------------


def norm01(x: np.ndarray, lo_p: float = 5.0, hi_p: float = 98.0, min_span: float = 1e-9) -> np.ndarray:
    """Percentile p5 → 0 and p98 → 1, clipped. A degenerate span gives zeros."""
    x = np.asarray(x, dtype=np.float32)
    if x.size == 0:
        return x
    sample = x.ravel()
    if sample.size > 2_000_000:
        sample = sample[:: sample.size // 2_000_000 + 1]
    lo, hi = np.percentile(sample, [lo_p, hi_p])
    span = max(float(hi - lo), min_span)
    if hi - lo <= 1e-12 and min_span <= 1e-9:
        return np.zeros_like(x)
    return np.clip((x - lo) / span, 0.0, 1.0).astype(np.float32)


def db_floor(db: np.ndarray, below_top: float = 60.0) -> np.ndarray:
    """Clips a dB array so silence doesn't stretch the range."""
    if db.size == 0:
        return db
    sample = db.ravel()
    if sample.size > 2_000_000:
        sample = sample[:: sample.size // 2_000_000 + 1]
    top = float(np.percentile(sample, 99.5))
    return np.maximum(db, top - below_top)


def power_db(p: np.ndarray) -> np.ndarray:
    return (10.0 * np.log10(np.maximum(p, 1e-12))).astype(np.float32)


def norm_db(p: np.ndarray) -> np.ndarray:
    """Power → dB → floored → p5..p98 normalised (min span 6 dB, so noise isn't amplified)."""
    return norm01(db_floor(power_db(p)), min_span=6.0)


def onset_norm(env: np.ndarray) -> np.ndarray:
    """Divide by p99 and clip."""
    env = np.maximum(np.asarray(env, dtype=np.float32), 0)
    if env.size == 0:
        return env
    p99 = float(np.percentile(env, 99))
    if p99 <= 1e-9:
        return np.zeros_like(env)
    return np.clip(env / p99, 0.0, 1.0).astype(np.float32)


def flux(db: np.ndarray) -> np.ndarray:
    """Positive first difference of a dB series."""
    if db.size == 0:
        return db
    d = np.diff(db, prepend=db[:1])
    return np.maximum(d, 0).astype(np.float32)


# -- grid resampling -------------------------------------------------------------------


def to_grid(x: np.ndarray, hop: int, frames: int, fps: int) -> np.ndarray:
    """Interpolates native frames (k * hop / SR) onto the output grid (i / fps). Rows are frames."""
    x = np.asarray(x, dtype=np.float32)
    pos = np.arange(frames, dtype=np.float64) / fps * SR / hop
    i0 = np.clip(np.floor(pos).astype(np.int64), 0, len(x) - 1)
    i1 = np.minimum(i0 + 1, len(x) - 1)
    w = np.clip(pos - i0, 0.0, 1.0).astype(np.float32)
    if x.ndim == 2:
        w = w[:, None]
    return (x[i0] * (1 - w) + x[i1] * w).astype(np.float32)


# -- spectral analysis -----------------------------------------------------------------


def _band_matrix(bands: list[tuple[str, float, float]], n_bins: int) -> np.ndarray:
    freqs = np.linspace(0, NYQ, n_bins)
    m = np.zeros((len(bands), n_bins), dtype=np.float32)
    for i, (_, lo, hi) in enumerate(bands):
        sel = (freqs >= lo) & (freqs < hi)
        if not sel.any():
            sel[int(np.argmin(np.abs(freqs - (lo + hi) / 2)))] = True
        m[i, sel] = 1.0
    return m


def _spectrum_matrix(n_bins: int) -> np.ndarray:
    """64 log-spaced bins 30 Hz–16 kHz: mean power over the FFT bins each one covers."""
    df = NYQ / (n_bins - 1)
    edges = np.geomspace(SPEC_LO, SPEC_HI, SPEC_BINS + 1)
    m = np.zeros((SPEC_BINS, n_bins), dtype=np.float32)
    k_lo = (np.arange(n_bins) - 0.5) * df
    k_hi = (np.arange(n_bins) + 0.5) * df
    for b in range(SPEC_BINS):
        ov = np.clip(np.minimum(k_hi, edges[b + 1]) - np.maximum(k_lo, edges[b]), 0, None)
        if ov.sum() <= 0:
            ov[int(np.argmin(np.abs(np.arange(n_bins) * df - edges[b])))] = 1.0
        m[b] = ov / ov.sum()
    return m


def source_features(
    y: np.ndarray,
    hop: int,
    bands: list[tuple[str, float, float]],
    *,
    spectrum: bool = False,
    centroid: bool = False,
    check: Callable[[], None] | None = None,
    tick: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    """Native-rate features of one signal.

    Returns rms (linear), mel (power, 64 x F), bands {name: power}, and optionally
    centroid (Hz) and spec (F x 64 power).
    """
    import librosa

    pad = N_FFT // 2
    n_f = 1 + len(y) // hop
    yp = np.pad(y.astype(np.float32, copy=False), (pad, pad + hop))
    n_bins = N_FFT // 2 + 1
    mel_fb = librosa.filters.mel(sr=SR, n_fft=N_FFT, n_mels=N_MELS).astype(np.float32)
    bm = _band_matrix(bands, n_bins) if bands else None
    sm = _spectrum_matrix(n_bins) if spectrum else None
    freqs = np.linspace(0, NYQ, n_bins, dtype=np.float32)

    rms = np.zeros(n_f, dtype=np.float32)
    mel = np.zeros((N_MELS, n_f), dtype=np.float32)
    bnd = np.zeros((len(bands), n_f), dtype=np.float32)
    cen = np.zeros(n_f, dtype=np.float32) if centroid else None
    spec = np.zeros((n_f, SPEC_BINS), dtype=np.float32) if spectrum else None

    for a in range(0, n_f, CHUNK_FRAMES):
        if check:
            check()
        b = min(n_f, a + CHUNK_FRAMES)
        seg = yp[a * hop : (b - 1) * hop + N_FFT]
        s = librosa.stft(seg, n_fft=N_FFT, hop_length=hop, center=False)
        p = (s.real**2 + s.imag**2).astype(np.float32)
        rms[a:b] = librosa.feature.rms(y=seg, frame_length=N_FFT, hop_length=hop, center=False)[0][: b - a]
        mel[:, a:b] = mel_fb @ p
        if bm is not None:
            bnd[:, a:b] = bm @ p
        if cen is not None:
            mag = np.sqrt(p)
            cen[a:b] = (freqs @ mag) / (mag.sum(axis=0) + 1e-9)
        if spec is not None and sm is not None:
            spec[a:b] = (sm @ p).T
        if tick:
            tick(b / n_f)
    return {
        "rms": rms,
        "mel": mel,
        "bands": {name: bnd[i] for i, (name, _, _) in enumerate(bands)},
        "centroid": cen,
        "spec": spec,
    }


def mel_db(mel: np.ndarray) -> np.ndarray:
    import librosa

    return librosa.power_to_db(mel, top_db=70.0).astype(np.float32)


def mel_onset(mel: np.ndarray, hop: int) -> np.ndarray:
    """Spectral-flux onset strength at the native rate (librosa)."""
    import librosa

    return librosa.onset.onset_strength(S=mel_db(mel), sr=SR, hop_length=hop).astype(np.float32)


def band_onset(power: np.ndarray) -> np.ndarray:
    return flux(db_floor(power_db(power), 50.0))


def level_channel(rms: np.ndarray) -> np.ndarray:
    return norm_db(rms.astype(np.float32) ** 2)


def brightness_channel(centroid: np.ndarray) -> np.ndarray:
    lo, hi = np.log(200.0), np.log(8000.0)
    v = (np.log(np.clip(centroid, 200.0, 8000.0)) - lo) / (hi - lo)
    return norm01(v.astype(np.float32), min_span=0.1)


def balance_channel(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    """0.5 = centre, 1 = hard right (frame RMS of each side)."""
    tot = left + right
    bal = np.where(tot > 1e-6, 0.5 + 0.5 * (right - left) / np.maximum(tot, 1e-6), 0.5)
    return np.clip(bal, 0.0, 1.0).astype(np.float32)


def stereo_rms(stereo: np.ndarray, hop: int) -> tuple[np.ndarray, np.ndarray]:
    import librosa

    out = []
    pad = N_FFT // 2
    for ch in stereo[:2]:
        yp = np.pad(ch, (pad, pad + hop))
        out.append(librosa.feature.rms(y=yp, frame_length=N_FFT, hop_length=hop, center=False)[0][: 1 + len(ch) // hop])
    return out[0], out[1]


def smooth(x: np.ndarray, n: int) -> np.ndarray:
    if n <= 1:
        return x
    k = np.ones(n, dtype=np.float32) / n
    return np.convolve(np.pad(x, (n // 2, n - 1 - n // 2), mode="edge"), k, mode="valid").astype(np.float32)


def wave_block(y: np.ndarray, hop: int, frames: int, fps: int) -> np.ndarray:
    """64 signed samples per output frame (local mean of 8 taps), peak-normalised, as u8 (128 = 0)."""
    width = WAVE_WIDTH * WAVE_TAPS
    centres = np.rint(np.arange(frames) / fps * SR).astype(np.int64)
    yp = np.pad(y.astype(np.float32, copy=False), (width // 2, width // 2 + 1))
    out = np.zeros((frames, WAVE_WIDTH), dtype=np.float32)
    step = 8192
    base = np.arange(width)
    for a in range(0, frames, step):
        idx = centres[a : a + step, None] + base[None, :]
        out[a : a + step] = yp[idx].reshape(-1, WAVE_WIDTH, WAVE_TAPS).mean(axis=2)
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 1e-9:
        out /= peak
    return np.clip(np.rint(128 + out * 127), 1, 255).astype(np.uint8)


# -- events ------------------------------------------------------------------------------


def peak_events(env: np.ndarray, fps: int, min_gap_ms: int = MIN_GAP_MS) -> list[list[int]]:
    """[[ms, strength 0-255]] peak-picked from a 0..1 onset envelope."""
    import librosa

    if env.size < 4 or float(env.max()) <= 1e-6:
        return []
    ms_per = 1000.0 / fps
    wait = max(1, int(round(min_gap_ms / ms_per)))
    # onset_detect normalises the envelope itself; keep the absolute level for the strength.
    idx = librosa.onset.onset_detect(
        onset_envelope=env.astype(np.float32),
        sr=fps,
        hop_length=1,
        pre_max=max(1, int(0.03 * fps)),
        post_max=max(1, int(0.03 * fps)),
        pre_avg=max(1, int(0.1 * fps)),
        post_avg=max(2, int(0.1 * fps)),
        delta=0.08,
        wait=wait,
        backtrack=False,
        normalize=True,
    )
    out: list[list[int]] = []
    for i in np.asarray(idx, dtype=int):
        if i < 0 or i >= len(env):
            continue
        # The peak is the max within the previous/next few frames (detect can be a frame off).
        lo, hi = max(0, i - 2), min(len(env), i + 3)
        j = lo + int(np.argmax(env[lo:hi]))
        s = int(round(float(env[j]) * 255))
        if s < 25:
            continue
        ms = int(round(j * ms_per))
        if out and ms - out[-1][0] < min_gap_ms:
            if s > out[-1][1]:
                out[-1] = [ms, min(255, s)]
            continue
        out.append([ms, min(255, s)])
    return out
