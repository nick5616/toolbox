"""Matte handlers for Edit Studio (Phase 9 SPEC 10.3): people (RVM), select (SAM 2.1), preview, prefetch.

Common params: ``{ffmpeg, stream, index, fromFrame, toFrame, fps, width, height, outPath, model: {file,
sha256}, modelDir, workDir?}``. ``toFrame`` is exclusive; ``width``/``height`` are the matte size (even).
The run handlers never download: the model must already be in ``modelDir`` (``matte.prefetch`` downloads).
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import tempfile
from typing import Any

from ..download import ensure_model, validate_model_spec
from ..matte import MAX_SELECT_SECONDS
from ..matte.frames import StreamIndex
from ..registry import Context, HandlerError, handler


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


def _int(params: dict[str, Any], key: str, lo: int, hi: int) -> int:
    v = params.get(key)
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise HandlerError("validation", f"{key} must be a whole number from {lo} to {hi}")
    return v


def _model_path(params: dict[str, Any], what: str, hint: str) -> str:
    m = params.get("model")
    if not isinstance(m, dict):
        raise HandlerError("validation", "model is required")
    f = m.get("file")
    if not isinstance(f, str) or not f or os.path.basename(f) != f or f in (".", ".."):
        raise HandlerError("validation", "model.file must be a plain file name")
    p = os.path.join(_str(params, "modelDir"), f)
    if not os.path.isfile(p):
        raise HandlerError("validation", f"The {what} model isn't installed", hint)
    return p


class Common:
    def __init__(self, params: dict[str, Any], what: str, preview: bool = False) -> None:
        self.ffmpeg = _str(params, "ffmpeg")
        self.stream = _file(params, "stream", "The edit stream")
        self.index_path = _file(params, "index", "The stream index")
        self.from_frame = _int(params, "fromFrame", 0, 10_000_000)
        if preview and "toFrame" not in params:
            self.to_frame = self.from_frame + 1
        else:
            self.to_frame = _int(params, "toFrame", self.from_frame + 1, 10_000_000)
        fps = params.get("fps")
        if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not 1 <= fps <= 120:
            raise HandlerError("validation", "fps must be from 1 to 120")
        self.fps = float(fps)
        self.width = _int(params, "width", 2, 8192)
        self.height = _int(params, "height", 2, 8192)
        if self.width % 2 or self.height % 2:
            raise HandlerError("validation", "width and height must be even")
        self.out_path = os.path.abspath(_str(params, "outPath"))
        self.model_path = _model_path(params, what, "Install the Music edits tool pack in Settings")
        self.work_dir = params.get("workDir")
        if self.work_dir is not None and not isinstance(self.work_dir, str):
            raise HandlerError("validation", "workDir must be a string")
        self.index = StreamIndex.load(self.index_path)
        if self.to_frame > self.index.frames:
            raise HandlerError("validation", "The frame range is outside the edit stream")


def _relative(raw: Any, from_frame: int, only_here: bool = False) -> Any:
    """Clicks carry absolute frames; the matte code wants them relative to the range start."""
    if not isinstance(raw, list):
        return raw
    out = []
    for k in raw:
        if not isinstance(k, dict) or isinstance(k.get("frame"), bool) or not isinstance(k.get("frame"), int):
            out.append(k)  # parse_clicks reports it
            continue
        if only_here and k["frame"] != from_frame:
            continue
        out.append({**k, "frame": k["frame"] - from_frame})
    return out


def _with_work_dir(c: Common, fn: Any) -> Any:
    if c.work_dir:
        os.makedirs(c.work_dir, exist_ok=True)
        return fn(c.work_dir)
    d = tempfile.mkdtemp(prefix="toolbox-matte-")
    try:
        return fn(d)
    finally:
        shutil.rmtree(d, ignore_errors=True)


@handler("matte.people")
def people(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    from ..matte import rvm

    c = Common(params, "people cut-out")
    return rvm.run_people(
        ctx, ffmpeg=c.ffmpeg, stream=c.stream, index=c.index, from_frame=c.from_frame, to_frame=c.to_frame,
        fps=c.fps, width=c.width, height=c.height, out_path=c.out_path, model_path=c.model_path,
    )


def _require_sam() -> None:
    if importlib.util.find_spec("sam2") is None:
        raise HandlerError("unavailable", "Subject select isn't available on this computer")


@handler("matte.select")
def select(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    _require_sam()
    from ..matte import sam

    c = Common(params, "subject select")
    n = c.to_frame - c.from_frame
    if n > MAX_SELECT_SECONDS * c.fps:
        raise HandlerError("validation", "Select a subject in a range of 60 seconds or less")
    clicks = sam.parse_clicks(_relative(params.get("clicks"), c.from_frame), n, c.width, c.height)

    def go(work: str) -> dict[str, Any]:
        return sam.run_select(
            ctx, ffmpeg=c.ffmpeg, stream=c.stream, index=c.index, from_frame=c.from_frame, to_frame=c.to_frame,
            fps=c.fps, width=c.width, height=c.height, out_path=c.out_path, model_path=c.model_path,
            clicks=clicks, work_dir=work,
        )

    return _with_work_dir(c, go)


@handler("matte.select_preview")
def select_preview(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    _require_sam()
    from ..matte import sam

    c = Common(params, "subject select", preview=True)
    clicks = sam.parse_clicks(_relative(params.get("clicks"), c.from_frame, only_here=True), 1, c.width, c.height)

    def go(work: str) -> dict[str, Any]:
        return sam.run_preview(
            ctx, ffmpeg=c.ffmpeg, stream=c.stream, index=c.index, frame=c.from_frame, fps=c.fps, width=c.width,
            height=c.height, out_path=c.out_path, model_path=c.model_path, clicks=clicks, work_dir=work,
        )

    return _with_work_dir(c, go)


@handler("matte.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads (sha256-verified) a matte model without running it (tool packs)."""
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    return {"model": spec["file"], "path": path}
