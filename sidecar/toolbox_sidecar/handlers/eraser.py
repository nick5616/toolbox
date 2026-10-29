"""Eraser handlers (SPEC.md §9.2). ER1 implements them; foundation stubs only."""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("eraser.inpaint")
def inpaint(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "eraser.inpaint isn't built yet")


@handler("eraser.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "eraser.prefetch isn't built yet")
