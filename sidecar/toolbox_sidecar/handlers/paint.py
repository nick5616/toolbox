"""Paint+ Lab perception tools (Phase 19 SPEC.md §2.5).

CONTRACT STUB (Wave 0): P4 implements every handler below, reusing
eraser.py's region inpainting and session cache, bgremove.py's session and
upscale.py's tiler. Handlers never download: the Go side passes explicit
model paths/specs. Params and results:

paint.fill    {src, mask, out, model, modelPath, passes, ghost, drift, driftDir, offset, seed}
              -> {output, passes}; emits an `output` event per intermediate pass (pass-<n>.png)
paint.cutout  {src, out, model, modelDir} -> {output, coverage}
paint.segment {src, points:[{x,y,positive}], out, model} -> {output, score}
paint.enhance {src, out, model, modelDir, scale} -> {output}
paint.warm    {model, modelPath} -> {}
"""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


def _todo(name: str) -> HandlerError:
    return HandlerError("internal", f"{name} isn't implemented yet")


@handler("paint.fill")
def fill(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise _todo("paint.fill")


@handler("paint.cutout")
def cutout(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise _todo("paint.cutout")


@handler("paint.segment")
def segment(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise _todo("paint.segment")


@handler("paint.enhance")
def enhance(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise _todo("paint.enhance")


@handler("paint.warm")
def warm(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    return {}
