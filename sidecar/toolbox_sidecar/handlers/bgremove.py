"""bgremove handler: background removal with onnxruntime (Phase 4 SPEC.md §4.2)."""

from __future__ import annotations

import os
import re
from typing import Any

import numpy as np

from ..download import ensure_model, validate_model_spec
from ..imageio import load_image, save_unique
from ..registry import Context, HandlerError, handler

KINDS = ("birefnet", "isnet")
OUTPUTS = ("transparent", "color", "mask")
MODEL_SIZE = 1024
_IMAGENET = ((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))
_NORMS = {"birefnet": _IMAGENET, "isnet": ((0.5, 0.5, 0.5), (1.0, 1.0, 1.0))}
_SUFFIX = {"transparent": "no background", "color": "on colour", "mask": "mask"}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

# One resident session: (model path, session).
_session: tuple[str, Any] | None = None


# -- pure functions ----------------------------------------------------------------


def preprocess(rgb: Any, kind: str, size: int = MODEL_SIZE) -> np.ndarray:
    """RGB PIL image -> float32 NCHW (1, 3, size, size), normalised per model kind."""
    from PIL import Image

    mean, std = _NORMS[kind]
    x = np.asarray(rgb.convert("RGB").resize((size, size), Image.BILINEAR), dtype=np.float32) / 255.0
    x = (x - np.array(mean, np.float32)) / np.array(std, np.float32)
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)


def mask_from_output(outputs: list[np.ndarray], kind: str, size: tuple[int, int]) -> Any:
    """Raw model outputs -> uint8 'L' mask resized (bicubic) to size=(w, h)."""
    from PIL import Image

    if kind == "isnet":
        p = np.asarray(outputs[0])[0, 0].astype(np.float32)
        p = (p - p.min()) / max(float(p.max() - p.min()), 1e-6)
    else:
        p = np.asarray(outputs[-1])[0, 0].astype(np.float32)
        p = 1.0 / (1.0 + np.exp(-p))
    m = Image.fromarray((np.clip(p, 0, 1) * 255 + 0.5).astype(np.uint8), "L")
    return m.resize(size, Image.BICUBIC)


def guided_filter(alpha: np.ndarray, guide_gray: np.ndarray, r: int = 8, eps: float = 1e-3) -> np.ndarray:
    """Guided-filter refinement of a uint8 alpha using a uint8 grey guide."""
    from scipy.ndimage import uniform_filter

    guide = guide_gray.astype(np.float32) / 255.0
    p = alpha.astype(np.float32) / 255.0
    k = 2 * r + 1
    mi, mp = uniform_filter(guide, k), uniform_filter(p, k)
    cov = uniform_filter(guide * p, k) - mi * mp
    var = uniform_filter(guide * guide, k) - mi * mi
    a = cov / (var + eps)
    b = mp - a * mi
    q = uniform_filter(a, k) * guide + uniform_filter(b, k)
    return (np.clip(q, 0, 1) * 255 + 0.5).astype(np.uint8)


def clean_edges(rgb: np.ndarray, alpha: np.ndarray, band: int = 6) -> np.ndarray:
    """Pixels with alpha < 250 within `band` px of an opaque (>= 250) pixel take the
    colour of the nearest opaque pixel (removes the old background's halo)."""
    from scipy.ndimage import distance_transform_edt

    solid = alpha >= 250
    if not solid.any() or solid.all():
        return rgb
    dist, idx = distance_transform_edt(~solid, return_distances=True, return_indices=True)
    fix = (~solid) & (dist <= band)
    out = rgb.copy()
    out[fix] = rgb[idx[0][fix], idx[1][fix]]
    return out


def crop_box(alpha: np.ndarray, padding: int) -> tuple[int, int, int, int] | None:
    """(left, top, right, bottom) of alpha > 8 expanded by padding and clamped, or None if empty."""
    ys, xs = np.nonzero(alpha > 8)
    if len(ys) == 0:
        return None
    h, w = alpha.shape
    return (
        max(0, int(xs.min()) - padding),
        max(0, int(ys.min()) - padding),
        min(w, int(xs.max()) + 1 + padding),
        min(h, int(ys.max()) + 1 + padding),
    )


def parse_hex(color: str) -> tuple[int, int, int]:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def compose(
    rgb: Any,
    mask: Any,
    output: str,
    color: str = "#ffffff",
    clean: bool = True,
    crop: bool = False,
    padding: int = 0,
) -> tuple[Any, bool]:
    """Builds the result image. Returns (image, found_subject). When crop is set and
    the mask is empty the image is left uncropped (found_subject False)."""
    from PIL import Image

    alpha = np.asarray(mask, dtype=np.uint8)
    box = crop_box(alpha, padding) if crop else None
    found = bool((alpha > 8).any())
    if output == "mask":
        out = Image.fromarray(alpha, "L")
    else:
        arr = np.asarray(rgb.convert("RGB"), dtype=np.uint8)
        if clean:
            arr = clean_edges(arr, alpha)
        rgba = Image.fromarray(np.dstack([arr, alpha]), "RGBA")
        if output == "color":
            base = Image.new("RGBA", rgba.size, parse_hex(color) + (255,))
            base.alpha_composite(rgba)
            out = base.convert("RGB")
        else:
            out = rgba
    if box is not None:
        out = out.crop(box)
    return out, found


# -- session -----------------------------------------------------------------------


def _get_session(path: str) -> Any:
    """CPU session with the low-memory flags; one model resident at a time."""
    global _session
    if _session is not None and _session[0] == path:
        return _session[1]
    _session = None  # free the previous model first
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.enable_cpu_mem_arena = False
    so.enable_mem_pattern = False
    so.log_severity_level = 3
    sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    _session = (path, sess)
    return sess


# -- handler -----------------------------------------------------------------------


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def _bool(params: dict[str, Any], key: str, default: bool) -> bool:
    v = params.get(key, default)
    if not isinstance(v, bool):
        raise HandlerError("validation", f"{key} must be a boolean")
    return v


@handler("bgremove.run")
def run(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = _str(params, "input")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    out_dir = os.path.abspath(_str(params, "outputDir"))
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"), KINDS)
    base = params.get("baseName") or os.path.splitext(os.path.basename(path))[0]
    if not isinstance(base, str) or not base.strip():
        raise HandlerError("validation", "baseName must be a string")
    output = params.get("output", "transparent")
    if output not in OUTPUTS:
        raise HandlerError("validation", "output must be transparent, color or mask")
    color = params.get("color", "#ffffff")
    if output == "color" and (not isinstance(color, str) or not _HEX.match(color)):
        raise HandlerError("validation", "color must be #rrggbb")
    crop = _bool(params, "crop", False)
    padding = params.get("padding", 0)
    if isinstance(padding, bool) or not isinstance(padding, int) or not 0 <= padding <= 500:
        raise HandlerError("validation", "padding must be an integer from 0 to 500")
    clean = _bool(params, "cleanEdges", True)
    refine = _bool(params, "refine", False)

    model_path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    ctx.check_cancelled()

    ctx.stage("Loading model")
    try:
        sess = _get_session(model_path)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the model: {e}", "Delete the model file to download it again") from e
    ctx.check_cancelled()

    img = load_image(path)
    rgb = img.convert("RGB")
    ctx.check_cancelled()

    ctx.stage("Removing background")
    x = preprocess(rgb, spec["kind"])
    ctx.check_cancelled()
    try:
        outs = sess.run(None, {sess.get_inputs()[0].name: x})
    except Exception as e:
        raise HandlerError("tool_failed", f"Background removal failed: {e}") from e
    ctx.check_cancelled()
    mask = mask_from_output(outs, spec["kind"], rgb.size)
    del outs, x
    if refine:
        from PIL import Image

        mask = Image.fromarray(guided_filter(np.asarray(mask), np.asarray(rgb.convert("L"))), "L")

    alpha = np.asarray(mask)
    coverage = float((alpha > 127).mean()) if alpha.size else 0.0
    if crop and not (alpha > 8).any():
        ctx.log("No subject found")
    result, _found = compose(rgb, mask, output, color, clean, crop, padding)
    ctx.check_cancelled()

    ctx.stage("Saving")
    saved = save_unique(result, out_dir, f"{base} ({_SUFFIX[output]})", "png", "PNG", optimize=False, compress_level=6)
    ctx.output(saved)
    return {
        "width": result.size[0],
        "height": result.size[1],
        "subjectCoverage": coverage,
        "model": spec["file"],
        "output": saved,
    }
