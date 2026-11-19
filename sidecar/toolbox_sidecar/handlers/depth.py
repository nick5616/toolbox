"""depth handlers: Depth Anything V2 Small depth maps (Phase 21 SPEC §E5).

Wave 0 stub: depth.prefetch works; depth.image and depth.video are G2's.
The handlers never download (only depth.prefetch does, sha-verified).

Model contract (spike 2026-11-19, docs/DECISIONS.md):
- input ``pixel_values`` float32 [1, 3, H, W], H and W multiples of 14
  (resize bicubic so the short side is 518 for pictures / 266 for video,
  rounding each side to the nearest multiple of 14), RGB/255 then ImageNet
  mean (0.485, 0.456, 0.406) / std (0.229, 0.224, 0.225);
- output ``predicted_depth`` float32 [1, H, W]: relative inverse depth,
  larger = nearer. Maps are log1p-compressed, then normalised p2..p98 so
  near = white.
"""

from __future__ import annotations

from typing import Any

from ..download import ensure_model, validate_model_spec
from ..registry import Context, HandlerError, handler


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


@handler("depth.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads (sha256-verified) the depth model without running it."""
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    return {"model": spec["file"], "path": path}


@handler("depth.image")
def depth_image(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """{path, model (abs path), out (16-bit PNG path)} -> {out, width, height}."""
    raise HandlerError("internal", "depth.image isn't ready yet")


@handler("depth.video")
def depth_video(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """{path, model, outDir, fps, ffmpeg} -> {preview, export} grey edit streams."""
    raise HandlerError("internal", "depth.video isn't ready yet")
