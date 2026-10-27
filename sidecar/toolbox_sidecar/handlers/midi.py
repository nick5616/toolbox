"""midi handlers. STUB (foundation) — WP-S3 implements per SPEC.md §4.6."""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("midi.transcribe")
def midi_transcribe(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "midi.transcribe isn't implemented yet")
