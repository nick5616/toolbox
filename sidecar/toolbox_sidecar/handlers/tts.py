"""Text to Speech handlers (Phase 15, T1): Kokoro through ``kokoro-onnx``.

``tts.speak`` reads a text/Markdown file and writes one 24 kHz mono wav per
chapter. It never downloads: Go passes explicit ``modelPath`` and
``voicesPath``; ``tts.prefetch`` is the only download.
"""

from __future__ import annotations

import os
import threading
from typing import Any

import numpy as np

from ..download import ensure_model, validate_model_spec
from ..registry import Context, HandlerError, handler
from ..tts import Chunk, clean_markdown, make_chunks, safe_name, split_chapters

SAMPLE_RATE = 24000
SPLITS = ("none", "headings")
LANGS = ("en-us", "en-gb", "es", "fr-fr", "hi", "it", "pt-br")
MIN_SPEED, MAX_SPEED = 0.5, 2.0
MAX_INPUT_BYTES = 8 * 1024 * 1024

_lock = threading.Lock()
_engine: dict[str, Any] = {"key": None, "obj": None}


def _load_engine(model_path: str, voices_path: str) -> Any:
    """The Kokoro instance for these files (kept between calls)."""
    key = (model_path, voices_path, os.path.getmtime(model_path), os.path.getmtime(voices_path))
    with _lock:
        if _engine["key"] == key and _engine["obj"] is not None:
            return _engine["obj"]
        try:
            from kokoro_onnx import Kokoro
        except ImportError as e:  # pragma: no cover - the dependency is locked
            raise HandlerError("tool_failed", "The speech engine isn't installed", "Update the AI engine in Settings") from e
        try:
            obj = Kokoro(model_path, voices_path)
        except Exception as e:
            raise HandlerError("tool_failed", f"Couldn't load the voice model: {e}", "Reinstall the Speech tool pack") from e
        _engine["key"], _engine["obj"] = key, obj
        return obj


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def _file(params: dict[str, Any], key: str, what: str) -> str:
    p = _str(params, key)
    if not os.path.isfile(p):
        raise HandlerError("validation", f"{what} not found", p)
    return p


def _parse(params: dict[str, Any]) -> dict[str, Any]:
    speed = params.get("speed", 1.0)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not (MIN_SPEED <= float(speed) <= MAX_SPEED):
        raise HandlerError("validation", f"speed must be between {MIN_SPEED} and {MAX_SPEED}")
    split = params.get("split", "none")
    if split not in SPLITS:
        raise HandlerError("validation", f"split must be one of {', '.join(SPLITS)}")
    lang = params.get("lang", "en-us")
    if lang not in LANGS:
        raise HandlerError("validation", f"lang must be one of {', '.join(LANGS)}")
    base = safe_name(str(params.get("baseName") or "")) or "Speech"
    return {
        "input": _file(params, "input", "Text file"),
        "outputDir": _str(params, "outputDir"),
        "baseName": base,
        "voice": _str(params, "voice"),
        "speed": float(speed),
        "lang": lang,
        "split": split,
        "modelPath": _file(params, "modelPath", "Voice model"),
        "voicesPath": _file(params, "voicesPath", "Voices file"),
    }


def read_text(path: str) -> str:
    if os.path.getsize(path) > MAX_INPUT_BYTES:
        raise HandlerError("validation", "The text file is too large (limit 8 MB)")
    with open(path, "rb") as f:
        raw = f.read()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def chapter_file_names(base: str, titles: list[str], split: bool) -> list[str]:
    """File names (without directory) for the chapters, e.g. ``Book - 03 The Sea.wav``."""
    if not split:
        return [f"{base}.wav"]
    width = max(2, len(str(len(titles))))
    out = []
    for i, t in enumerate(titles, 1):
        name = safe_name(t, 50)
        out.append(f"{base} - {i:0{width}d}{' ' + name if name else ''}.wav")
    return out


def _synth_chunk(eng: Any, chunk: Chunk, voice: str, speed: float, lang: str, ctx: Context) -> np.ndarray | None:
    try:
        audio, sr = eng.create(chunk.text, voice=voice, speed=speed, lang=lang, trim=True)
    except ValueError as e:  # nothing speakable (a lone symbol, a number the voice can't say)
        ctx.log(f"Skipped a passage: {e}", "warning")
        return None
    except Exception as e:
        raise HandlerError("tool_failed", f"Speech synthesis failed: {e}") from e
    if sr != SAMPLE_RATE:
        raise HandlerError("tool_failed", f"The voice model produced {sr} Hz audio, expected {SAMPLE_RATE}")
    return np.asarray(audio, dtype=np.float32).ravel()


@handler("tts.speak")
def speak(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    import soundfile as sf

    p = _parse(params)
    text = clean_markdown(read_text(p["input"]))
    if not text.strip():
        raise HandlerError("validation", "There's no text to read in this file")
    chapters = split_chapters(text, p["split"])
    chunked = [(ch, make_chunks(ch.text)) for ch in chapters]
    chunked = [(ch, cs) for ch, cs in chunked if cs]
    if not chunked:
        raise HandlerError("validation", "There's no text to read in this file")

    ctx.stage("Loading the voice")
    eng = _load_engine(p["modelPath"], p["voicesPath"])
    if p["voice"] not in eng.get_voices():
        raise HandlerError("validation", f"Unknown voice: {p['voice']}")
    ctx.check_cancelled()

    os.makedirs(p["outputDir"], exist_ok=True)
    names = chapter_file_names(p["baseName"], [c.title for c, _ in chunked], any(c.title for c, _ in chunked))
    total_chars = sum(c.chars for _, cs in chunked for c in cs) or 1
    done_chars = 0
    files: list[dict[str, Any]] = []
    total_seconds = 0.0
    ctx.stage("Speaking")
    for (chapter, chunks), name in zip(chunked, names):
        path = os.path.join(p["outputDir"], name)
        samples = 0
        try:
            with sf.SoundFile(path, "w", samplerate=SAMPLE_RATE, channels=1, subtype="PCM_16", format="WAV") as out:
                for chunk in chunks:
                    ctx.check_cancelled()
                    audio = _synth_chunk(eng, chunk, p["voice"], p["speed"], p["lang"], ctx)
                    if audio is not None:
                        out.write(audio)
                        samples += len(audio)
                        if chunk.pause > 0:
                            gap = int(chunk.pause / p["speed"] * SAMPLE_RATE)
                            out.write(np.zeros(gap, dtype=np.float32))
                            samples += gap
                    done_chars += chunk.chars
                    ctx.progress(done_chars / total_chars, f"Speaking {chapter.title}" if chapter.title else "Speaking")
        except BaseException:
            try:
                os.remove(path)
            except OSError:
                pass
            raise
        seconds = samples / SAMPLE_RATE
        total_seconds += seconds
        files.append({"path": path, "title": chapter.title, "seconds": round(seconds, 2), "chapter": bool(chapter.title)})
    ctx.progress(1.0, "Done", force=True)
    return {"files": files, "seconds": round(total_seconds, 2), "sampleRate": SAMPLE_RATE, "voice": p["voice"]}


@handler("tts.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads (sha256-verified) one model file without running it."""
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    path = ensure_model(ctx, model_dir, spec["file"], spec["sha256"], spec["url"])
    return {"model": spec["file"], "path": path}
