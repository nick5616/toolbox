"""Redact handlers (SPEC.md §8.2): find faces and number plates, hide them.

The run handlers never download: Go passes explicit model paths
(``faceModel`` / ``plateModel``); ``redact.prefetch`` is the only download.
"""

from __future__ import annotations

import os
from typing import Any

import numpy as np

from ..download import ensure_model, validate_model_spec
from ..imageio import load_image
from ..redact import THRESHOLDS, detect, render, video
from ..registry import Context, HandlerError, handler

SENSITIVITIES = tuple(THRESHOLDS)
MAX_BOXES = 2000


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def _file(params: dict[str, Any], key: str, what: str) -> str:
    p = _str(params, key)
    if not os.path.isfile(p):
        raise HandlerError("validation", f"{what} not found", p)
    return p


def _bool(params: dict[str, Any], key: str, default: bool) -> bool:
    v = params.get(key, default)
    if not isinstance(v, bool):
        raise HandlerError("validation", f"{key} must be a boolean")
    return v


def _int(params: dict[str, Any], key: str, lo: int, hi: int, default: int) -> int:
    v = params.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise HandlerError("validation", f"{key} must be a whole number from {lo} to {hi}")
    return v


def _detect_params(params: dict[str, Any]) -> tuple[bool, bool, str, str | None, str | None]:
    faces, plates = _bool(params, "faces", True), _bool(params, "plates", True)
    if not faces and not plates:
        raise HandlerError("validation", "Choose faces, number plates or both")
    sens = params.get("sensitivity", "normal")
    if sens not in SENSITIVITIES:
        raise HandlerError("validation", "sensitivity must be normal or high")
    face_model = _file(params, "faceModel", "The face model") if faces else None
    plate_model = _file(params, "plateModel", "The number-plate model") if plates else None
    return faces, plates, sens, face_model, plate_model


def _render_params(params: dict[str, Any]) -> tuple[str, int, int, bool]:
    style = params.get("style", "blur")
    if style not in render.STYLES:
        raise HandlerError("validation", "style must be blur, pixelate or solid")
    return (
        style,
        _int(params, "strength", 1, 10, 6),
        _int(params, "padding", 0, 50, 15),
        _bool(params, "stripMetadata", True),
    )


def _box(b: Any) -> dict[str, Any]:
    if not isinstance(b, dict):
        raise HandlerError("validation", "Each box must be an object")
    for k in ("x", "y", "w", "h"):
        v = b.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise HandlerError("validation", f"box.{k} must be a number")
    if b["w"] <= 0 or b["h"] <= 0:
        raise HandlerError("validation", "Boxes need a positive size")
    return b


# -- detect ---------------------------------------------------------------------------


@handler("redact.detect_image")
def detect_image(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = _file(params, "path", "The image")
    faces, plates, sens, face_model, plate_model = _detect_params(params)
    ctx.stage("Loading image")
    rgb = np.asarray(load_image(path).convert("RGB"))
    ctx.check_cancelled()
    ctx.stage("Finding faces and plates")
    boxes = detect.detect_image_array(
        rgb, faces=faces, plates=plates, sensitivity=sens, face_model=face_model, plate_model=plate_model,
        check=ctx.check_cancelled,
    )
    h, w = rgb.shape[:2]
    return {"width": w, "height": h, "boxes": boxes}


@handler("redact.detect_video")
def detect_video(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = _file(params, "path", "The video")
    ffmpeg = _str(params, "ffmpeg")
    faces, plates, sens, face_model, plate_model = _detect_params(params)
    cache = os.path.abspath(_str(params, "cachePath"))
    return video.detect_video(
        ctx, ffmpeg=ffmpeg, path=path, faces=faces, plates=plates, sensitivity=sens,
        face_model=face_model, plate_model=plate_model, cache_path=cache,
    )


# -- apply ----------------------------------------------------------------------------


@handler("redact.apply_image")
def apply_image(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = _file(params, "path", "The image")
    out = os.path.abspath(_str(params, "out"))
    style, strength, padding, strip = _render_params(params)
    raw = params.get("boxes", [])
    if not isinstance(raw, list) or len(raw) > MAX_BOXES:
        raise HandlerError("validation", "boxes must be a list")
    boxes = [_box(b) for b in raw if isinstance(b, dict) and b.get("enabled", True)]
    if os.path.exists(out):
        raise HandlerError("validation", "The output file already exists", out)
    if os.path.abspath(path) == out:
        raise HandlerError("validation", "The output must be a different file")
    ctx.stage("Loading image")
    im, icc, exif = render.load_for_apply(path)
    ctx.check_cancelled()
    w, h = im.size
    regions = [r for b in boxes if (r := render.region_for(b, str(b.get("kind", "manual")), padding, w, h))]
    ctx.stage("Hiding faces and plates")
    arr = np.array(im)  # writable copy
    render.apply_regions(arr, regions, style, strength)
    from PIL import Image

    result = Image.fromarray(arr, im.mode)
    ctx.check_cancelled()
    ctx.stage("Saving")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    render.save_image(result, out, icc, exif, strip)
    ctx.output(out)
    return {"out": out, "width": w, "height": h, "applied": len(regions)}


@handler("redact.apply_video")
def apply_video(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = _file(params, "path", "The video")
    ffmpeg = _str(params, "ffmpeg")
    out = os.path.abspath(_str(params, "out"))
    det = _file(params, "detectionsPath", "The detections file")
    style, strength, padding, strip = _render_params(params)
    disabled = params.get("disabledTracks") or []
    if not isinstance(disabled, list) or not all(isinstance(x, str) for x in disabled):
        raise HandlerError("validation", "disabledTracks must be a list of track IDs")
    manual_raw = params.get("manualBoxes") or []
    if not isinstance(manual_raw, list) or len(manual_raw) > MAX_BOXES:
        raise HandlerError("validation", "manualBoxes must be a list")
    manual = []
    for m in manual_raw:
        _box(m)
        for k in ("startMs", "endMs"):
            if isinstance(m.get(k), bool) or not isinstance(m.get(k), (int, float)):
                raise HandlerError("validation", f"manual box {k} must be a number")
        manual.append(m)
    if os.path.exists(out):
        raise HandlerError("validation", "The output file already exists", out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    res = video.apply_video(
        ctx, ffmpeg=ffmpeg, path=path, out=out, detections_path=det, disabled=set(disabled), manual=manual,
        style=style, strength=strength, padding=padding, strip=strip,
    )
    ctx.output(out)
    return res


@handler("redact.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads (sha256-verified) one model without running it."""
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    return {"model": spec["file"], "path": path}
