"""analysis handlers. STUB (foundation) — WP-S3 implements per SPEC.md §4.6."""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("analysis.bpm_key")
def analysis_bpm_key(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "analysis.bpm_key isn't implemented yet")
