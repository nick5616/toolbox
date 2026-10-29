"""Redact handlers (SPEC.md §8.2). RD1 implements them; foundation stubs only."""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("redact.detect_image")
def detect_image(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "redact.detect_image isn't built yet")


@handler("redact.detect_video")
def detect_video(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "redact.detect_video isn't built yet")


@handler("redact.apply_image")
def apply_image(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "redact.apply_image isn't built yet")


@handler("redact.apply_video")
def apply_video(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "redact.apply_video isn't built yet")


@handler("redact.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "redact.prefetch isn't built yet")
