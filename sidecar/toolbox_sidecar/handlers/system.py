"""system handlers (SPEC.md §4.6). Heavy imports are lazy."""

from __future__ import annotations

import sys
from importlib import metadata
from typing import Any

from ..registry import Context, handler

_PACKAGES = {
    "torch": "torch",
    "audio_separator": "audio-separator",
    "librosa": "librosa",
    "onnxruntime": "onnxruntime",
    "basic_pitch": "basic-pitch",
    "faster_whisper": "faster-whisper",
    "ctranslate2": "ctranslate2",
}


def package_versions() -> dict[str, str]:
    from .. import __version__

    # The engine's own version comes first; the Go setup step reads it.
    out: dict[str, str] = {"toolbox-sidecar": __version__}
    for key, dist in _PACKAGES.items():
        try:
            out[key] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            out[key] = "unknown"
    return out


def python_version() -> str:
    v = sys.version_info
    return f"{v.major}.{v.minor}.{v.micro}"


@handler("system.ping")
def system_ping(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    return {}


@handler("system.info")
def system_info(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    import onnxruntime
    import torch

    device = "cpu"
    try:
        if torch.backends.mps.is_available():
            device = "mps"
    except Exception:
        pass
    if device == "cpu" and "CoreMLExecutionProvider" in onnxruntime.get_available_providers():
        device = "coreml"
    return {"python": python_version(), "packages": package_versions(), "device": device}


@handler("system.warmup")
def system_warmup(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    import librosa
    import numpy as np

    sr = 22050
    y = np.zeros(sr, dtype=np.float32)
    y[:: sr // 2] = 1.0  # clicks at 2 Hz
    librosa.beat.beat_track(y=y, sr=sr)
    return {}
