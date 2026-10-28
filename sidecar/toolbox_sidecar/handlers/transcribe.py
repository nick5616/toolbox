"""transcribe handlers: speech to text via faster-whisper (Phase 3 SPEC.md §5.2)."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable
from typing import Any

from ..registry import Context, HandlerError, handler

TASKS = ("transcribe", "translate")
FORMATS = ("txt", "srt", "vtt", "json")

# Loaded models, keyed by model dir; one at a time to bound memory.
_models: dict[str, Any] = {}


# -- pure writers ---------------------------------------------------------------


def format_timestamp(seconds: float, sep: str) -> str:
    """HH:MM:SS<sep>mmm, rounded to the nearest millisecond (negative clamps to 0)."""
    ms = max(0, int(round(float(seconds) * 1000)))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def format_clock(seconds: float) -> str:
    """m:ss, or h:mm:ss from one hour up."""
    t = max(0, int(seconds))
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _cue_text(text: str) -> str:
    # A blank line would end the cue early.
    return "\n".join(line for line in (ln.strip() for ln in text.strip().splitlines()) if line)


def to_srt(segments: list[dict[str, Any]]) -> str:
    blocks = [
        f"{i}\n{format_timestamp(s['start'], ',')} --> {format_timestamp(s['end'], ',')}\n{_cue_text(s['text'])}\n"
        for i, s in enumerate(segments, 1)
    ]
    return "\n".join(blocks)


def to_vtt(segments: list[dict[str, Any]]) -> str:
    blocks = [
        f"{format_timestamp(s['start'], '.')} --> {format_timestamp(s['end'], '.')}\n{_cue_text(s['text'])}\n"
        for s in segments
    ]
    return "WEBVTT\n\n" + "\n".join(blocks)


def to_txt(segments: list[dict[str, Any]]) -> str:
    lines = [s["text"].strip() for s in segments]
    return "\n".join(lines) + "\n" if lines else ""


def to_json(language: str, duration: float, segments: list[dict[str, Any]]) -> str:
    doc = {"language": language, "duration": duration, "segments": segments}
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def unique_path(directory: str, base: str, ext: str) -> str:
    """<dir>/<base>.<ext>, or "<base> (1).<ext>", (2)… if taken (like Go's
    core.UniquePath). Never overwrites."""
    path = os.path.join(directory, f"{base}.{ext}")
    n = 0
    while os.path.exists(path):
        n += 1
        path = os.path.join(directory, f"{base} ({n}).{ext}")
    return path


def _write_new(directory: str, base: str, ext: str, content: str) -> str:
    """Writes content to a fresh unique path via a temp file; never overwrites."""
    fd, tmp = tempfile.mkstemp(prefix=".tb-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        while True:
            path = unique_path(directory, base, ext)
            try:
                os.link(tmp, path)  # fails if path appeared meanwhile
            except FileExistsError:
                continue
            except OSError:
                if os.path.exists(path):
                    continue
                os.replace(tmp, path)  # filesystem without hard links
                tmp = ""
            return path
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)


# -- helpers ---------------------------------------------------------------------


def _str_param(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def _is_download_error(e: BaseException) -> bool:
    text = f"{type(e).__name__} {e}".lower()
    return any(w in text for w in ("connection", "urlopen", "urlerror", "timed out", "resolve", "ssl", "http", "offline", "network"))


def _has_model(model_dir: str) -> bool:
    return os.path.isfile(os.path.join(model_dir, "model.bin")) and os.path.isfile(os.path.join(model_dir, "config.json"))


def _load_model(model_dir: str) -> Any:
    model = _models.get(model_dir)
    if model is None:
        _models.clear()  # free the previous model before loading another
        from faster_whisper import WhisperModel

        model = WhisperModel(model_dir, device="cpu", compute_type="int8", cpu_threads=min(8, os.cpu_count() or 4))
        _models[model_dir] = model
    return model


def _segment_dict(seg: Any, with_words: bool) -> dict[str, Any]:
    d: dict[str, Any] = {"start": round(float(seg.start), 3), "end": round(float(seg.end), 3), "text": str(seg.text).strip()}
    if with_words:
        d["words"] = [
            {"start": round(float(w.start), 3), "end": round(float(w.end), 3), "word": str(w.word)}
            for w in (getattr(seg, "words", None) or [])
        ]
    return d


def _collect(ctx: Context, segments: Iterable[Any], duration: float, with_words: bool) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    total = format_clock(duration)
    for seg in segments:
        ctx.check_cancelled()
        out.append(_segment_dict(seg, with_words))
        pct = min(1.0, max(0.0, float(seg.end) / duration)) if duration > 0 else -1
        ctx.progress(pct, f"Transcribing · {format_clock(float(seg.end))} / {total}")
    ctx.check_cancelled()
    return out


@handler("transcribe.run")
def run(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    path = _str_param(params, "input")
    if not os.path.isfile(path):
        raise HandlerError("validation", "Input file not found", path)
    out_dir = _str_param(params, "outputDir")
    repo = _str_param(params, "model")
    model_dir = _str_param(params, "modelDir")
    base = params.get("baseName") or os.path.splitext(os.path.basename(path))[0]
    if not isinstance(base, str) or not base.strip():
        raise HandlerError("validation", "baseName must be a string")
    language = params.get("language")
    if language is not None and (not isinstance(language, str) or not language.strip()):
        raise HandlerError("validation", "language must be null or a language code")
    task = params.get("task", "transcribe")
    if task not in TASKS:
        raise HandlerError("validation", "task must be transcribe or translate")
    formats = params.get("formats")
    if not isinstance(formats, list) or not formats or any(f not in FORMATS for f in formats):
        raise HandlerError("validation", "formats must be a non-empty list of txt, srt, vtt, json")
    if len(set(formats)) != len(formats):
        raise HandlerError("validation", "formats must not contain duplicates")
    vad = params.get("vad", True)
    if not isinstance(vad, bool):
        raise HandlerError("validation", "vad must be a boolean")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    try:
        if not _has_model(model_dir) and model_dir not in _models:
            ctx.stage("Downloading model")
            os.makedirs(model_dir, exist_ok=True)
            from huggingface_hub import snapshot_download

            # local_dir avoids the Windows symlink-cache duplication; the tqdm shim reports bytes.
            snapshot_download(repo, local_dir=model_dir)
            ctx.check_cancelled()
        ctx.stage("Loading model")
        model = _load_model(model_dir)
        ctx.check_cancelled()

        ctx.stage("Transcribing")
        seg_iter, info = model.transcribe(
            path, language=language or None, task=task, vad_filter=vad, word_timestamps=("json" in formats)
        )
        duration = float(getattr(info, "duration", 0.0) or 0.0)
        segs = _collect(ctx, seg_iter, duration, "json" in formats)
    except HandlerError:
        raise
    except Exception as e:
        if _is_download_error(e) and not _has_model(model_dir):
            raise HandlerError("tool_failed", f"Model download failed: {e}", "Check your connection") from e
        raise HandlerError("tool_failed", f"Transcription failed: {e}", "Check the file and try again") from e

    detected = str(getattr(info, "language", "") or language or "und")
    probability = float(getattr(info, "language_probability", 0.0) or 0.0)

    renderers = {
        "txt": lambda: to_txt(segs),
        "srt": lambda: to_srt(segs),
        "vtt": lambda: to_vtt(segs),
        "json": lambda: to_json(detected, duration, segs),
    }
    outputs: list[str] = []
    for fmt in formats:
        ctx.check_cancelled()
        p = _write_new(out_dir, base, fmt, renderers[fmt]())
        outputs.append(p)
        ctx.output(p)
    words = sum(len(s.get("words", [])) for s in segs)
    return {
        "language": detected,
        "languageProbability": probability,
        "durationSec": duration,
        "segments": len(segs),
        "words": words,
        "outputs": outputs,
    }


@handler("transcribe.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads a Whisper model snapshot without transcribing (tool packs, SPEC §7.8)."""
    repo = _str_param(params, "model")
    model_dir = _str_param(params, "modelDir")
    if _has_model(model_dir):
        return {"modelDir": model_dir, "downloaded": False}
    try:
        ctx.stage("Downloading model")
        os.makedirs(model_dir, exist_ok=True)
        from huggingface_hub import snapshot_download

        snapshot_download(repo, local_dir=model_dir)
        ctx.check_cancelled()
    except HandlerError:
        raise
    except Exception as e:
        if _is_download_error(e):
            raise HandlerError("tool_failed", f"Model download failed: {e}", "Check your connection") from e
        raise HandlerError("tool_failed", f"Couldn't download the model: {e}", "Try again") from e
    if not _has_model(model_dir):
        raise HandlerError("tool_failed", "The model download was incomplete", "Try again")
    return {"modelDir": model_dir, "downloaded": True}
