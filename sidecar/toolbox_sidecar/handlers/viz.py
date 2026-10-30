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


def _mood_path(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


@handler("viz.mood")
def mood(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Emotion, valence/energy and motifs per line (multilingual embeddings + anchors)."""
    import os

    from ..viz import mood as reader

    lines = params.get("lines")
    if not isinstance(lines, list) or not all(isinstance(s, str) for s in lines):
        raise HandlerError("validation", "lines must be a list of strings")
    if len(lines) > reader.MAX_LINES:
        raise HandlerError("validation", f"at most {reader.MAX_LINES} lines")
    model = _mood_path(params, "modelPath")
    tokenizer = _mood_path(params, "tokenizerPath")
    for p in (model, tokenizer):
        if not os.path.isfile(p):
            raise HandlerError("tool_failed", "The mood reader is not installed", "Install it from the Components list")
    cache = params.get("anchorsCachePath")
    if cache is not None and not isinstance(cache, str):
        raise HandlerError("validation", "anchorsCachePath must be a string")

    ctx.stage("Reading the mood of the words")

    def progress(p: float) -> None:
        ctx.check_cancelled()
        ctx.progress(p, "Reading the mood of the words")

    try:
        out = reader.run(lines, model, tokenizer, cache or None, progress)
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("tool_failed", f"The mood reader failed: {e}") from e
    ctx.progress(1.0, "Reading the mood of the words", force=True)
    return {"lines": out}


class _Scaled:
    """A Context view that maps a download's 0..1 progress into [lo, hi]."""

    def __init__(self, ctx: Context, lo: float, hi: float) -> None:
        self._ctx, self._lo, self._hi = ctx, lo, hi

    def stage(self, msg: str) -> None:
        self._ctx.stage(msg)

    def check_cancelled(self) -> None:
        self._ctx.check_cancelled()

    def progress(self, pct: float, msg: str = "", *, force: bool = False) -> None:
        if pct < 0:
            self._ctx.progress(pct, msg, force=force)
            return
        self._ctx.progress(self._lo + (self._hi - self._lo) * pct, msg, force=force)


@handler("viz.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """sha-verified download of the mood reader files into modelDir."""
    from ..download import ensure_model, validate_model_spec

    model_dir = _mood_path(params, "modelDir")
    files = params.get("files")
    if not isinstance(files, list) or not files:
        raise HandlerError("validation", "files is required")
    specs = [validate_model_spec(f) for f in files]
    paths: list[str] = []
    for i, s in enumerate(specs):
        scoped = _Scaled(ctx, i / len(specs), (i + 1) / len(specs))
        paths.append(ensure_model(scoped, model_dir, s["file"], s["sha256"], s["url"]))  # type: ignore[arg-type]
    ctx.progress(1.0, "Downloading model", force=True)
    return {"files": [s["file"] for s in specs], "paths": paths}


# --- end AN3 ----------------------------------------------------------------
