"""Object Eraser engine: mask preparation, LaMa crop/paste-back and MI-GAN (SPEC.md §9.2).

Everything here is pure numpy/OpenCV so it can be tested with a stub model; the
handler in handlers/eraser.py wires in onnxruntime sessions.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

import numpy as np

from .imageio import register_heif
from .registry import Context, HandlerError

LAMA_SIZE = 512
FEATHER_SIGMA = 3.0  # px at crop scale (512)
LARGE_MASK_FRACTION = 0.35
WARNING_LARGE = "Large areas may look smeared"

Box = tuple[int, int, int, int]  # x, y, w, h
LamaRunner = Callable[[np.ndarray, np.ndarray], np.ndarray]  # (image f32 NCHW 0..1, mask f32 N1HW) -> f32 NCHW 0..255
MiganRunner = Callable[[np.ndarray, np.ndarray], np.ndarray]  # (image u8 NCHW, mask u8 N1HW 255=keep) -> u8 NCHW

# -- loading and saving ------------------------------------------------------------


def load_photo(path: str) -> tuple[Any, bytes | None, bytes | None]:
    """Opens path (incl. HEIC), applies EXIF orientation and returns (RGB or RGBA image,
    ICC profile bytes, EXIF bytes without the orientation tag). The pixels stay in
    their own colour space so the profile can be written back unchanged."""
    from PIL import Image, ImageOps

    try:
        register_heif()
        with Image.open(path) as opened:
            opened.load()
            im = ImageOps.exif_transpose(opened) or opened
            im.load()
            icc = opened.info.get("icc_profile") or im.info.get("icc_profile")
            exif = im.getexif()
        has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if has_alpha else "RGB")
        exif_bytes = None
        if exif:
            exif.pop(0x0112, None)
            if len(exif):
                exif_bytes = exif.tobytes()
        return im, icc, exif_bytes
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("validation", "Couldn't read this image", str(e)) from e


def output_format(path: str) -> tuple[str, str, dict[str, Any]]:
    """(extension, Pillow format, save kwargs) keeping the input's format: JPEG q95, PNG,
    WebP q95; TIFF/BMP -> PNG; HEIC -> JPEG."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".jpg", ".jpeg"):
        return ext, "JPEG", {"quality": 95, "subsampling": 0}
    if ext == ".webp":
        return ".webp", "WEBP", {"quality": 95}
    if ext in (".heic", ".heif"):
        return ".jpg", "JPEG", {"quality": 95, "subsampling": 0}
    return ".png", "PNG", {"compress_level": 6}


# -- mask preparation --------------------------------------------------------------


def load_mask(path: str, size: tuple[int, int]) -> np.ndarray:
    """Mask file -> bool (H, W): resized nearest to size=(w, h) and thresholded > 127.
    Transparent pixels count as not painted."""
    from PIL import Image

    try:
        with Image.open(path) as m:
            m.load()
            alpha = np.asarray(m.getchannel("A")) if m.mode in ("RGBA", "LA", "PA") else None
            lum = np.asarray(m.convert("RGBA" if alpha is not None else "L").convert("L"))
    except Exception as e:
        raise HandlerError("validation", "Couldn't read the mask", str(e)) from e
    if alpha is not None:
        lum = (lum.astype(np.uint16) * alpha // 255).astype(np.uint8)
    img = Image.fromarray(lum, "L")
    if img.size != size:
        img = img.resize(size, Image.NEAREST)
    return np.asarray(img) > 127


def dilation_radius(w: int, h: int) -> int:
    return min(40, max(8, round(12 * max(w, h) / 1024)))


def dilate_mask(mask: np.ndarray, radius: int) -> np.ndarray:
    """Dilates a bool mask with an elliptical kernel of the given radius (works on a
    window around the painted area, which is much faster on large photos)."""
    import cv2

    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return mask.copy()
    h, w = mask.shape
    y0, y1 = max(0, int(ys.min()) - radius), min(h, int(ys.max()) + 1 + radius)
    x0, x1 = max(0, int(xs.min()) - radius), min(w, int(xs.max()) + 1 + radius)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    out = np.zeros_like(mask)
    out[y0:y1, x0:x1] = cv2.dilate(mask[y0:y1, x0:x1].astype(np.uint8), kernel) > 0
    return out


def find_regions(mask: np.ndarray) -> list[Box]:
    """Bounding boxes (x, y, w, h) of the connected regions, sorted top-to-bottom, left-to-right."""
    import cv2

    n, _labels, stats, _c = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    boxes = [
        (int(s[cv2.CC_STAT_LEFT]), int(s[cv2.CC_STAT_TOP]), int(s[cv2.CC_STAT_WIDTH]), int(s[cv2.CC_STAT_HEIGHT]))
        for s in stats[1:n]
    ]
    return sorted(boxes, key=lambda b: (b[1], b[0]))


# -- crop geometry -----------------------------------------------------------------


def crop_square(box: Box, width: int, height: int) -> tuple[int, int, int]:
    """(x0, y0, side) of the square crop for a region. side = max(512, 2 × the longer
    bbox side), capped at the image's long side; centred on the bbox and shifted inside
    the image. On an axis shorter than the side the image is centred in the crop (the
    rest is filled by reflection when extracting)."""
    x, y, w, h = box
    side = min(max(LAMA_SIZE, 2 * max(w, h)), max(width, height))

    def axis(centre: float, dim: int) -> int:
        if side >= dim:
            return -((side - dim) // 2)
        return min(max(int(round(centre - side / 2)), 0), dim - side)

    return axis(x + w / 2, width), axis(y + h / 2, height), side


def _overlap(a: tuple[int, int, int], b: tuple[int, int, int]) -> bool:
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[2] and b[1] < a[1] + a[2]


def merge_regions(boxes: list[Box], width: int, height: int) -> list[Box]:
    """Merges regions whose crops overlap (repeatedly) so each pixel is filled once."""
    boxes = list(boxes)
    changed = True
    while changed and len(boxes) > 1:
        changed = False
        crops = [crop_square(b, width, height) for b in boxes]
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                if _overlap(crops[i], crops[j]):
                    a, b = boxes[i], boxes[j]
                    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
                    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
                    boxes[i] = (x0, y0, x1 - x0, y1 - y0)
                    del boxes[j]
                    changed = True
                    break
            if changed:
                break
    return sorted(boxes, key=lambda b: (b[1], b[0]))


def extract_crop(arr: np.ndarray, x0: int, y0: int, side: int, *, fill: bool) -> np.ndarray:
    """The side×side window at (x0, y0); parts outside the image are reflected
    (fill=False) or zero (fill=True, for masks)."""
    h, w = arr.shape[:2]
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x0 + side, w), min(y0 + side, h)
    sub = arr[sy0:sy1, sx0:sx1]
    pad = [(sy0 - y0, y0 + side - sy1), (sx0 - x0, x0 + side - sx1)] + [(0, 0)] * (arr.ndim - 2)
    if not any(p != (0, 0) for p in pad):
        return sub
    if fill:
        return np.pad(sub, pad, mode="constant")
    mode = "reflect" if sub.shape[0] > 1 and sub.shape[1] > 1 else "edge"
    return np.pad(sub, pad, mode=mode)


def feather(mask: np.ndarray, sigma: float) -> np.ndarray:
    """float32 alpha: the mask blurred by a Gaussian, zero wherever the mask is."""
    import cv2

    m = mask.astype(np.float32)
    return cv2.GaussianBlur(m, (0, 0), sigmaX=sigma, borderType=cv2.BORDER_REPLICATE) * m


def blend(orig: np.ndarray, new: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """uint8 result of orig*(1-alpha)+new*alpha; pixels with alpha 0 are untouched."""
    mixed = orig.astype(np.float32) * (1 - alpha[..., None]) + new.astype(np.float32) * alpha[..., None]
    out = np.clip(mixed + 0.5, 0, 255).astype(np.uint8)
    return np.where(alpha[..., None] > 0, out, orig)


# -- inpainting --------------------------------------------------------------------


def inpaint_region(img: np.ndarray, mask: np.ndarray, box: Box, run: LamaRunner) -> None:
    """Fills the dilated mask inside box's crop, in place on img (uint8 HxWx3)."""
    import cv2

    h, w = mask.shape
    x0, y0, side = crop_square(box, w, h)
    crop = extract_crop(img, x0, y0, side, fill=False)
    mcrop = extract_crop(mask.astype(np.uint8), x0, y0, side, fill=True)
    if side != LAMA_SIZE:
        small = cv2.resize(crop, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_AREA)
        msmall = cv2.resize(mcrop, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_NEAREST)
    else:
        small, msmall = crop, mcrop
    x = small.astype(np.float32) / 255.0 * (1 - msmall[..., None].astype(np.float32))
    xin = np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)
    min_ = np.ascontiguousarray(msmall[None, None].astype(np.float32))
    out = run(xin, min_)
    res = np.clip(np.asarray(out)[0].transpose(1, 2, 0) + 0.5, 0, 255).astype(np.uint8)
    if side != LAMA_SIZE:
        res = cv2.resize(res, (side, side), interpolation=cv2.INTER_LANCZOS4)
    alpha = feather(mcrop > 0, FEATHER_SIGMA * side / LAMA_SIZE)
    merged = blend(crop, res, alpha)
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x0 + side, w), min(y0 + side, h)
    img[sy0:sy1, sx0:sx1] = merged[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0]


def inpaint_best(
    img: np.ndarray, mask: np.ndarray, run: LamaRunner, ctx: Context | None = None
) -> tuple[np.ndarray, int]:
    """LaMa over every merged region, sequentially on the updated image. Returns (image, regions)."""
    h, w = mask.shape
    boxes = merge_regions(find_regions(mask), w, h)
    out = img.copy()
    for i, box in enumerate(boxes):
        if ctx is not None:
            ctx.check_cancelled()
            ctx.progress(i / len(boxes), f"Erasing area {i + 1} of {len(boxes)}", force=True)
        inpaint_region(out, mask, box, run)
    if ctx is not None:
        ctx.check_cancelled()
    return out, len(boxes)


def inpaint_fast(
    img: np.ndarray, mask: np.ndarray, run: MiganRunner, ctx: Context | None = None
) -> tuple[np.ndarray, int]:
    """MI-GAN pipeline on the whole image, composited with the same feather."""
    h, w = mask.shape
    regions = len(find_regions(mask))
    if ctx is not None:
        ctx.check_cancelled()
    xin = np.ascontiguousarray(img.transpose(2, 0, 1)[None])
    keep = np.where(mask, 0, 255).astype(np.uint8)[None, None]
    res = np.asarray(run(xin, np.ascontiguousarray(keep)))[0].transpose(1, 2, 0)
    if ctx is not None:
        ctx.check_cancelled()
    sigma = FEATHER_SIGMA * max(w, h) / 1024
    return blend(img, np.ascontiguousarray(res), feather(mask, max(1.0, sigma))), regions


# -- onnxruntime -------------------------------------------------------------------

_sessions: dict[str, Any] = {}


def get_session(path: str) -> Any:
    """One cached CPU session per model path."""
    sess = _sessions.get(path)
    if sess is None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.log_severity_level = 3
        sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        _sessions[path] = sess
    return sess


def lama_runner(path: str) -> LamaRunner:
    sess = get_session(path)
    return lambda image, mask: sess.run(None, {"image": image, "mask": mask})[0]


def migan_runner(path: str) -> MiganRunner:
    sess = get_session(path)
    return lambda image, mask: sess.run(None, {"image": image, "mask": mask})[0]
