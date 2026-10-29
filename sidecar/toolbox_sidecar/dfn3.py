"""DeepFilterNet3 inference with plain onnxruntime + numpy (SPEC.md §0.4, §6.2).

A port of libDF's offline enhance (verified against the official binary):
STFT, ERB/spec features with running normalisation, two frames of lookahead,
an ERB gain mask and a 5-tap deep filter. No attenuation limit is applied.
Long inputs are processed in 30 s chunks joined with 1 s linear crossfades,
because the models are stateless across calls and a whole file needs
~2 GB per 10 minutes.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

import numpy as np

SR = 48000
N = 960
HOP = 480
NB_ERB = 32
NB_DF = 96
ORDER = 5
DF_LA = 2
CONV_LA = 2
ALPHA = 0.99  # get_norm_alpha(hop / sr, tau = 1) as rounded in df.utils

CHUNK_SECONDS = 30
FADE_SECONDS = 1
MODEL_FILES = ("enc", "erb_dec", "df_dec")

_WINDOW = np.sin(0.5 * np.pi * np.sin(np.pi * (np.arange(N) + 0.5) / N) ** 2).astype(np.float32)
_WNORM = 1 / (N * N / (2 * HOP))


def erb_fb(sr: int = SR, n: int = N, nb: int = NB_ERB, min_nb: int = 2) -> np.ndarray:
    def f2e(f: float) -> float:
        return 9.265 * np.log1p(f / (24.7 * 9.265))

    def e2f(e: float) -> float:
        return 24.7 * 9.265 * (np.exp(e / 9.265) - 1)

    step = (f2e(sr // 2) - f2e(0)) / nb
    prev = over = 0
    out: list[int] = []
    for i in range(1, nb + 1):
        fb = int(round(float(np.float32(e2f(i * step))) / (sr / n)))
        k = fb - prev - over
        if k < min_nb:
            over = min_nb - k
            k = min_nb
        else:
            over = 0
        out.append(k)
        prev = fb
    out[-1] += 1
    out[-1] -= sum(out) - (n // 2 + 1)
    return np.array(out)


_BANDS = erb_fb()
_IDX = np.repeat(np.arange(NB_ERB), _BANDS)


class Sessions:
    """The three onnxruntime sessions of one model directory."""

    def __init__(self, model_dir: str) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.sess = {
            k: ort.InferenceSession(
                os.path.join(model_dir, f"{k}.onnx"), sess_options=opts, providers=["CPUExecutionProvider"]
            )
            for k in MODEL_FILES
        }


_cache: dict[str, Sessions] = {}


def load_sessions(model_dir: str) -> Sessions:
    """One cached session set per model directory (a single set stays resident)."""
    key = os.path.abspath(model_dir)
    s = _cache.get(key)
    if s is None:
        _cache.clear()
        s = _cache[key] = Sessions(model_dir)
    return s


def enhance(x: np.ndarray, sessions: Sessions) -> np.ndarray:
    """Denoises one mono float32 48 kHz signal (offline framing, no delay)."""
    sess = sessions.sess
    n_in = len(x)
    if n_in == 0:
        return x.astype(np.float32)
    x = np.concatenate([np.zeros(HOP, np.float32), x.astype(np.float32), np.zeros(N, np.float32)])
    t_n = (len(x) - N) // HOP + 1
    frames = np.lib.stride_tricks.sliding_window_view(x, N)[::HOP][:t_n]
    spec = (np.fft.rfft(frames * _WINDOW, axis=1) * _WNORM).astype(np.complex64)  # [T, 481]

    power = np.zeros((t_n, NB_ERB), np.float32)
    np.add.at(power.T, _IDX, (np.abs(spec) ** 2).T)
    power /= _BANDS
    erb = 10 * np.log10(power + 1e-10)
    s = np.linspace(-60, -90, NB_ERB, dtype=np.float32)
    df = spec[:, :NB_DF].copy()
    u = np.linspace(1e-3, 1e-4, NB_DF, dtype=np.float32)
    for t in range(t_n):  # exponential norms (sequential)
        s = erb[t] * (1 - ALPHA) + s * ALPHA
        erb[t] = (erb[t] - s) / 40
        u = np.abs(df[t]) * (1 - ALPHA) + u * ALPHA
        df[t] = df[t] / np.sqrt(u)

    def shift(a: np.ndarray) -> np.ndarray:  # pad_feat
        return np.concatenate([a[CONV_LA:], np.zeros((CONV_LA,) + a.shape[1:], a.dtype)])

    fe = shift(erb)[None, None].astype(np.float32)
    sd = shift(df)
    fs = np.stack([sd.real, sd.imag])[None].astype(np.float32)  # [1, 2, T, 96]
    e0, e1, e2, e3, emb, c0, _lsnr = sess["enc"].run(None, {"feat_erb": fe, "feat_spec": fs})
    m = sess["erb_dec"].run(None, {"emb": emb, "e3": e3, "e2": e2, "e1": e1, "e0": e0})[0][0, 0]
    coefs = sess["df_dec"].run(None, {"emb": emb, "c0": c0})[0][0]  # [T, 96, 10]

    y_spec = spec * m[:, _IDX]  # ERB mask
    c = coefs.reshape(t_n, NB_DF, ORDER, 2)
    c = c[..., 0] + 1j * c[..., 1]
    xp = np.concatenate(
        [np.zeros((ORDER - 1 - DF_LA, NB_DF), spec.dtype), spec[:, :NB_DF], np.zeros((DF_LA, NB_DF), spec.dtype)]
    )
    y_spec[:, :NB_DF] = sum(xp[o : o + t_n] * c[:, :, o] for o in range(ORDER))  # deep filter
    y = np.fft.irfft(y_spec, n=N, axis=1) * N * _WINDOW
    out = np.zeros(HOP * (t_n + 1), np.float32)
    for t in range(t_n):
        out[t * HOP : t * HOP + N] += y[t]
    return out[HOP : HOP + n_in]


def chunk_spans(length: int, chunk: int, fade: int) -> list[tuple[int, int]]:
    """[start, end) spans covering length; neighbours overlap by exactly fade samples."""
    if length <= chunk:
        return [(0, length)]
    spans: list[tuple[int, int]] = []
    start = 0
    step = chunk - fade
    while True:
        end = min(start + chunk, length)
        spans.append((start, end))
        if end >= length:
            break
        start += step
    # a tail no longer than the fade would break the ramps: merge it
    if len(spans) > 1 and spans[-1][1] - spans[-1][0] <= fade:
        spans.pop()
        spans[-1] = (spans[-1][0], length)
    return spans


def process_channel(
    x: np.ndarray,
    fn: Callable[[np.ndarray], np.ndarray],
    *,
    chunk: int = CHUNK_SECONDS * SR,
    fade: int = FADE_SECONDS * SR,
    on_chunk: Callable[[], None] | None = None,
) -> np.ndarray:
    """Applies fn chunk by chunk and joins the pieces with linear crossfades.

    on_chunk is called before each chunk (progress / cancellation hook).
    """
    spans = chunk_spans(len(x), chunk, fade)
    out = np.zeros(len(x), np.float32)
    ramp = np.linspace(0, 1, fade, endpoint=False, dtype=np.float32) + 1 / (2 * fade)
    for i, (a, b) in enumerate(spans):
        if on_chunk is not None:
            on_chunk()
        y = np.asarray(fn(x[a:b]), np.float32)
        w = np.ones(b - a, np.float32)
        if i > 0:
            w[:fade] = ramp
        if i < len(spans) - 1:
            w[-fade:] = 1 - ramp
        out[a:b] += y[: b - a] * w
    return out


def enhance_file(
    src: str,
    dst: str,
    model_dir: str,
    *,
    progress: Callable[[float, str], None] | None = None,
    check_cancelled: Callable[[], None] | None = None,
    sessions: Any = None,
) -> dict[str, Any]:
    """Denoises a 48 kHz WAV (any channel count) into a float WAV."""
    import soundfile as sf

    data, sr = sf.read(src, dtype="float32", always_2d=True)
    if sr != SR:
        raise ValueError(f"expected {SR} Hz audio, got {sr}")
    sess = sessions if sessions is not None else load_sessions(model_dir)
    chans = data.shape[1]
    per = len(chunk_spans(data.shape[0], CHUNK_SECONDS * SR, FADE_SECONDS * SR))
    total = chans * per
    done = 0

    def tick() -> None:
        nonlocal done
        if check_cancelled:
            check_cancelled()
        if progress:
            progress(done / total, "Isolating voice")
        done += 1

    out = np.zeros_like(data)
    for c in range(chans):
        out[:, c] = process_channel(data[:, c], lambda a: enhance(a, sess), on_chunk=tick)
    if check_cancelled:
        check_cancelled()
    sf.write(dst, out, SR, subtype="FLOAT")
    if progress:
        progress(1.0, "Isolating voice")
    return {"channels": chans, "seconds": data.shape[0] / SR, "chunks": total}

