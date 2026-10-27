"""stems handlers: source separation via audio-separator (SPEC.md §4.6)."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from ..registry import Context, HandlerError, handler

FORMATS = ("wav", "flac", "mp3")

#: Stem names models are known to emit (matched case-insensitively by audio-separator).
KNOWN_STEMS = (
    "vocals", "instrumental", "drums", "bass", "other", "guitar", "piano",
    "no_vocals", "no vocals", "no_drums", "no_bass", "no_other", "no_guitar", "no_piano",
    "synthesizer", "strings", "woodwinds", "brass", "wind inst", "lead vocals", "backing vocals",
    "male", "female", "reverb", "no reverb", "echo", "no echo", "noise", "no noise",
    "dry", "crowd", "kick", "snare", "toms", "hh", "ride", "crash", "karaoke",
)

# (model, outputFormat, outputDir) → Separator; one at a time to bound memory.
_state: dict[str, Any] = {"key": None, "sep": None}


def _models_dir() -> str:
    root = os.environ.get("TOOLBOX_MODELS_DIR")
    if not root:
        raise HandlerError("tool_failed", "TOOLBOX_MODELS_DIR isn't set", "Reinstall the audio engine")
    path = os.path.join(root, "audio-separator")
    os.makedirs(path, exist_ok=True)
    return path


def _title(stem: str) -> str:
    return stem.replace("_", " ").strip().title()


def _is_download_error(e: BaseException) -> bool:
    text = f"{type(e).__name__} {e}".lower()
    return any(w in text for w in ("download", "connection", "urlopen", "urlerror", "timed out", "resolve", "ssl", "http"))


def _new_separator(fmt: str, out_dir: str) -> Any:
    import gc

    gc.collect()
    from audio_separator.separator import Separator

    return Separator(
        model_file_dir=_models_dir(),
        output_dir=out_dir,
        output_format=fmt.upper(),
        log_level=logging.WARNING,
    )


@handler("stems.separate")
def stems_separate(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = params.get("input")
    if not isinstance(path, str) or not path:
        raise HandlerError("validation", "input is required")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    out_dir = params.get("outputDir")
    if not isinstance(out_dir, str) or not out_dir:
        raise HandlerError("validation", "outputDir is required")
    model = params.get("model")
    if not isinstance(model, str) or not model.strip():
        raise HandlerError("validation", "model is required")
    fmt = params.get("outputFormat", "wav")
    if fmt not in FORMATS:
        raise HandlerError("validation", "outputFormat must be wav, flac or mp3")
    base = params.get("baseName") or os.path.splitext(os.path.basename(path))[0]
    if not isinstance(base, str):
        raise HandlerError("validation", "baseName must be a string")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    models_dir = _models_dir()

    key = (model, fmt, out_dir)
    try:
        if _state["key"] != key or _state["sep"] is None:
            # Importing torch/audio-separator and probing hardware takes seconds.
            ctx.stage("Preparing")
            _state.update(key=None, sep=None)
            sep = _new_separator(fmt, out_dir)
            present = os.path.exists(os.path.join(models_dir, model))
            ctx.stage("Loading model" if present else "Downloading model")
            # audio-separator downloads inside load_model; the tqdm shim reports its progress.
            sep.load_model(model_filename=model)
            _state.update(key=key, sep=sep)
        sep = _state["sep"]
        ctx.check_cancelled()

        ctx.stage("Separating")
        names = {s: f"{base} - {_title(s)}" for s in KNOWN_STEMS}
        files = sep.separate(path, custom_output_names=names)
    except HandlerError:
        raise
    except Exception as e:
        _state.update(key=None, sep=None)
        if _is_download_error(e):
            raise HandlerError("tool_failed", f"Model download failed: {e}", "Check your connection") from e
        raise HandlerError("tool_failed", f"Separation failed: {e}", "Check the model name and try again") from e

    stems: list[dict[str, str]] = []
    for f in files:
        full = os.path.abspath(f if os.path.isabs(f) else os.path.join(out_dir, f))
        if not os.path.isfile(full):
            continue
        stem = os.path.splitext(os.path.basename(full))[0]
        m = re.search(r"_\((.+?)\)_", stem)
        name = m.group(1) if m else stem.rsplit(" - ", 1)[-1]
        stems.append({"name": _title(name), "path": full})
        ctx.output(full)
    if not stems:
        raise HandlerError("tool_failed", "The model produced no output files")
    return {"stems": stems, "model": model}
