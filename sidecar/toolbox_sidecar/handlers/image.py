"""image handlers: HEIC/any-image to PNG (Phase 4 SPEC.md §13.1)."""

from __future__ import annotations

import os
from typing import Any

from ..imageio import load_image
from ..registry import Context, HandlerError, handler


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


@handler("image.convert")
def convert(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Decodes `input` (incl. HEIC) and writes a PNG (alpha kept) to `output`."""
    src = _str(params, "input")
    dst = os.path.abspath(_str(params, "output"))
    if not os.path.isfile(src):
        raise HandlerError("validation", "Input file not found", src)
    if os.path.abspath(src) == dst:
        raise HandlerError("validation", "output must differ from input")
    img = load_image(src)
    ctx.check_cancelled()
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    try:
        with open(tmp, "wb") as f:
            img.save(f, format="PNG")
        os.replace(tmp, dst)
    except Exception as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise HandlerError("tool_failed", f"Couldn't write the image: {e}") from e
    return {"width": img.size[0], "height": img.size[1]}
