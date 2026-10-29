"""Denoise handlers (SPEC.md §6.2). AC1 implements them; foundation stubs only."""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("denoise.dfn3")
def dfn3(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "denoise.dfn3 isn't built yet")


@handler("denoise.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "denoise.prefetch isn't built yet")
