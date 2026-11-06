"""Paint+ Lab perception tools (Phase 19 SPEC.md §2.5).

Handlers never download: the Go side (modules/paint/ai.go) resolves the models
and passes explicit paths. They work on small PNG crops in a per-job directory.

paint.fill     {src, mask, out, model: best|fast, modelPath, passes, ghost, drift, driftDir, offset, seed}
               -> {output, passes}. Emits an `output` event per pass (pass-<n>.png next to `out`).
paint.cutout   {src, out, model: {file, kind}, modelDir}            -> {output (RGBA), coverage}
paint.segment  {src, points: [{x, y, positive}], out, modelPath}    -> {output (mask), score}
paint.enhance  {src, out, model: {file}, modelDir, scale: 2|4}      -> {output}  (Real-ESRGAN x4plus only)
paint.warm     {model, modelPath}                                   -> {}   (loads an inpainting session)
paint.prefetch {model: {file, sha256, url}, modelDir}               -> {model, path}  (only when the user asks)
"""

from __future__ import annotations

import hashlib
import os
from collections import OrderedDict
from typing import Any

import numpy as np

from .. import eraser as eng
from ..download import ensure_model, validate_model_spec
from ..imageio import load_image
from ..registry import Context, HandlerError, handler
from . import bgremove as bg
from . import upscale as up

FILL_MODELS = ("best", "fast")
DRIFT_DIRS = ("", "up", "down", "left", "right")
ENHANCE_FILE = "RealESRGAN_x4plus.pth"  # photos; the anime models are never used here
MAX_ENHANCE_PIXELS = 12_000_000
SAM_CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"


# -- helpers -----------------------------------------------------------------------


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def _file(params: dict[str, Any], key: str, what: str) -> str:
    p = _str(params, key)
    if not os.path.isfile(p):
        raise HandlerError("validation", f"{what} not found")
    return p


def _num(params: dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    v = params.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        raise HandlerError("validation", f"{key} must be between {lo:g} and {hi:g}")
    return float(v)


def save_png(img: Any, path: str) -> str:
    """Writes img as PNG via a .part file and returns the absolute path."""
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    try:
        with open(tmp, "wb") as f:
            img.save(f, format="PNG", compress_level=3)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return path


def _split(im: Any) -> tuple[np.ndarray, np.ndarray | None]:
    """RGB uint8 array and the alpha channel (None when fully opaque or absent)."""
    arr = np.asarray(im)
    rgb = np.ascontiguousarray(arr[..., :3])
    if arr.shape[2] == 4 and not (arr[..., 3] == 255).all():
        return rgb, np.ascontiguousarray(arr[..., 3])
    return rgb, None


def _join(rgb: np.ndarray, alpha: np.ndarray | None) -> Any:
    from PIL import Image

    if alpha is None:
        return Image.fromarray(rgb, "RGB")
    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")


# -- fill --------------------------------------------------------------------------


def shift_image(arr: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """arr translated by (dx, dy) whole pixels; the exposed border is reflected."""
    if dx == 0 and dy == 0:
        return arr
    import cv2

    h, w = arr.shape[:2]
    m = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(arr, m, (w, h), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_REFLECT_101)


def shift_mask(mask: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """mask translated by whole pixels, zero-filled."""
    if dx == 0 and dy == 0:
        return mask
    out = np.zeros_like(mask)
    h, w = mask.shape
    if abs(dx) >= w or abs(dy) >= h:
        return out
    out[max(dy, 0) : h + min(dy, 0), max(dx, 0) : w + min(dx, 0)] = mask[
        max(-dy, 0) : h + min(-dy, 0), max(-dx, 0) : w + min(-dx, 0)
    ]
    return out


def erode_mask(mask: np.ndarray, radius: int) -> np.ndarray:
    import cv2

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    return cv2.erode(mask.astype(np.uint8), k) > 0


_DIR_VEC = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


def grow_mask(mask: np.ndarray, direction: str, step: int) -> np.ndarray:
    """Melt: the mask grows `step` px in `direction` (and a pixel all round) so forms drip."""
    if not direction:
        return mask
    vx, vy = _DIR_VEC[direction]
    grown = mask | shift_mask(mask, vx * step, vy * step) | shift_mask(mask, vx * step // 2, vy * step // 2)
    return eng.dilate_mask(grown, 1)


def pass_mask(
    cur: np.ndarray, drift: float, rng: np.random.Generator, size: int
) -> np.ndarray:
    """The pass's mask: `cur` dilated by a seeded amount in ±drift·size/32 px and nudged by a
    seeded offset of up to half that. Drift 0 returns `cur` unchanged."""
    amount = drift * size / 32.0
    if amount < 1.0:
        return cur
    r = int(round(amount * rng.uniform(-1.0, 1.0)))
    dx = int(round(amount * 0.5 * rng.uniform(-1.0, 1.0)))
    dy = int(round(amount * 0.5 * rng.uniform(-1.0, 1.0)))
    m = eng.dilate_mask(cur, r) if r > 0 else (erode_mask(cur, -r) if r < 0 else cur)
    m = shift_mask(m, dx, dy)
    return m if m.any() else cur


def fill_passes(
    rgb: np.ndarray,
    mask: np.ndarray,
    alpha: np.ndarray | None,
    inpaint: Any,
    *,
    passes: int,
    ghost: float,
    drift: float,
    drift_dir: str,
    offset: tuple[int, int],
    seed: int,
    on_pass: Any = None,
) -> list[tuple[np.ndarray, np.ndarray | None]]:
    """Runs the passes; `inpaint(img, mask) -> img` fills a mask. Returns (rgb, alpha) per pass.
    Ghost 1 keeps the source; the same seed gives the same result."""
    import cv2

    h, w = mask.shape
    size = max(h, w)
    rng = np.random.default_rng(seed & 0xFFFFFFFFFFFFFFFF)
    step = max(2, round(size / 128))
    prev, prev_a = rgb, alpha
    cur = mask
    results: list[tuple[np.ndarray, np.ndarray | None]] = []
    for n in range(passes):
        if n:
            cur = grow_mask(cur, drift_dir, step)
        m = pass_mask(cur, drift, rng, size)
        if ghost >= 1.0:
            out, out_a = prev, prev_a
        else:
            context = shift_image(prev, offset[0], offset[1])
            filled = inpaint(context, m)
            w_new = 1.0 - ghost
            mixed = prev.astype(np.float32) * (1 - w_new) + filled.astype(np.float32) * w_new
            mixed = np.clip(mixed + 0.5, 0, 255).astype(np.uint8)
            out = np.where(m[..., None], mixed, prev)
            out_a = prev_a
            if prev_a is not None:
                guess = cv2.inpaint(prev_a, m.astype(np.uint8) * 255, 3, cv2.INPAINT_TELEA)
                a_mixed = prev_a.astype(np.float32) * (1 - w_new) + guess.astype(np.float32) * w_new
                out_a = np.where(m, np.clip(a_mixed + 0.5, 0, 255).astype(np.uint8), prev_a)
        results.append((out, out_a))
        if on_pass is not None:
            on_pass(n, out, out_a)
        prev, prev_a = out, out_a
    return results


def _runner(model: str, path: str) -> Any:
    try:
        return eng.lama_runner(path) if model == "best" else eng.migan_runner(path)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the model: {e}", "Remove the model and download it again") from e


@handler("paint.fill")
def fill(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    src, mask_path = _file(params, "src", "The source image"), _file(params, "mask", "The mask")
    out_path = os.path.abspath(_str(params, "out"))
    model = params.get("model")
    if model not in FILL_MODELS:
        raise HandlerError("validation", "model must be best or fast")
    model_path = _file(params, "modelPath", "The inpainting model")
    passes = params.get("passes", 1)
    if isinstance(passes, bool) or not isinstance(passes, int) or not 1 <= passes <= 12:
        raise HandlerError("validation", "passes must be 1 to 12")
    ghost = _num(params, "ghost", 0.0, 0.0, 1.0)
    drift = _num(params, "drift", 0.0, 0.0, 1.0)
    drift_dir = params.get("driftDir") or ""
    if drift_dir not in DRIFT_DIRS:
        raise HandlerError("validation", "driftDir must be up, down, left or right")
    off = params.get("offset") or [0, 0]
    if (
        not isinstance(off, (list, tuple))
        or len(off) != 2
        or any(isinstance(v, bool) or not isinstance(v, (int, float)) or abs(v) > 4096 for v in off)
    ):
        raise HandlerError("validation", "offset must be [x, y]")
    offset = (int(off[0]), int(off[1]))
    seed = params.get("seed", 0)
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise HandlerError("validation", "seed must be an integer")

    ctx.stage("Loading")
    im = load_image(src)
    rgb, alpha = _split(im)
    h, w = rgb.shape[:2]
    mask = eng.load_mask(mask_path, (w, h))
    if not mask.any():
        raise HandlerError("validation", "Paint over what to fill first")
    ctx.check_cancelled()
    ctx.stage("Loading model")
    run = _runner(model, model_path)
    ctx.check_cancelled()

    def inpaint(img: np.ndarray, m: np.ndarray) -> np.ndarray:
        ctx.check_cancelled()
        try:
            if model == "best":
                res, _ = eng.inpaint_best(img, m, run)
            else:
                res, _ = eng.inpaint_fast(img, m, run)
        except HandlerError:
            raise
        except Exception as e:
            raise HandlerError("tool_failed", f"Filling failed: {e}") from e
        return res

    folder = os.path.dirname(out_path)

    def on_pass(n: int, img: np.ndarray, a: np.ndarray | None) -> None:
        p = save_png(_join(img, a), os.path.join(folder, f"pass-{n + 1}.png"))
        ctx.output(p)
        ctx.progress((n + 1) / passes, f"Pass {n + 1} of {passes}", force=True)
        ctx.check_cancelled()

    ctx.stage("Filling")
    results = fill_passes(
        rgb, mask, alpha, inpaint,
        passes=passes, ghost=ghost, drift=drift, drift_dir=drift_dir, offset=offset, seed=seed, on_pass=on_pass,
    )
    last_rgb, last_a = results[-1]
    saved = save_png(_join(last_rgb, last_a), out_path)
    return {"output": saved, "passes": len(results)}


# -- cutout ------------------------------------------------------------------------


@handler("paint.cutout")
def cutout(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    src = _file(params, "src", "The source image")
    out_path = _str(params, "out")
    model_dir = _str(params, "modelDir")
    spec = params.get("model")
    if not isinstance(spec, dict) or spec.get("kind") not in bg.KINDS:
        raise HandlerError("validation", "model.kind must be birefnet or isnet")
    fname = spec.get("file")
    if not isinstance(fname, str) or os.path.basename(fname) != fname or not fname:
        raise HandlerError("validation", "model.file must be a plain file name")
    model_path = os.path.join(model_dir, fname)
    if not os.path.isfile(model_path):
        raise HandlerError("validation", "The cut-out model isn't downloaded", "Download it from the tool gate")

    ctx.stage("Loading model")
    try:
        sess = bg._get_session(model_path)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the model: {e}", "Remove the model and download it again") from e
    ctx.check_cancelled()
    im = load_image(src)
    rgb = im.convert("RGB")
    src_alpha = np.asarray(im.getchannel("A")) if im.mode == "RGBA" else None
    ctx.stage("Finding the subject")
    x = bg.preprocess(rgb, spec["kind"])
    try:
        outs = sess.run(None, {sess.get_inputs()[0].name: x})
    except Exception as e:
        raise HandlerError("tool_failed", f"Cutting out failed: {e}") from e
    ctx.check_cancelled()
    mask = bg.mask_from_output(outs, spec["kind"], rgb.size)
    alpha = np.asarray(mask)
    coverage = float((alpha > 127).mean()) if alpha.size else 0.0
    result, _ = bg.compose(rgb, mask, "transparent", clean=True)
    if src_alpha is not None:
        from PIL import Image

        a = np.asarray(result.getchannel("A")).astype(np.uint16) * src_alpha // 255
        result.putalpha(Image.fromarray(a.astype(np.uint8), "L"))
    saved = save_png(result, out_path)
    return {"output": saved, "coverage": coverage}


# -- segment -----------------------------------------------------------------------


class SamCache:
    """One SAM 2.1 image predictor with up to `size` image embeddings kept (LRU), so another click
    on the same picture only runs the mask decoder."""

    STATE = ("_features", "_orig_hw", "_is_image_set", "_is_batch")

    def __init__(self, size: int = 4) -> None:
        self.size = size
        self.entries: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.predictor: Any = None
        self.key: tuple[str, str] | None = None

    def drop(self) -> None:
        self.entries.clear()
        self.predictor = None
        self.key = None

    def predictor_for(self, model_path: str, device: str, factory: Any) -> Any:
        if self.key != (model_path, device):
            self.drop()
            self.predictor = factory(model_path, device)
            self.key = (model_path, device)
        return self.predictor

    def set_image(self, digest: str, arr: np.ndarray) -> bool:
        """Points the predictor at the image; returns True when the embedding was cached."""
        pred = self.predictor
        hit = self.entries.get(digest)
        if hit is not None:
            self.entries.move_to_end(digest)
            for k, v in hit.items():
                setattr(pred, k, v)
            return True
        pred.set_image(arr)
        self.entries[digest] = {k: getattr(pred, k) for k in self.STATE if hasattr(pred, k)}
        while len(self.entries) > self.size:
            self.entries.popitem(last=False)
        return False


_sam = SamCache()


def _load_sam(model_path: str, device: str) -> Any:
    import logging
    import warnings

    from ..matte import resident

    resident.before_sam()  # one matte model resident at a time
    prev = logging.root.manager.disable
    logging.disable(logging.WARNING)
    try:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        model = build_sam2(SAM_CONFIG, ckpt_path=model_path, device=device)
        pred = SAM2ImagePredictor(model)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the object model: {e}", "Remove the model in Settings and install it again") from e
    finally:
        logging.disable(prev)
    warnings.filterwarnings("ignore", message=r".*Skipping the post-processing step.*")
    return pred


def parse_points(raw: Any, w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    if not isinstance(raw, list) or not raw:
        raise HandlerError("validation", "Click on the object first")
    if len(raw) > 64:
        raise HandlerError("validation", "At most 64 points")
    pts: list[list[float]] = []
    labels: list[int] = []
    for p in raw:
        try:
            x, y, pos = float(p["x"]), float(p["y"]), bool(p["positive"])
        except (TypeError, KeyError, ValueError) as e:
            raise HandlerError("validation", "points need x, y and positive") from e
        if not (0 <= x <= w and 0 <= y <= h) or x != x or y != y:
            raise HandlerError("validation", "A point is outside the picture")
        pts.append([min(x, w - 1), min(y, h - 1)])
        labels.append(1 if pos else 0)
    if not any(labels):
        raise HandlerError("validation", "Add at least one positive point")
    return np.asarray(pts, np.float32), np.asarray(labels, np.int32)


@handler("paint.segment")
def segment(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    src = _file(params, "src", "The source image")
    out_path = _str(params, "out")
    model_path = _file(params, "modelPath", "The object model")
    ctx.stage("Reading the picture")
    im = load_image(src)
    arr = np.ascontiguousarray(np.asarray(im.convert("RGB")))
    h, w = arr.shape[:2]
    pts, labels = parse_points(params.get("points"), w, h)
    digest = hashlib.sha256(arr.tobytes()).hexdigest()
    ctx.check_cancelled()

    from ..matte import sam

    device = sam.pick_device()
    ctx.stage("Loading model")
    pred = _sam.predictor_for(model_path, device, _load_sam)
    ctx.check_cancelled()
    ctx.stage("Finding the object")
    try:
        with sam.quiet(ctx):
            _sam.set_image(digest, arr)
            masks, scores, _ = pred.predict(point_coords=pts, point_labels=labels, multimask_output=False)
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("tool_failed", f"Finding the object failed: {e}") from e
    from PIL import Image

    m = np.asarray(masks[0]) > 0.5
    saved = save_png(Image.fromarray(np.where(m, 255, 0).astype(np.uint8), "L"), out_path)
    return {"output": saved, "score": float(np.asarray(scores).reshape(-1)[0])}


# -- enhance -----------------------------------------------------------------------


@handler("paint.enhance")
def enhance(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    from PIL import Image

    src = _file(params, "src", "The source image")
    out_path = _str(params, "out")
    model_dir = _str(params, "modelDir")
    spec = params.get("model")
    fname = spec.get("file") if isinstance(spec, dict) else None
    if fname != ENHANCE_FILE:
        raise HandlerError("validation", "Enhance only uses the Real-ESRGAN photo model")
    scale = params.get("scale")
    if isinstance(scale, bool) or scale not in (2, 4):
        raise HandlerError("validation", "scale must be 2 or 4")
    model_path = os.path.join(model_dir, fname)
    if not os.path.isfile(model_path):
        raise HandlerError("validation", "The upscaling model isn't downloaded", "Download it from the tool gate")

    img = load_image(src)
    in_w, in_h = img.size
    if in_w * in_h > MAX_ENHANCE_PIXELS:
        raise HandlerError("validation", "This area is too large to enhance", "Enhance a smaller area")
    alpha = img.getchannel("A") if img.mode == "RGBA" else None
    rgb = np.asarray(img.convert("RGB"), dtype=np.uint8)
    ctx.stage("Loading model")
    device = up.pick_device()
    try:
        model = up._load_model(model_path, device)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the model: {e}", "Remove the model and download it again") from e
    ctx.check_cancelled()
    ctx.stage("Enhancing")
    try:
        res = up.upscale_array(model, rgb, int(getattr(model, "scale", 4)), device=device, ctx=ctx)
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("tool_failed", f"Enhancing failed: {e}", "Try a smaller area") from e
    out = Image.fromarray(res, "RGB")
    out_w, out_h = in_w * scale, in_h * scale
    if out.size != (out_w, out_h):
        out = out.resize((out_w, out_h), Image.LANCZOS)
    if alpha is not None:
        out.putalpha(alpha.resize((out_w, out_h), Image.LANCZOS))
    ctx.check_cancelled()
    return {"output": save_png(out, out_path)}


# -- warm / prefetch ---------------------------------------------------------------


@handler("paint.warm")
def warm(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Loads an inpainting session so the first stroke is quick. A missing model is not an error."""
    model, path = params.get("model"), params.get("modelPath")
    if model in FILL_MODELS and isinstance(path, str) and os.path.isfile(path):
        try:
            _runner(model, path)
        except HandlerError as e:
            ctx.log(f"warm-up skipped: {e}", "warning")
    return {}


@handler("paint.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads (sha256-verified) an Enhance model on the user's request (tool packs)."""
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    if spec["file"] != ENHANCE_FILE:
        raise HandlerError("validation", "Not an Enhance model")
    path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    return {"model": spec["file"], "path": path}
