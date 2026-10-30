"""Decoding and the s<0|1>.json / .bin writer (SPEC.md §5.2, §5.5)."""

from __future__ import annotations

import json
import os
from typing import Any

import numpy as np

from ..registry import HandlerError

#: Analysis sample rate. SPEC §5.2 says 22,050 Hz, but the "air" band (12 kHz+) and the 16 kHz
#: spectrum bins need a Nyquist above 12 kHz, so the engine decodes at 32 kHz.
SR = 32000
MAX_SEC = 60 * 60
LONG_SEC = 20 * 60


def choose_fps(duration_sec: float, requested: int | None = None) -> int:
    """60 up to 20 minutes, 30 above; a requested 30 is honoured for short inputs."""
    if duration_sec > LONG_SEC:
        return 30
    if requested in (30, 60):
        return int(requested)
    return 60


def probe_duration(path: str) -> float:
    """Duration in seconds without decoding (0.0 when unknown). Tests patch this."""
    import librosa

    try:
        return float(librosa.get_duration(path=path))
    except Exception:
        return 0.0


def decode(path: str, *, stereo: bool = False) -> tuple[np.ndarray, np.ndarray | None]:
    """Mono float32 at SR. With stereo=True also returns the (2, n) channels, else None."""
    import librosa

    try:
        y, _ = librosa.load(path, sr=SR, mono=False)
    except Exception as e:  # undecodable file
        raise HandlerError("tool_failed", f"Couldn't read audio: {e}", "Is this a valid audio file?") from e
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1:
        return y, None
    mono = y.mean(axis=0).astype(np.float32)
    return mono, (y[:2] if stereo and y.shape[0] >= 2 else None)


def fit_length(y: np.ndarray, n: int) -> np.ndarray:
    if len(y) >= n:
        return y[:n]
    return np.pad(y, (0, n - len(y)))


def to_u8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(np.asarray(x, dtype=np.float64) * 255.0), 0, 255).astype(np.uint8)


def write_atomic(path: str, data: bytes) -> None:
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def write_outputs(
    out_dir: str,
    name: str,
    doc: dict[str, Any],
    scalars: list[tuple[str, np.ndarray]],
    vectors: list[tuple[str, np.ndarray]],
) -> tuple[str, str]:
    """Writes <name>.bin then <name>.json; fills doc["blocks"] and doc["features"]."""
    frames = int(doc["frames"])
    blocks: list[dict[str, Any]] = []
    offset = 0
    bin_path = os.path.join(out_dir, name + ".bin")
    tmp = bin_path + ".part"
    with open(tmp, "wb") as f:
        for bid, arr in scalars:
            a = np.asarray(arr, dtype=np.uint8)
            if a.shape != (frames,):
                raise ValueError(f"block {bid}: shape {a.shape}, want ({frames},)")
            f.write(a.tobytes())
            blocks.append({"id": bid, "kind": "scalar", "offset": offset, "width": 1})
            offset += frames
        for bid, arr in vectors:
            a = np.asarray(arr, dtype=np.uint8)
            if a.ndim != 2 or a.shape[0] != frames:
                raise ValueError(f"block {bid}: shape {a.shape}")
            f.write(np.ascontiguousarray(a).tobytes())
            blocks.append({"id": bid, "kind": "vector", "offset": offset, "width": int(a.shape[1])})
            offset += frames * int(a.shape[1])
    os.replace(tmp, bin_path)
    doc["blocks"] = blocks
    doc["features"] = name + ".bin"
    json_path = os.path.join(out_dir, name + ".json")
    write_atomic(json_path, json.dumps(doc, separators=(",", ":")).encode("utf-8"))
    return json_path, bin_path
