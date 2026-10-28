"""Shared image loading for the image handlers (Phase 4 SPEC.md §13.1).

CONTRACT STUB (foundation): WP-BG1 implements load_image.
"""

from __future__ import annotations

from typing import Any


def load_image(path: str) -> Any:
    """Opens path (incl. HEIC/HEIF), applies EXIF orientation, converts an
    embedded ICC profile to sRGB, and returns a PIL image in RGB (or RGBA
    when the image has alpha). Raises HandlerError("validation",
    "Couldn't read this image") on failure."""
    raise NotImplementedError
