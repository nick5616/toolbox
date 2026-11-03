"""People mattes with Robust Video Matting (ONNX, recurrent, CPU) -- SPEC 10.3 ``matte.people``."""

from __future__ import annotations

import os
from typing import Any

import numpy as np

from ..registry import Context, HandlerError
from .frames import Encoder, FrameReader, StreamIndex

# One resident session: (model path, session). Freed when a SAM model loads (see resident.py).
_session: tuple[str, Any] | None = None


def downsample_ratio(width: int, height: int) -> float:
    """clamp(480 / long side, 0.125, 1) -- RVM's internal resolution."""
    return float(min(max(480.0 / max(width, height), 0.125), 1.0))


def drop_session() -> None:
    global _session
    _session = None


def get_session(path: str) -> Any:
    global _session
    if _session is not None and _session[0] == path:
        return _session[1]
    _session = None
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    _session = (path, sess)
    return sess


def to_input(frame: np.ndarray) -> np.ndarray:
    """(h, w, 3) uint8 RGB -> float32 (1, 3, h, w) in 0..1."""
    x = frame.astype(np.float32) * (1.0 / 255.0)
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None])


def to_alpha(pha: np.ndarray) -> np.ndarray:
    """(1, 1, h, w) float 0..1 -> (h, w) uint8 0..255."""
    return (np.clip(pha[0, 0], 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def run_people(
    ctx: Context,
    *,
    ffmpeg: str,
    stream: str,
    index: StreamIndex,
    from_frame: int,
    to_frame: int,
    fps: float,
    width: int,
    height: int,
    out_path: str,
    model_path: str,
) -> dict[str, Any]:
    from . import resident

    resident.before_rvm()
    n = to_frame - from_frame
    ctx.stage("Loading the people model")
    try:
        sess = get_session(model_path)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the model: {e}", "Remove the model in Settings and install it again") from e
    ctx.check_cancelled()
    ratio = np.array([downsample_ratio(width, height)], np.float32)
    zero = np.zeros((1, 1, 1, 1), np.float32)
    rec = [zero, zero, zero, zero]
    part = out_path + ".part"
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    enc = Encoder(ffmpeg, width, height, fps, part)
    ok = False
    try:
        with FrameReader(ffmpeg, stream, index, from_frame, to_frame, fps, width, height) as reader:
            ctx.stage("Cutting out people")
            for j, frame in enumerate(reader):
                ctx.check_cancelled()
                feed = {"src": to_input(frame), "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio}
                try:
                    pha, *rec = sess.run(["pha", "r1o", "r2o", "r3o", "r4o"], feed)
                except Exception as e:
                    raise HandlerError("tool_failed", f"The people model failed: {e}") from e
                enc.write(to_alpha(pha))
                ctx.progress((j + 1) / n, f"Frame {j + 1} of {n}")
        enc.finish()
        ctx.check_cancelled()
        os.replace(part, out_path)
        ok = True
    finally:
        if ok:
            enc.close()
        else:
            enc.abort()
    return {"frames": n, "outPath": out_path, "width": width, "height": height}
