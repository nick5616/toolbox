"""Shared image loading/saving for the image handlers (Phase 4 SPEC.md §13.1)."""

from __future__ import annotations

import io
import os
from typing import Any

from .registry import HandlerError

_heif_registered = False

_ALPHA_MODES = ("RGBA", "LA", "PA")


def register_heif() -> None:
    """Registers the HEIF/HEIC opener with Pillow, once."""
    global _heif_registered
    if _heif_registered:
        return
    import pillow_heif

    pillow_heif.register_heif_opener()
    _heif_registered = True


def _to_srgb(im: Any) -> Any:
    """Converts an embedded ICC profile to sRGB (RGB/RGBA); other modes pass through."""
    from PIL import ImageCms

    icc = im.info.get("icc_profile")
    if not icc or im.mode not in ("RGB", "RGBA", "CMYK"):
        return im
    try:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        out_mode = "RGBA" if im.mode == "RGBA" else "RGB"
        return ImageCms.profileToProfile(im, src, ImageCms.createProfile("sRGB"), outputMode=out_mode)
    except Exception:  # a broken profile must not make the image unreadable
        return im


def load_image(path: str) -> Any:
    """Opens path (incl. HEIC/HEIF), applies EXIF orientation, converts an
    embedded ICC profile to sRGB, and returns a PIL image in RGB (or RGBA
    when the image has alpha). Raises HandlerError("validation",
    "Couldn't read this image") on failure."""
    from PIL import Image, ImageOps

    try:
        register_heif()
        with Image.open(path) as opened:
            opened.load()
            im = ImageOps.exif_transpose(opened) or opened
            im.load()
            info = dict(opened.info)
            im.info.update({k: v for k, v in info.items() if k not in im.info})
        has_alpha = im.mode in _ALPHA_MODES or (im.mode == "P" and "transparency" in im.info)
        if im.mode in ("P", "LA", "PA", "L", "1", "I", "I;16", "F"):
            im = im.convert("RGBA" if has_alpha else "RGB")
        im = _to_srgb(im)
        return im.convert("RGBA" if has_alpha else "RGB")
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("validation", "Couldn't read this image", str(e)) from e


def unique_path(directory: str, base: str, ext: str) -> str:
    """<dir>/<base>.<ext>, or "<base> (1).<ext>", (2)… if taken. Never overwrites."""
    path = os.path.join(directory, f"{base}.{ext}")
    n = 0
    while os.path.exists(path):
        n += 1
        path = os.path.join(directory, f"{base} ({n}).{ext}")
    return path


def save_unique(im: Any, directory: str, base: str, ext: str, fmt: str, **save_kwargs: Any) -> str:
    """Saves im to a fresh unique path (exclusive create, so it never overwrites
    even when racing) and returns the path."""
    os.makedirs(directory, exist_ok=True)
    while True:
        path = unique_path(directory, base, ext)
        try:
            f = open(path, "xb")
        except FileExistsError:
            continue
        try:
            with f:
                im.save(f, format=fmt, **save_kwargs)
        except BaseException:
            try:
                os.remove(path)
            except OSError:
                pass
            raise
        return path
