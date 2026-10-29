"""Hiding boxes: blur, pixelate, solid (SPEC.md §8.2), and saving the result.

Works on uint8 ``(H, W, C)`` arrays (C >= 3, any channel order; only the first
three channels are touched). Nothing outside a padded box is ever written.
"""

from __future__ import annotations

import math
import os
from typing import Any

import numpy as np

STYLES = ("blur", "pixelate", "solid")
FEATHER_SIGMA = 2.0  # ~4 px soft edge on face ellipses

#: (x1, y1, x2, y2) integer pixel rectangle and whether it is hidden through an ellipse.
Region = tuple[int, int, int, int, bool]


def region_for(box: dict[str, Any], kind: str, padding_pct: float, width: int, height: int) -> Region | None:
    """A 0..1 box grown by padding_pct of its size on every side, as a clipped pixel rect.

    Faces use an ellipse; plates and manual boxes are rectangles.
    """
    p = padding_pct / 100.0
    x, y, w, h = float(box["x"]), float(box["y"]), float(box["w"]), float(box["h"])
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
        return None
    x0, y0 = (x - w * p) * width, (y - h * p) * height
    x1, y1 = (x + w + w * p) * width, (y + h + h * p) * height
    ix0, iy0 = max(0, math.floor(x0 + 1e-6)), max(0, math.floor(y0 + 1e-6))
    ix1, iy1 = min(width, math.ceil(x1 - 1e-6)), min(height, math.ceil(y1 - 1e-6))
    if ix1 - ix0 < 1 or iy1 - iy0 < 1:
        return None
    return (ix0, iy0, ix1, iy1, kind == "face")


def blur_sigma(strength: int, short_side: float) -> float:
    return (0.04 + 0.016 * strength) * short_side


def pixel_block(strength: int, short_side: float) -> int:
    return max(2, round(short_side / (16 - strength)))


def _effect(roi: np.ndarray, style: str, strength: int) -> np.ndarray:
    import cv2

    h, w = roi.shape[:2]
    short = float(min(h, w))
    if style == "solid":
        return np.zeros_like(roi)
    if style == "pixelate":
        bs = pixel_block(strength, short)
        small = cv2.resize(roi, (max(1, math.ceil(w / bs)), max(1, math.ceil(h / bs))), interpolation=cv2.INTER_AREA)
        if small.ndim == 2:
            small = small[..., None]
        out = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
        return out.reshape(roi.shape)
    sigma = max(0.8, blur_sigma(strength, short))
    # A big Gaussian is slow at full size and needs no detail anyway: blur a
    # reduced copy (sigma ~4 px there) and scale it back up.
    k = max(1, int(sigma / 4))
    src = roi if k == 1 else cv2.resize(roi, (max(1, w // k), max(1, h // k)), interpolation=cv2.INTER_AREA)
    s = sigma / k
    out = cv2.GaussianBlur(src, (0, 0), s, borderType=cv2.BORDER_REPLICATE)
    out = cv2.GaussianBlur(out, (0, 0), s, borderType=cv2.BORDER_REPLICATE)  # twice: not reversible
    if k > 1:
        out = cv2.resize(out, (w, h), interpolation=cv2.INTER_LINEAR)
    return out.reshape(roi.shape)


def _ellipse_mask(h: int, w: int) -> np.ndarray:
    import cv2

    m = np.zeros((h, w), np.uint8)
    cv2.ellipse(m, (w // 2, h // 2), (max(1, w // 2), max(1, h // 2)), 0, 0, 360, 255, -1)
    m = cv2.GaussianBlur(m, (0, 0), FEATHER_SIGMA)
    return m.astype(np.float32) / 255.0


def apply_regions(arr: np.ndarray, regions: list[Region], style: str, strength: int) -> np.ndarray:
    """Hides every region in arr in place and returns it. Pixels outside the regions are untouched."""
    for x0, y0, x1, y1, ellipse in regions:
        roi = arr[y0:y1, x0:x1, :3]
        fx = _effect(np.ascontiguousarray(roi), style, strength)
        if ellipse:
            m = _ellipse_mask(y1 - y0, x1 - x0)[..., None]
            mixed = roi.astype(np.float32) * (1 - m) + fx.astype(np.float32) * m
            arr[y0:y1, x0:x1, :3] = (mixed + 0.5).astype(np.uint8)
        else:
            arr[y0:y1, x0:x1, :3] = fx
    return arr


# -- images -------------------------------------------------------------------------

_OUT_FORMATS = {
    ".jpg": ("JPEG", {"quality": 95}),
    ".jpeg": ("JPEG", {"quality": 95}),
    ".png": ("PNG", {"optimize": False, "compress_level": 6}),
    ".webp": ("WEBP", {"quality": 95}),
    ".bmp": ("BMP", {}),
    ".tif": ("TIFF", {"compression": "tiff_deflate"}),
    ".tiff": ("TIFF", {"compression": "tiff_deflate"}),
}


def output_extension(path: str) -> str:
    """The extension the redacted copy is written with: TIFF -> png, HEIC -> jpg, else the same."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".tif", ".tiff"):
        return ".png"
    if ext in (".heic", ".heif"):
        return ".jpg"
    return ".jpg" if ext == ".jpeg" else ext


def load_for_apply(path: str) -> tuple[Any, bytes | None, Any]:
    """Opens an image upright, in its own colour space. Returns (RGB/RGBA image, icc profile, exif)."""
    from PIL import Image, ImageOps

    from ..imageio import register_heif
    from ..registry import HandlerError

    try:
        register_heif()
        with Image.open(path) as opened:
            opened.load()
            icc = opened.info.get("icc_profile")
            mode = opened.mode
            im = ImageOps.exif_transpose(opened) or opened.copy()
            im.load()
        exif = im.getexif()
        has_alpha = mode in ("RGBA", "LA", "PA") or (mode == "P" and "transparency" in im.info)
        if mode == "CMYK":
            icc = None  # converted to RGB without the profile
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if has_alpha else "RGB")
        return im, icc, exif
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("validation", "Couldn't read this image", str(e)) from e


def save_image(im: Any, out: str, icc: bytes | None, exif: Any, strip: bool) -> None:
    """Writes im to out in the format its extension names (via <out>.part, then rename).

    strip: no EXIF/XMP/IPTC at all (the ICC profile stays). Otherwise EXIF is
    kept minus the GPS block.
    """
    ext = os.path.splitext(out)[1].lower()
    fmt, kwargs = _OUT_FORMATS.get(ext, ("PNG", {}))
    kwargs = dict(kwargs)
    if fmt in ("JPEG", "BMP") and im.mode == "RGBA":
        im = im.convert("RGB")
    if icc and fmt != "BMP":
        kwargs["icc_profile"] = icc
    if not strip and exif and fmt in ("JPEG", "PNG", "WEBP", "TIFF"):
        exif = _without_gps(exif)
        if len(exif):
            kwargs["exif"] = exif.tobytes()
    part = out + ".part"
    try:
        with open(part, "wb") as f:
            im.save(f, format=fmt, **kwargs)
        os.replace(part, out)
    except BaseException:
        try:
            os.remove(part)
        except OSError:
            pass
        raise


def _without_gps(exif: Any) -> Any:
    """A copy of exif without the GPS block, the orientation (pixels are upright) and MakerNote."""
    from PIL import Image

    clean = Image.Exif()
    clean.load(exif.tobytes())
    for tag in (0x8825, 0x0112):
        if tag in clean:
            del clean[tag]
    try:
        clean.get_ifd(0x8769).pop(0x927C, None)
    except Exception:
        pass
    return clean
