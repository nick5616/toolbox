"""image handlers (Phase 4 SPEC.md). CONTRACT STUB (foundation): WP-BG1 implements."""

from __future__ import annotations

from ..registry import Context, HandlerError, handler


@handler("image.convert")
def convert(ctx: Context, params: dict) -> dict:
    raise HandlerError("internal", "image.convert isn't implemented yet")
