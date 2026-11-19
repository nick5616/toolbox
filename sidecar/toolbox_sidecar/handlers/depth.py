"""depth handlers: Depth Anything V2 Small depth maps (Phase 21 SPEC §E5).

``depth.prefetch`` downloads the model (sha256-verified); ``depth.image`` and ``depth.video`` never download.

Model contract (spike 2026-11-19, docs/DECISIONS.md):
- input ``pixel_values`` float32 [1, 3, H, W], H and W multiples of 14
  (resize bicubic so the short side is 518 for pictures / 266 for video,
  rounding each side to the nearest multiple of 14), RGB/255 then ImageNet
  mean (0.485, 0.456, 0.406) / std (0.229, 0.224, 0.225);
- output ``predicted_depth`` float32 [1, H, W]: relative inverse depth,
  larger = nearer. Maps are log1p-compressed, then normalised p2..p98 so
  near = white.

``depth.image {path, model, out}``: a 16-bit PNG, near = white, upsampled to <= 2048 px on the long side with
guided-filter edges against the picture. ``model`` is the absolute path of the ONNX file.

``depth.video {ffmpeg, stream, index, fps, width, height, outDir, name, model}``: reads the clip's edit stream
(the same Annex-B stream the editor plays), infers at a short side of 266 (every 2nd frame above 15 fps, the frames
between interpolated), smooths with an EMA (alpha 0.6, reset on scene cuts), normalises p2..p98 over the clip and
writes two grey edit streams ``<outDir>/<name>-export.h264`` (``width`` x ``height``, rounded down to multiples of
4) and ``<name>-preview.h264`` (half of that). Go writes their ``.idx.json`` (like the matte streams).
"""

from __future__ import annotations

import os
from typing import Any

import numpy as np

from ..download import ensure_model, validate_model_spec
from ..registry import Context, HandlerError, handler

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
PATCH = 14
IMAGE_SHORT = 518
VIDEO_SHORT = 266
MAP_LONG_MAX = 2048  # depth.png long side cap
EMA_ALPHA = 0.6
SCENE_CUT = 0.25  # mean |delta| of 64 px thumbnails (0..1)
P_LOW, P_HIGH = 2.0, 98.0
BATCH = 8  # check_cancelled every this many frames

# One resident session: (model path, session).
_session: tuple[str, Any] | None = None


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def _int(params: dict[str, Any], key: str, lo: int, hi: int) -> int:
    v = params.get(key)
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise HandlerError("validation", f"{key} must be a whole number from {lo} to {hi}")
    return v


def _file(params: dict[str, Any], key: str, what: str) -> str:
    p = _str(params, key)
    if not os.path.isfile(p):
        raise HandlerError("validation", f"{what} not found", p)
    return p


def _model(params: dict[str, Any]) -> str:
    p = _str(params, "model")
    if not os.path.isfile(p):
        raise HandlerError("validation", "The depth model isn't installed", "Install the Color pack in Settings")
    return p


@handler("depth.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads (sha256-verified) the depth model without running it."""
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    return {"model": spec["file"], "path": path}


# -- pure helpers (tested directly) ----------------------------------------------------------------


def infer_size(width: int, height: int, short: int) -> tuple[int, int]:
    """(w, h) with the short side near ``short``, aspect kept, each side a multiple of 14 (at least 14)."""
    s = short / float(min(width, height))
    w = max(PATCH, int(round(width * s / PATCH)) * PATCH)
    h = max(PATCH, int(round(height * s / PATCH)) * PATCH)
    return w, h


def to_input(rgb: np.ndarray) -> np.ndarray:
    """(h, w, 3) uint8 RGB -> float32 (1, 3, h, w), ImageNet-normalised."""
    x = (rgb.astype(np.float32) * (1.0 / 255.0) - MEAN) / STD
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None])


def compress(depth: np.ndarray) -> np.ndarray:
    """Relative inverse depth -> log1p space (negatives clipped)."""
    return np.log1p(np.maximum(depth, 0.0))


def percentile_range(values: np.ndarray, lo: float = P_LOW, hi: float = P_HIGH) -> tuple[float, float]:
    """The p2..p98 range of ``values``; widened a little when the map is flat."""
    a, b = np.percentile(values.astype(np.float32).ravel(), [lo, hi])
    a, b = float(a), float(b)
    if b - a < 1e-6:
        b = a + 1e-6
    return a, b


def normalise(depth: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """log-space depth -> 0..1 (near = 1) with the given range."""
    return np.clip((depth - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)


def thumb(gray_or_rgb: np.ndarray) -> np.ndarray:
    """A 64 px wide grey thumbnail (float 0..1) for scene-cut detection."""
    import cv2

    g = gray_or_rgb
    if g.ndim == 3:
        g = g.mean(axis=2)
    h, w = g.shape[:2]
    return cv2.resize(g.astype(np.float32), (64, max(1, round(64 * h / w))), interpolation=cv2.INTER_AREA) / 255.0


def is_cut(a: np.ndarray | None, b: np.ndarray) -> bool:
    """True when two thumbnails differ so much that they are different shots."""
    return a is not None and a.shape == b.shape and float(np.abs(a - b).mean()) > SCENE_CUT


def ema(prev: np.ndarray | None, cur: np.ndarray, cut: bool, alpha: float = EMA_ALPHA) -> np.ndarray:
    """Temporal smoothing: ``alpha`` of the new frame; a scene cut (or the first frame) resets it."""
    if prev is None or cut:
        return cur
    return alpha * cur + (1.0 - alpha) * prev


def guided_filter(guide: np.ndarray, src: np.ndarray, radius: int, eps: float) -> np.ndarray:
    """He et al.'s guided filter: ``src`` smoothed so its edges follow ``guide`` (both float32 2-D)."""
    import cv2

    def box(x: np.ndarray) -> np.ndarray:
        return cv2.boxFilter(x, -1, (2 * radius + 1, 2 * radius + 1), borderType=cv2.BORDER_REPLICATE)

    mean_i, mean_p = box(guide), box(src)
    cov = box(guide * src) - mean_i * mean_p
    var = box(guide * guide) - mean_i * mean_i
    a = cov / (var + eps)
    b = mean_p - a * mean_i
    return box(a) * guide + box(b)


def get_session(path: str) -> Any:
    global _session
    if _session is not None and _session[0] == path:
        return _session[1]
    _session = None
    try:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.log_severity_level = 3
        sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the depth model: {e}", "Remove the model in Settings and install it again") from e
    _session = (path, sess)
    return sess


def run_model(sess: Any, rgb: np.ndarray) -> np.ndarray:
    """(h, w, 3) uint8 -> float32 (h, w) relative inverse depth."""
    name = sess.get_inputs()[0].name
    try:
        out = sess.run(None, {name: to_input(rgb)})[0]
    except Exception as e:
        raise HandlerError("tool_failed", f"The depth model failed: {e}") from e
    arr = np.asarray(out, np.float32)
    arr = arr.reshape(arr.shape[-2], arr.shape[-1])
    if arr.shape != rgb.shape[:2]:
        import cv2

        arr = cv2.resize(arr, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_LINEAR)
    return arr


# -- depth.image -----------------------------------------------------------------------------------


@handler("depth.image")
def depth_image(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """{path, model (abs path), out (16-bit PNG path)} -> {out, width, height}."""
    import cv2
    from PIL import Image, ImageOps

    path = _file(params, "path", "The picture")
    model = _model(params)
    out = os.path.abspath(_str(params, "out"))
    ctx.stage("Loading the depth model")
    sess = get_session(model)
    ctx.check_cancelled()
    try:
        with Image.open(path) as im:
            rgb = np.asarray(ImageOps.exif_transpose(im).convert("RGB"))
    except Exception as e:
        raise HandlerError("validation", "Couldn't read this picture", str(e)) from e
    h, w = rgb.shape[:2]
    iw, ih = infer_size(w, h, IMAGE_SHORT)
    small = cv2.resize(rgb, (iw, ih), interpolation=cv2.INTER_CUBIC)
    ctx.stage("Estimating depth")
    raw = compress(run_model(sess, small))
    ctx.check_cancelled()
    lo, hi = percentile_range(raw)
    d = normalise(raw, lo, hi)
    # Upsample to <= 2048 on the long side and snap the edges to the picture.
    s = min(1.0, MAP_LONG_MAX / float(max(w, h)))
    ow, oh = max(1, round(w * s)), max(1, round(h * s))
    d = cv2.resize(d, (ow, oh), interpolation=cv2.INTER_CUBIC)
    guide = cv2.cvtColor(cv2.resize(rgb, (ow, oh), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    ctx.stage("Sharpening the edges")
    d = np.clip(guided_filter(guide, np.clip(d, 0.0, 1.0), max(4, max(ow, oh) // 200), 1e-3), 0.0, 1.0)
    u16 = np.round(d * 65535.0).astype(np.uint16)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    part = out + ".part"
    try:
        Image.fromarray(u16).save(part, format="PNG")
        os.replace(part, out)
    finally:
        if os.path.exists(part):
            os.remove(part)
    ctx.progress(1.0, "Depth map ready")
    return {"out": out, "width": ow, "height": oh}


# -- depth.video -----------------------------------------------------------------------------------


def _halve(gray: np.ndarray) -> np.ndarray:
    """2x2 mean of a (h, w) uint8 array whose sides are multiples of 4."""
    h, w = gray.shape
    return gray.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3)).round().astype(np.uint8)


@handler("depth.video")
def depth_video(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """See the module docstring. -> {frames, exportPath, previewPath, width, height, previewWidth, previewHeight}."""
    import cv2

    from ..matte.frames import Encoder, FrameReader, StreamIndex

    ffmpeg = _str(params, "ffmpeg")
    stream = _file(params, "stream", "The edit stream")
    index = StreamIndex.load(_file(params, "index", "The stream index"))
    fps = params.get("fps")
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not 1 <= fps <= 120:
        raise HandlerError("validation", "fps must be from 1 to 120")
    fps = float(fps)
    width, height = _int(params, "width", 4, 8192), _int(params, "height", 4, 8192)
    ow, oh = max(4, width // 4 * 4), max(4, height // 4 * 4)
    pw, ph = ow // 2, oh // 2
    out_dir = os.path.abspath(_str(params, "outDir"))
    name = _str(params, "name")
    if os.path.basename(name) != name:
        raise HandlerError("validation", "name must be a plain file name")
    model = _model(params)
    n = index.frames

    ctx.stage("Loading the depth model")
    sess = get_session(model)
    ctx.check_cancelled()
    os.makedirs(out_dir, exist_ok=True)

    # The output size has the stream's aspect (Go derives it from the stream).
    iw, ih = infer_size(ow, oh, VIDEO_SHORT)
    step = 2 if fps > 15 else 1

    work = os.path.join(out_dir, f"{name}.work.f16")
    export_path, preview_path = os.path.join(out_dir, f"{name}-export.h264"), os.path.join(out_dir, f"{name}-preview.h264")
    inferred: list[int] = []
    cuts = [False] * n
    mm: Any = None
    enc_e: Any = None
    enc_p: Any = None
    ok = False
    try:
        total_inferred = (n + step - 1) // step + 1
        mm = np.memmap(work, dtype=np.float16, mode="w+", shape=(total_inferred, ih, iw))
        # Pass 1: decode every frame at the inference size, find cuts, infer every `step`th (and the last).
        prev_thumb: np.ndarray | None = None
        with FrameReader(ffmpeg, stream, index, 0, n, fps, iw, ih) as reader:
            ctx.stage("Estimating depth")
            for j, frame in enumerate(reader):
                if j % BATCH == 0:
                    ctx.check_cancelled()
                t = thumb(frame)
                cuts[j] = is_cut(prev_thumb, t)
                prev_thumb = t
                if j % step == 0 or j == n - 1:
                    mm[len(inferred)] = compress(run_model(sess, frame)).astype(np.float16)
                    inferred.append(j)
                ctx.progress(0.8 * (j + 1) / n, f"Frame {j + 1} of {n}")
        k = len(inferred)
        ctx.check_cancelled()
        # The clip's range from a sample of every map.
        sample = np.concatenate([np.asarray(mm[i, ::4, ::4], np.float32).ravel() for i in range(k)])
        lo, hi = percentile_range(sample)

        # Pass 2: interpolate, smooth, normalise, resize, encode both tiers.
        enc_e = Encoder(ffmpeg, ow, oh, fps, export_path + ".part")
        enc_p = Encoder(ffmpeg, pw, ph, fps, preview_path + ".part")
        ctx.stage("Writing the depth video")
        prev: np.ndarray | None = None
        ki = 0
        for j in range(n):
            if j % BATCH == 0:
                ctx.check_cancelled()
            while ki + 1 < k and inferred[ki + 1] <= j:
                ki += 1
            if inferred[ki] == j or ki + 1 >= k:
                d = np.asarray(mm[ki], np.float32)
            else:
                i0, i1 = inferred[ki], inferred[ki + 1]
                if any(cuts[i0 + 1 : i1 + 1]) and j < _first_cut(cuts, i0 + 1, i1 + 1):
                    d = np.asarray(mm[ki], np.float32)
                elif any(cuts[i0 + 1 : i1 + 1]):
                    d = np.asarray(mm[ki + 1], np.float32)
                else:
                    t = (j - i0) / float(i1 - i0)
                    d = (1.0 - t) * np.asarray(mm[ki], np.float32) + t * np.asarray(mm[ki + 1], np.float32)
            prev = ema(prev, d, cuts[j])
            gray = cv2.resize(normalise(prev, lo, hi), (ow, oh), interpolation=cv2.INTER_LINEAR)
            g8 = np.round(gray * 255.0).astype(np.uint8)
            enc_e.write(g8)
            enc_p.write(_halve(g8))
            ctx.progress(0.8 + 0.2 * (j + 1) / n, f"Writing frame {j + 1} of {n}")
        enc_e.finish()
        enc_p.finish()
        ctx.check_cancelled()
        os.replace(export_path + ".part", export_path)
        os.replace(preview_path + ".part", preview_path)
        ok = True
    finally:
        for enc in (enc_e, enc_p):
            if enc is not None:
                if ok:
                    enc.close()
                else:
                    enc.abort()
        mm = None
        try:
            os.remove(work)
        except OSError:
            pass
    ctx.progress(1.0, "Depth video ready", force=True)
    return {
        "frames": n, "exportPath": export_path, "previewPath": preview_path,
        "width": ow, "height": oh, "previewWidth": pw, "previewHeight": ph,
    }


def _first_cut(cuts: list[bool], lo: int, hi: int) -> int:
    for i in range(lo, hi):
        if cuts[i]:
            return i
    return hi
