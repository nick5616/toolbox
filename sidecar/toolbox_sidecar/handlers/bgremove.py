"""bgremove handlers (Phase 4 SPEC.md). CONTRACT STUB (foundation): WP-BG1 implements."""

from __future__ import annotations

from ..registry import Context, HandlerError, handler


@handler("bgremove.run")
def run(ctx: Context, params: dict) -> dict:
    raise HandlerError("internal", "bgremove.run isn't implemented yet")
