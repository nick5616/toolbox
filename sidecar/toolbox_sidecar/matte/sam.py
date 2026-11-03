"""Subject select with SAM 2.1 video propagation (SPEC 10.3 ``matte.select``, 22.7 sampling).

SAM runs on at most ``MAX_SAM_FPS`` frames per second of source ("sampled frames"); the frames
between are the linear blend of the two neighbouring sampled logits. Sampled frames go through
SAM in chunks of ``CHUNK_FRAMES``: from the anchor (the first clicked frame) forward, then
backward, each chunk after the first seeded with the previous chunk's boundary mask.

Pure helpers (``sample_frames``, ``plan_passes``, ``blend_pos``, ``sam_size``) are unit-tested
without a model; ``run_select`` takes a predictor factory so tests can use a fake.
"""

from __future__ import annotations

import bisect
import contextlib
import logging
import math
import os
import re
import shutil
import warnings
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..registry import Context, HandlerError
from . import CHUNK_FRAMES, MAX_SAM_FPS, SAM_LONG_SIDE
from .frames import Encoder, FrameReader, StreamIndex

CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"
#: Stored logits are downscaled to this long side (float16) to keep ~900 sampled frames small.
STORE_LONG_SIDE = 512
OBJ_ID = 1


@dataclass(frozen=True)
class Click:
    frame: int  # frame relative to the range start (0..n-1)
    x: float  # matte pixels
    y: float
    positive: bool


@dataclass(frozen=True)
class Pass:
    direction: str  # "fwd" | "bwd"
    lo: int  # first sampled position in the chunk (inclusive)
    hi: int  # last sampled position (inclusive)
    start: int  # position propagation starts from (the seeded frame)
    seed: str  # "clicks" (the anchor chunk of a direction) | "mask" (the previous chunk's boundary)


# -- pure helpers --------------------------------------------------------------------------


def sample_frames(n: int, fps: float, max_fps: float = MAX_SAM_FPS) -> list[int]:
    """Frames (0..n-1) SAM runs on: every ``step``-th, plus the last so every frame has a right neighbour."""
    if n < 1:
        return []
    step = max(1, math.ceil(fps / max_fps - 1e-9))
    out = list(range(0, n, step))
    if out[-1] != n - 1:
        out.append(n - 1)
    return out


def nearest_pos(samples: list[int], frame: int) -> int:
    """Index in ``samples`` of the sampled frame closest to ``frame`` (the earlier one on ties)."""
    i = bisect.bisect_left(samples, frame)
    if i == 0:
        return 0
    if i == len(samples):
        return len(samples) - 1
    return i - 1 if frame - samples[i - 1] <= samples[i] - frame else i


def plan_passes(m: int, anchor: int, size: int = CHUNK_FRAMES) -> list[Pass]:
    """Chunk passes over ``m`` sampled positions: forward from ``anchor``, then backward.

    Chunks hold ``size`` positions and overlap by one: the overlap frame is the seeded start of the next
    chunk (its mask is the previous chunk's boundary). The anchor chunk of each direction is seeded with clicks.
    """
    if m < 1 or not 0 <= anchor < m or size < 2:
        raise ValueError("bad plan")
    passes: list[Pass] = []
    start = anchor
    while True:
        hi = min(start + size - 1, m - 1)
        passes.append(Pass("fwd", start, hi, start, "clicks" if not passes else "mask"))
        if hi >= m - 1:
            break
        start = hi
    start = anchor
    first = True
    while start > 0:
        lo = max(start - size + 1, 0)
        passes.append(Pass("bwd", lo, start, start, "clicks" if first else "mask"))
        first = False
        start = lo
    return passes


def blend_pos(j: int, samples: list[int]) -> tuple[int, float]:
    """For frame ``j``: (index p of the sample at or before it, t) so logits = (1-t)*L[p] + t*L[p+1]."""
    if len(samples) == 1:
        return 0, 0.0
    p = min(bisect.bisect_right(samples, j) - 1, len(samples) - 2)
    p = max(p, 0)
    a, b = samples[p], samples[p + 1]
    return p, min(max((j - a) / (b - a), 0.0), 1.0)


def fit_size(width: int, height: int, long_side: int) -> tuple[int, int]:
    s = min(1.0, long_side / max(width, height))
    return max(2, round(width * s)), max(2, round(height * s))


def sam_size(width: int, height: int) -> tuple[int, int]:
    """JPEG size for SAM: long side at most SAM_LONG_SIDE, never enlarged."""
    return fit_size(width, height, SAM_LONG_SIDE)


def resize_f(a: np.ndarray, width: int, height: int) -> np.ndarray:
    """Bilinear resize of a float32 (h, w) array (area-filtered when shrinking)."""
    if a.shape == (height, width):
        return a.astype(np.float32, copy=False)
    from PIL import Image

    im = Image.fromarray(np.ascontiguousarray(a, dtype=np.float32), "F")
    return np.asarray(im.resize((width, height), Image.BILINEAR), dtype=np.float32)


def logits_to_alpha(logits: np.ndarray, width: int, height: int) -> np.ndarray:
    """Logits -> uint8 matte at (width, height): bilinear on the logits, then > 0 -> 255."""
    return np.where(resize_f(logits, width, height) > 0.0, 255, 0).astype(np.uint8)


def parse_clicks(raw: Any, n: int, width: int, height: int) -> list[Click]:
    if not isinstance(raw, list) or not raw:
        raise HandlerError("validation", "Click on the subject first")
    if len(raw) > 64:
        raise HandlerError("validation", "At most 64 clicks")
    out: list[Click] = []
    for c in raw:
        try:
            frame, x, y, pos = int(c["frame"]), float(c["x"]), float(c["y"]), bool(c["positive"])
        except (TypeError, KeyError, ValueError) as e:
            raise HandlerError("validation", "clicks need frame, x, y and positive") from e
        if not 0 <= frame < n:
            raise HandlerError("validation", "A click is outside the frame range")
        if not (0 <= x <= width and 0 <= y <= height):
            raise HandlerError("validation", "A click is outside the picture")
        out.append(Click(frame, x, y, pos))
    if not any(c.positive for c in out):
        raise HandlerError("validation", "Add at least one click on the subject")
    return out


# -- model ---------------------------------------------------------------------------------

_resident: tuple[str, str, Any] | None = None  # (model path, device, predictor)
_UNSUPPORTED = re.compile(r"mps|not (currently )?implemented|not supported|unsupported", re.I)


def drop_predictor() -> None:
    global _resident
    _resident = None
    try:
        import gc

        gc.collect()
        import torch

        if hasattr(torch, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


def pick_device() -> str:
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


def load_predictor(model_path: str, device: str) -> Any:
    """The resident SAM 2.1 tiny video predictor on ``device`` (rebuilt when the model or device changes)."""
    global _resident
    if _resident is not None and _resident[0] == model_path and _resident[1] == device:
        return _resident[2]
    from . import resident

    resident.before_sam()
    _resident = None
    prev = logging.root.manager.disable
    logging.disable(logging.WARNING)  # sam2 warns "cannot import name '_C'" (no compiled extension: harmless)
    try:
        from sam2.build_sam import build_sam2_video_predictor

        pred = build_sam2_video_predictor(CONFIG, ckpt_path=model_path, device=device)
    except Exception as e:
        raise HandlerError("tool_failed", f"Couldn't load the subject model: {e}", "Remove the model in Settings and install it again") from e
    finally:
        logging.disable(prev)
    warnings.filterwarnings("ignore", message=r".*Skipping the post-processing step.*")
    _resident = (model_path, device, pred)
    return pred


def _write_jpeg(frame: np.ndarray, path: str) -> None:
    from PIL import Image

    Image.fromarray(frame, "RGB").save(path, "JPEG", quality=95)


@contextlib.contextmanager
def quiet(ctx: Context) -> Iterator[None]:
    """SAM draws tqdm bars; the engine's tqdm shim would forward them as progress. Unbind the context meanwhile
    (this module reports its own progress)."""
    ctx.unbind()
    try:
        yield
    finally:
        ctx.bind()


def _to_numpy(t: Any) -> np.ndarray:
    return t.detach().float().cpu().numpy()


# -- propagation ---------------------------------------------------------------------------

PredictorFactory = Callable[[str], Any]  # device -> predictor


class Runner:
    """One select run: sampled frames on disk, clicks by position, results by position."""

    def __init__(
        self,
        ctx: Context,
        factory: PredictorFactory,
        device: str,
        frame_dir: str,
        work_dir: str,
        sw: int,
        sh: int,
        clicks: dict[int, list[Click]],
        total: int,
        mw: int,
        mh: int,
    ) -> None:
        self.ctx, self.factory, self.device = ctx, factory, device
        self.frame_dir, self.work_dir, self.sw, self.sh = frame_dir, work_dir, sw, sh
        self.clicks, self.total, self._mw, self._mh = clicks, total, mw, mh
        self.lw, self.lh = fit_size(sw, sh, STORE_LONG_SIDE)
        self.store: dict[int, np.ndarray] = {}
        self.boundary: np.ndarray | None = None
        self._warned = False

    # -- seeding --
    def _add_clicks(self, pred: Any, state: Any, lo: int, positions: list[int]) -> None:
        for pos in positions:
            cs = self.clicks.get(pos)
            if not cs:
                continue
            pts = np.array([[c.x * self.sw / self._mw, c.y * self.sh / self._mh] for c in cs], np.float32)
            labels = np.array([1 if c.positive else 0 for c in cs], np.int32)
            pred.add_new_points_or_box(state, frame_idx=pos - lo, obj_id=OBJ_ID, points=pts, labels=labels)

    def _run_pass(self, pred: Any, p: Pass) -> dict[int, np.ndarray]:
        import torch

        chunk = os.path.join(self.work_dir, f"chunk-{p.direction}-{p.lo}")
        os.makedirs(chunk, exist_ok=True)
        try:
            for k, pos in enumerate(range(p.lo, p.hi + 1)):
                shutil.copyfile(os.path.join(self.frame_dir, f"{pos:05d}.jpg"), os.path.join(chunk, f"{k:05d}.jpg"))
            state = pred.init_state(chunk, offload_video_to_cpu=True, offload_state_to_cpu=True)
            others = [pos for pos in range(p.lo, p.hi + 1) if pos != p.start]
            if p.seed == "clicks":
                self._add_clicks(pred, state, p.lo, [p.start])
            else:
                if self.boundary is None:
                    raise HandlerError("internal", "A chunk has no boundary mask")
                mask = torch.from_numpy(self.boundary > 0.0)
                pred.add_new_mask(state, frame_idx=p.start - p.lo, obj_id=OBJ_ID, mask=mask)
            self._add_clicks(pred, state, p.lo, others)
            out: dict[int, np.ndarray] = {}
            last: np.ndarray | None = None
            for fidx, _ids, masks in pred.propagate_in_video(state, start_frame_idx=p.start - p.lo, reverse=p.direction == "bwd"):
                self.ctx.check_cancelled()
                full = _to_numpy(masks[0, 0] if masks.dim() == 4 else masks[0])
                last = full
                out[p.lo + int(fidx)] = resize_f(full, self.lw, self.lh).astype(np.float16)
                self.ctx.progress(0.05 + 0.85 * (len(self.store) + len(out)) / self.total, f"Frame {len(self.store) + len(out)} of {self.total}")
            if last is None:
                raise HandlerError("tool_failed", "The subject model returned no frames")
            self.boundary = last
            return out
        finally:
            shutil.rmtree(chunk, ignore_errors=True)

    def run(self, passes: list[Pass]) -> None:
        for p in passes:
            self.ctx.check_cancelled()
            if p.seed == "clicks":
                self.boundary = None
            try:
                with quiet(self.ctx):
                    res = self._run_pass(self.factory(self.device), p)
            except HandlerError:
                raise
            except Exception as e:
                if self.device == "mps" and _UNSUPPORTED.search(str(e)):
                    if not self._warned:
                        self.ctx.log("The GPU can't run part of the subject model; continuing on the CPU", "warning")
                        self._warned = True
                    self.device = "cpu"
                    if p.seed == "clicks":
                        self.boundary = None
                    with quiet(self.ctx):
                        res = self._run_pass(self.factory(self.device), p)
                else:
                    raise HandlerError("tool_failed", f"The subject model failed: {e}") from e
            for pos, lg in res.items():
                self.store.setdefault(pos, lg)


def run_select(
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
    clicks: list[Click],
    work_dir: str,
    factory: PredictorFactory | None = None,
    chunk: int = CHUNK_FRAMES,
    device: str | None = None,
) -> dict[str, Any]:
    n = to_frame - from_frame
    samples = sample_frames(n, fps)
    m = len(samples)
    sw, sh = sam_size(width, height)
    if factory is None:
        device0 = device or pick_device()
        factory = lambda dev: load_predictor(model_path, dev)  # noqa: E731
    else:
        device0 = device or "cpu"
    frame_dir = os.path.join(work_dir, "frames")
    os.makedirs(frame_dir, exist_ok=True)
    try:
        ctx.stage("Reading frames")
        want = {s: i for i, s in enumerate(samples)}
        with FrameReader(ffmpeg, stream, index, from_frame, to_frame, fps, sw, sh) as reader:
            for j, frame in enumerate(reader):
                ctx.check_cancelled()
                pos = want.get(j)
                if pos is not None:
                    _write_jpeg(frame, os.path.join(frame_dir, f"{pos:05d}.jpg"))
                ctx.progress(0.05 * (j + 1) / n, f"Reading frame {j + 1} of {n}")

        by_pos: dict[int, list[Click]] = {}
        for c in clicks:
            by_pos.setdefault(nearest_pos(samples, c.frame), []).append(c)
        anchor = nearest_pos(samples, clicks[0].frame)
        runner = Runner(ctx, factory, device0, frame_dir, work_dir, sw, sh, by_pos, m, width, height)
        ctx.stage("Following the subject")
        runner.run(plan_passes(m, anchor, chunk))
        missing = [p for p in range(m) if p not in runner.store]
        if missing:
            raise HandlerError("tool_failed", "The subject model skipped frames")
    finally:
        shutil.rmtree(frame_dir, ignore_errors=True)

    # Blend, resize, threshold, encode.
    part = out_path + ".part"
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    enc = Encoder(ffmpeg, width, height, fps, part)
    ok = False
    try:
        ctx.stage("Writing the cut-out")
        store = runner.store
        for j in range(n):
            ctx.check_cancelled()
            p, t = blend_pos(j, samples)
            a = store[p].astype(np.float32)
            if t > 0.0 and p + 1 < m:
                a = a * (1.0 - t) + store[p + 1].astype(np.float32) * t
            enc.write(logits_to_alpha(a, width, height))
            ctx.progress(0.9 + 0.1 * (j + 1) / n, f"Writing frame {j + 1} of {n}")
        enc.finish()
        ctx.check_cancelled()
        os.replace(part, out_path)
        ok = True
    finally:
        if ok:
            enc.close()
        else:
            enc.abort()
    return {"frames": n, "sampled": m, "outPath": out_path, "width": width, "height": height, "device": runner.device}


def run_preview(
    ctx: Context,
    *,
    ffmpeg: str,
    stream: str,
    index: StreamIndex,
    frame: int,
    fps: float,
    width: int,
    height: int,
    out_path: str,
    model_path: str,
    clicks: list[Click],
    work_dir: str,
    factory: PredictorFactory | None = None,
) -> dict[str, Any]:
    """One frame: clicks -> a PNG mask (SPEC 10.3 ``matte.select_preview``)."""
    from PIL import Image

    sw, sh = sam_size(width, height)
    chunk = os.path.join(work_dir, "preview")
    os.makedirs(chunk, exist_ok=True)
    try:
        ctx.stage("Reading the frame")
        with FrameReader(ffmpeg, stream, index, frame, frame + 1, fps, sw, sh) as reader:
            img = next(iter(reader))
        _write_jpeg(img, os.path.join(chunk, "00000.jpg"))
        ctx.check_cancelled()
        ctx.stage("Finding the subject")
        device = "cpu" if factory is not None else pick_device()
        get = factory if factory is not None else (lambda d: load_predictor(model_path, d))
        pts = np.array([[c.x * sw / width, c.y * sh / height] for c in clicks], np.float32)
        labels = np.array([1 if c.positive else 0 for c in clicks], np.int32)

        def attempt(dev: str) -> np.ndarray:
            pred = get(dev)
            state = pred.init_state(chunk, offload_video_to_cpu=True, offload_state_to_cpu=True)
            _f, _ids, masks = pred.add_new_points_or_box(state, frame_idx=0, obj_id=OBJ_ID, points=pts, labels=labels)
            return _to_numpy(masks[0, 0] if masks.dim() == 4 else masks[0])

        try:
            with quiet(ctx):
                logits = attempt(device)
        except HandlerError:
            raise
        except Exception as e:
            if device == "mps" and _UNSUPPORTED.search(str(e)):
                ctx.log("The GPU can't run part of the subject model; continuing on the CPU", "warning")
                with quiet(ctx):
                    logits = attempt("cpu")
            else:
                raise HandlerError("tool_failed", f"The subject model failed: {e}") from e
        ctx.check_cancelled()
        alpha = logits_to_alpha(logits, width, height)
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        part = out_path + ".part"
        Image.fromarray(alpha, "L").save(part, format="PNG")
        os.replace(part, out_path)
    finally:
        shutil.rmtree(chunk, ignore_errors=True)
    return {"outPath": out_path, "coverage": float((alpha > 0).mean())}
