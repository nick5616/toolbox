"""midi handlers: audio → MIDI via Basic Pitch's bundled ONNX model (SPEC.md §4.6)."""

from __future__ import annotations

import logging
import os
from typing import Any

from ..registry import Context, HandlerError, handler


def _num(params: dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    v = params.get(key, default)
    if v is None:
        v = default
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise HandlerError("validation", f"{key} must be a number")
    if not lo <= v <= hi:
        raise HandlerError("validation", f"{key} must be between {lo:g} and {hi:g}")
    return float(v)


def _opt_hz(params: dict[str, Any], key: str) -> float | None:
    v = params.get(key)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
        raise HandlerError("validation", f"{key} must be a positive number or null")
    return float(v)


class _DropBasicPitchNoise(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage().lower()
        return not any(w in msg for w in ("tensorflow", "tflite", "coreml", "coremltools"))


def _model_path() -> str:
    import basic_pitch

    return os.path.join(os.path.dirname(basic_pitch.__file__), "saved_models", "icassp_2022", "nmp.onnx")


@handler("midi.transcribe")
def midi_transcribe(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = params.get("input")
    if not isinstance(path, str) or not path:
        raise HandlerError("validation", "input is required")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    out = params.get("outputPath")
    if not isinstance(out, str) or not out:
        raise HandlerError("validation", "outputPath is required")
    onset = _num(params, "onsetThreshold", 0.5, 0.05, 0.95)
    frame = _num(params, "frameThreshold", 0.3, 0.05, 0.95)
    min_ms = _num(params, "minNoteMs", 127.7, 10, 2000)
    min_hz = _opt_hz(params, "minHz")
    max_hz = _opt_hz(params, "maxHz")
    if min_hz is not None and max_hz is not None and min_hz >= max_hz:
        raise HandlerError("validation", "minHz must be lower than maxHz")
    melodia = params.get("melodiaTrick", True)
    if not isinstance(melodia, bool):
        raise HandlerError("validation", "melodiaTrick must be a boolean")
    if os.path.exists(out):
        raise HandlerError("validation", "Output exists", out)

    ctx.stage("Loading model")
    flt = _DropBasicPitchNoise()
    root = logging.getLogger()
    root.addFilter(flt)
    for h in root.handlers:
        h.addFilter(flt)
    try:
        from basic_pitch.inference import predict
    finally:
        root.removeFilter(flt)
        for h in root.handlers:
            h.removeFilter(flt)
    ctx.check_cancelled()

    ctx.stage("Transcribing")
    try:
        _model_out, midi_data, events = predict(
            path,
            model_or_model_path=_model_path(),
            onset_threshold=onset,
            frame_threshold=frame,
            minimum_note_length=min_ms,
            minimum_frequency=min_hz,
            maximum_frequency=max_hz,
            melodia_trick=melodia,
        )
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("tool_failed", f"Transcription failed: {e}", "Is this a valid audio file?") from e
    ctx.check_cancelled()

    ctx.stage("Writing MIDI")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    midi_data.write(out)
    ctx.output(out)

    pitches = [int(e[2]) for e in events]
    duration = float(midi_data.get_end_time()) if pitches else 0.0
    try:
        import librosa

        duration = float(librosa.get_duration(path=path))
    except Exception:
        pass
    return {
        "notes": len(events),
        "pitchRange": [min(pitches), max(pitches)] if pitches else [0, 0],
        "durationSec": round(duration, 1),
        "outputPath": out,
    }
