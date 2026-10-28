"""ocr handlers: text recognition with RapidOCR (Phase 5 SPEC.md §5). Stubs until the OCR package lands."""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("ocr.image")
def ocr_image(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("tool_failed", "OCR isn't implemented yet")


@handler("ocr.pdf")
def ocr_pdf(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("tool_failed", "OCR isn't implemented yet")
