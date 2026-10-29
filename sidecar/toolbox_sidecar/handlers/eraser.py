"""Eraser handlers (SPEC.md §9.2): inpainting with LaMa (best) or MI-GAN (fast)."""

from __future__ import annotations

import os
from typing import Any

import numpy as np

from .. import eraser as eng
from ..download import ensure_model, validate_model_spec
from ..imageio import save_unique
from ..registry import Context, HandlerError, handler

MODELS = ("best", "fast")


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


@handler("eraser.inpaint")
def inpaint(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path, mask_path, out_dir = _str(params, "path"), _str(params, "mask"), _str(params, "out")
    model, model_path = _str(params, "model"), _str(params, "modelPath")
    if model not in MODELS:
        raise HandlerError("validation", "model must be best or fast")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    if not os.path.isfile(mask_path):
        raise HandlerError("validation", "Mask file not found")
    if not os.path.isfile(model_path):
        raise HandlerError("validation", "The erasing model isn't downloaded", "Download it from the Object Eraser tool")

    ctx.stage("Loading photo")
    im, icc, exif = eng.load_photo(path)
    w, h = im.size
    arr = np.asarray(im)
    alpha = arr[..., 3] if arr.shape[2] == 4 else None
    rgb = np.ascontiguousarray(arr[..., :3])
    ctx.check_cancelled()

    mask = eng.load_mask(mask_path, (w, h))
    if not mask.any():
        raise HandlerError("validation", "Paint over what to erase first")
    dilated = eng.dilate_mask(mask, eng.dilation_radius(w, h))
    warning = eng.WARNING_LARGE if float(dilated.mean()) > eng.LARGE_MASK_FRACTION else ""
    ctx.check_cancelled()

    ctx.stage("Loading model")
    try:
        run = eng.lama_runner(model_path) if model == "best" else eng.migan_runner(model_path)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the model: {e}", "Delete the model file to download it again") from e
    ctx.check_cancelled()

    ctx.stage("Erasing")
    try:
        if model == "best":
            result, regions = eng.inpaint_best(rgb, dilated, run, ctx)
        else:
            result, regions = eng.inpaint_fast(rgb, dilated, run, ctx)
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("tool_failed", f"Erasing failed: {e}") from e

    from PIL import Image

    if alpha is not None:
        result = np.dstack([result, alpha])
    out_im = Image.fromarray(result, "RGBA" if alpha is not None else "RGB")
    ext, fmt, kwargs = eng.output_format(path)
    if fmt == "JPEG" and out_im.mode == "RGBA":
        out_im = out_im.convert("RGB")
    if icc:
        kwargs["icc_profile"] = icc
    if exif:
        kwargs["exif"] = exif
    ctx.stage("Saving")
    base = os.path.splitext(os.path.basename(path))[0] + " (erased)"
    saved = save_unique(out_im, os.path.abspath(out_dir), base, ext.lstrip("."), fmt, **kwargs)
    return {"regions": regions, "warning": warning, "output": saved}


@handler("eraser.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads (sha256-verified) an eraser model without running it."""
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    return {"model": spec["file"], "path": path}
