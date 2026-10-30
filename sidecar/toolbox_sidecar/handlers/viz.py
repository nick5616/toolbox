"""Visualizer handlers (SPEC.md §5): song features, the mood reader, model prefetch.

CONTRACT STUB (foundation). AN1 owns viz.analyze; AN3 owns viz.mood and
viz.prefetch (the marked block below). The engine code lives in
toolbox_sidecar/viz/.
"""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("viz.analyze")
def analyze(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Features, beats, harmony, sections and pitch → <outDir>/<name>.json + .bin."""
    from ..viz import pipeline

    return pipeline.run(ctx, params)


# --- AN3: mood reader -------------------------------------------------------


@handler("viz.mood")
def mood(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Emotion, valence/energy and motifs per line (multilingual embeddings + anchors)."""
    raise HandlerError("internal", "not built yet")


@handler("viz.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """sha-verified download of the mood reader files into modelDir."""
    raise HandlerError("internal", "not built yet")


# --- end AN3 ----------------------------------------------------------------
