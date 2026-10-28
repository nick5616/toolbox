"""upscale handler: tiled Real-ESRGAN inference on the CPU/MPS via spandrel (Phase 4 SPEC.md §13.3)."""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

import numpy as np

from ..download import ensure_model, validate_model_spec
from ..imageio import load_image
from ..registry import Context, HandlerError, handler

TILE = 256
OVERLAP = 16
FORMATS = ("png", "jpg", "webp")

# One resident model: (path, device, model).
_loaded: tuple[str, str, Any] | None = None


def pick_device() -> str:
    import torch

    mps = getattr(torch.backends, "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


def _load_model(path: str, device: str) -> Any:
    global _loaded
    if _loaded is not None and _loaded[0] == path and _loaded[1] == device:
        return _loaded[2]
    _loaded = None
    import spandrel

    model = spandrel.ModelLoader().load_from_file(path).eval().to(device)
    _loaded = (path, device, model)
    return model


def upscale_array(
    infer: Callable[[Any], Any],
    arr: np.ndarray,
    scale: int,
    *,
    tile: int = TILE,
    overlap: int = OVERLAP,
    device: str = "cpu",
    ctx: Context | None = None,
) -> np.ndarray:
    """Upscales an HxWx3 uint8 array by `scale` in `tile` px tiles. Each tile is run with
    `overlap` px of context on every side (clamped at the image edge) and only its core
    is kept, so tile seams don't show. `infer` maps an NCHW float tensor in [0,1] to the
    scaled NCHW tensor."""
    import torch

    h, w, _ = arr.shape
    out = np.zeros((h * scale, w * scale, 3), np.uint8)
    ny, nx = -(-h // tile), -(-w // tile)
    done = 0
    for ty in range(ny):
        for tx in range(nx):
            if ctx is not None:
                ctx.check_cancelled()
            y0, x0 = ty * tile, tx * tile
            y1, x1 = min(y0 + tile, h), min(x0 + tile, w)
            py0, px0 = max(0, y0 - overlap), max(0, x0 - overlap)
            py1, px1 = min(h, y1 + overlap), min(w, x1 + overlap)
            patch = arr[py0:py1, px0:px1].astype(np.float32) / 255.0
            t = torch.from_numpy(np.ascontiguousarray(patch.transpose(2, 0, 1)[None])).to(device)
            with torch.inference_mode():
                y = infer(t)
            y = y[0].clamp(0, 1).mul(255).round().to(torch.uint8).permute(1, 2, 0).cpu().numpy()
            oy, ox = (y0 - py0) * scale, (x0 - px0) * scale
            core = y[oy : oy + (y1 - y0) * scale, ox : ox + (x1 - x0) * scale]
            out[y0 * scale : y1 * scale, x0 * scale : x1 * scale] = core
            done += 1
            if ctx is not None:
                ctx.progress(done / (ny * nx), f"Upscaling · tile {done} / {ny * nx}")
    return out


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def save_result(img: Any, out_path: str, fmt: str) -> None:
    """Writes img to out_path via a .part file (PNG, JPEG q90 or WebP q90)."""
    from PIL import Image

    tmp = out_path + ".part"
    try:
        with open(tmp, "wb") as f:
            if fmt == "png":
                img.save(f, format="PNG")
            elif fmt == "jpg":
                if img.mode == "RGBA":
                    flat = Image.new("RGB", img.size, (255, 255, 255))
                    flat.paste(img, mask=img.getchannel("A"))
                    img = flat
                img.save(f, format="JPEG", quality=90)
            else:
                img.save(f, format="WEBP", quality=90)
        os.replace(tmp, out_path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


@handler("upscale.run")
def run(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    from PIL import Image

    src = _str(params, "input")
    if not os.path.isfile(src):
        raise HandlerError("validation", "Input file not found", src)
    out_path = os.path.abspath(_str(params, "output"))
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    scale = params.get("scale")
    if isinstance(scale, bool) or scale not in (2, 4):
        raise HandlerError("validation", "scale must be 2 or 4")
    fmt = params.get("format", "png")
    if fmt not in FORMATS:
        raise HandlerError("validation", "format must be png, jpg or webp")

    model_path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    ctx.check_cancelled()

    ctx.stage("Loading model")
    device = pick_device()
    try:
        model = _load_model(model_path, device)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the model: {e}", "Delete the model file to download it again") from e
    ctx.check_cancelled()

    img = load_image(src)
    in_w, in_h = img.size
    alpha = img.getchannel("A") if img.mode == "RGBA" else None
    rgb = np.asarray(img.convert("RGB"), dtype=np.uint8)

    ctx.stage("Upscaling")
    model_scale = int(getattr(model, "scale", 4))
    try:
        res = upscale_array(model, rgb, model_scale, device=device, ctx=ctx)
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("tool_failed", f"Upscaling failed: {e}", "Try a smaller image") from e
    out = Image.fromarray(res, "RGB")
    out_w, out_h = in_w * scale, in_h * scale
    if out.size != (out_w, out_h):
        out = out.resize((out_w, out_h), Image.LANCZOS)  # 2x = Lanczos downscale of the 4x result
    if alpha is not None:
        out.putalpha(alpha.resize((out_w, out_h), Image.LANCZOS))
    ctx.check_cancelled()

    ctx.stage("Saving")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    save_result(out, out_path, fmt)
    ctx.output(out_path)
    return {"inWidth": in_w, "inHeight": in_h, "outWidth": out_w, "outHeight": out_h, "device": device}
