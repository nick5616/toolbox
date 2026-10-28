"""transcribe handlers: speech to text via faster-whisper (Phase 3 SPEC.md §5.2).

FOUNDATION STUB: WP-TR1 implements ``transcribe.run``.
"""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("transcribe.run")
def run(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "Transcription isn't implemented yet")
