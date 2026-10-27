"""system handlers. STUB (foundation) — WP-S2 implements per SPEC.md §4.6."""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("system.ping")
def system_ping(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "system.ping isn't implemented yet")


@handler("system.info")
def system_info(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "system.info isn't implemented yet")


@handler("system.warmup")
def system_warmup(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "system.warmup isn't implemented yet")
