"""Redact engine: face/plate detection, tracking and rendering (SPEC.md §8.2).

Boxes are ``(x, y, w, h)`` floats in 0..1 coordinates of the upright frame.
"""

from __future__ import annotations

#: sensitivity -> (face score threshold, plate score threshold)
THRESHOLDS = {"normal": (0.6, 0.3), "high": (0.45, 0.2)}

#: Video detection samples at most this many frames per second.
MAX_DETECT_FPS = 15.0
#: Video detection frames are scaled to this long side.
DETECT_LONG_SIDE = 1280
