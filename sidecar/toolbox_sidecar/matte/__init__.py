"""Cut-out mattes for Edit Studio (Phase 9 SPEC 10): Robust Video Matting (ONNX) and SAM 2.1 video propagation.

Modules: ``frames`` (Annex-B reader + grey encoder pipes), ``rvm`` (people), ``sam`` (planner,
propagation, preview). Handlers live in ``handlers/matte.py``.
"""

from __future__ import annotations

#: SAM runs on at most this many frames per second of source; the frames between get blended logits.
MAX_SAM_FPS = 15
#: Sampled frames per SAM chunk.
CHUNK_FRAMES = 96
#: SAM frames are JPEGs with a long side of at most this many pixels.
SAM_LONG_SIDE = 1024
#: A select range is at most this long (Go enforces 60 s; this is a backstop).
MAX_SELECT_SECONDS = 61
