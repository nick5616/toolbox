"""search handlers: Smart search's image/text embeddings (Phase 20 SPEC.md §2.6/§3.8).

Methods and params are frozen:

- search.prefetch {files: [{path, url, sha256, bytes}], modelDir}
    downloads and verifies every file into modelDir/<path> (download.ensure_model).
- search.embed_images {modelDir, paths: [str], threads: int}
    -> {dim: int, vectors: [base64 float16 LE, L2-normalised]} in input order;
    an unreadable picture gives "" at its index plus a log line.
- search.embed_text {modelDir, texts: [str]}
    -> {dim: int, vectors: [base64 float16 LE, L2-normalised]}.

The model is SigLIP 2 ViT-B/16 (224 px) exported to ONNX; the visual session stays
resident, the (large) text session is dropped after TEXT_IDLE_SECONDS unused.
"""

from __future__ import annotations

import base64
import os
import string
import threading
import time
from typing import Any

import numpy as np

from ..download import ensure_model, validate_model_spec
from ..registry import Context, HandlerError, handler

IMAGE_SIZE = 224
CONTEXT = 64
EOS_ID = 1
PAD_ID = 0
IMAGE_BATCH = 16
TEXT_BATCH = 64
TEXT_IDLE_SECONDS = 300.0

_clock = time.monotonic  # tests replace it

_lock = threading.RLock()
# Resident visual session: (modelDir, session).
_visual: tuple[str, Any] | None = None
# Text side: (modelDir, session, tokenizer); _text_used is the clock reading of the last use.
_text: tuple[str, Any, Any] | None = None
_text_used = 0.0
_timer: threading.Timer | None = None


# -- sessions ----------------------------------------------------------------------


def _make_session(path: str, threads: int) -> Any:
    """Creates a CPU onnxruntime session (tests monkeypatch this)."""
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, int(threads))
    return ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])


def _default_threads() -> int:
    return max(1, (os.cpu_count() or 2) // 2)


def _model_file(model_dir: Any, rel: str) -> str:
    if not isinstance(model_dir, str) or not model_dir:
        raise HandlerError("validation", "modelDir is required")
    path = os.path.join(model_dir, *rel.split("/"))
    if not os.path.isfile(path):
        raise HandlerError(
            "dependency_missing",
            "The Smart search model isn't downloaded",
            "Install the Smart search model first",
        )
    return path


def _visual_session(model_dir: str, threads: int) -> Any:
    global _visual
    with _lock:
        if _visual is None or _visual[0] != model_dir:
            _visual = None  # release the old one before building the new one
            _visual = (model_dir, _make_session(_model_file(model_dir, "visual/model.onnx"), threads))
        return _visual[1]


def _text_parts(model_dir: str) -> tuple[Any, Any]:
    """Returns (session, tokenizer), loading them on first use and after an idle drop."""
    global _text, _text_used
    with _lock:
        drop_idle_text()
        if _text is None or _text[0] != model_dir:
            from tokenizers import Tokenizer

            _text = None
            tok = Tokenizer.from_file(_model_file(model_dir, "textual/tokenizer.json"))
            tok.no_padding()
            tok.no_truncation()
            sess = _make_session(_model_file(model_dir, "textual/model.onnx"), _default_threads())
            _text = (model_dir, sess, tok)
        _text_used = _clock()
        _arm_timer()
        return _text[1], _text[2]


def drop_idle_text() -> bool:
    """Drops the text session when it has been unused for TEXT_IDLE_SECONDS."""
    global _text
    with _lock:
        if _text is not None and _clock() - _text_used >= TEXT_IDLE_SECONDS:
            _text = None
            return True
        return False


def _arm_timer() -> None:
    global _timer
    if _timer is not None:
        _timer.cancel()

    def fire() -> None:
        with _lock:
            if _text is not None and not drop_idle_text():
                _arm_timer()

    _timer = threading.Timer(TEXT_IDLE_SECONDS + 1.0, fire)
    _timer.daemon = True
    _timer.start()


def reset() -> None:
    """Drops every session (tests)."""
    global _visual, _text, _timer
    with _lock:
        _visual = None
        _text = None
        if _timer is not None:
            _timer.cancel()
            _timer = None


# -- pure functions ----------------------------------------------------------------

_PUNCT = str.maketrans("", "", string.punctuation)


def clean_text(text: str) -> str:
    """open_clip's canonicalize: '_' -> space, drop ASCII punctuation, lowercase, collapse spaces."""
    t = text.replace("_", " ").translate(_PUNCT).lower()
    return " ".join(t.split())


def token_ids(tokenizer: Any, text: str) -> list[int]:
    """Cleaned text -> ids ending in <eos>, truncated (eos kept) / right-padded with 0 to CONTEXT."""
    ids = list(tokenizer.encode(clean_text(text)).ids)
    if not ids or ids[-1] != EOS_ID:
        ids.append(EOS_ID)
    if len(ids) > CONTEXT:
        ids = ids[: CONTEXT - 1] + [EOS_ID]
    return ids + [PAD_ID] * (CONTEXT - len(ids))


def preprocess(im: Any) -> np.ndarray:
    """PIL image -> float32 CHW (3, 224, 224): RGB, squashed bicubic, (x/255 - 0.5) / 0.5."""
    from PIL import Image

    x = np.asarray(im.convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE), Image.BICUBIC), dtype=np.float32)
    x = (x / 255.0 - 0.5) / 0.5
    return np.ascontiguousarray(x.transpose(2, 0, 1), dtype=np.float32)


def encode_vectors(rows: np.ndarray) -> list[str]:
    """(N, dim) -> L2-normalised float16 little-endian, base64 each."""
    rows = np.asarray(rows, dtype=np.float32).reshape(len(rows), -1)
    norms = np.maximum(np.linalg.norm(rows, axis=1, keepdims=True), 1e-12)
    half = (rows / norms).astype("<f2")
    return [base64.b64encode(half[i].tobytes()).decode("ascii") for i in range(len(half))]


def _load_image(path: str) -> Any:
    from PIL import Image, ImageOps

    from ..imageio import register_heif

    try:
        register_heif()
    except Exception:  # no HEIF support just means HEIC files are unreadable
        pass
    with Image.open(path) as im:
        im.load()
        return ImageOps.exif_transpose(im).convert("RGB")


def _first_output(session: Any, feeds: dict[str, np.ndarray]) -> np.ndarray:
    out = session.run([session.get_outputs()[0].name], feeds)
    return np.asarray(out[0], dtype=np.float32)


def _strings(params: dict[str, Any], key: str) -> list[str]:
    v = params.get(key)
    if not isinstance(v, list) or not all(isinstance(s, str) for s in v):
        raise HandlerError("validation", f"{key} must be a list of strings")
    return v


# -- handlers ----------------------------------------------------------------------


class _Scoped:
    """A Context view mapping each download's 0..1 progress into the overall bar."""

    def __init__(self, ctx: Context) -> None:
        self._ctx = ctx
        self.base = 0.0
        self.span = 1.0
        self.label = "Downloading model"

    def check_cancelled(self) -> None:
        self._ctx.check_cancelled()

    def stage(self, msg: str) -> None:
        self._ctx.progress(self.base, self.label, force=True)

    def progress(self, pct: float, msg: str = "", *, force: bool = False) -> None:
        frac = self.base if pct < 0 else self.base + min(max(pct, 0.0), 1.0) * self.span
        self._ctx.progress(frac, self.label, force=force)

    def log(self, line: str, level: str = "info") -> None:
        self._ctx.log(line, level)


@handler("search.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    model_dir = params.get("modelDir")
    if not isinstance(model_dir, str) or not model_dir.strip():
        raise HandlerError("validation", "modelDir is required")
    files = params.get("files")
    if not isinstance(files, list) or not files:
        raise HandlerError("validation", "files is required")
    plan: list[tuple[list[str], dict[str, str], int]] = []
    for f in files:
        if not isinstance(f, dict):
            raise HandlerError("validation", "each file needs path, url, sha256 and bytes")
        rel = f.get("path")
        parts = rel.split("/") if isinstance(rel, str) else []
        if not parts or any(p in ("", ".", "..") or "\\" in p or ":" in p for p in parts):
            raise HandlerError("validation", "file.path must be a relative path using '/'")
        spec = validate_model_spec({"file": parts[-1], "sha256": f.get("sha256"), "url": f.get("url")})
        size = f.get("bytes")
        plan.append((parts, spec, size if isinstance(size, int) and size > 0 else 1))
    total = sum(s for _, _, s in plan)
    scoped = _Scoped(ctx)
    done = 0
    for i, (parts, spec, size) in enumerate(plan):
        ctx.check_cancelled()
        scoped.base, scoped.span = done / total, size / total
        scoped.label = f"Downloading model ({i + 1}/{len(plan)})"
        folder = os.path.join(model_dir, *parts[:-1])
        ensure_model(scoped, folder, spec["file"], spec["sha256"], spec["url"])  # type: ignore[arg-type]
        done += size
        ctx.progress(done / total, scoped.label, force=True)
    return {"dir": model_dir}


@handler("search.embed_images")
def embed_images(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    model_dir = params.get("modelDir")
    paths = _strings(params, "paths")
    threads = params.get("threads")
    threads = threads if isinstance(threads, int) and threads > 0 else _default_threads()
    session = _visual_session(model_dir, threads)  # type: ignore[arg-type]
    in_name = session.get_inputs()[0].name
    vectors: list[str] = [""] * len(paths)
    dim = 0
    total = len(paths)
    done = 0
    for start in range(0, total, IMAGE_BATCH):
        ctx.check_cancelled()
        idx: list[int] = []
        batch: list[np.ndarray] = []
        for i in range(start, min(start + IMAGE_BATCH, total)):
            try:
                batch.append(preprocess(_load_image(paths[i])))
                idx.append(i)
            except Exception as e:
                ctx.log(f"Couldn't read {os.path.basename(paths[i])}: {e}", "warning")
        if batch:
            out = _first_output(session, {in_name: np.stack(batch)})
            enc = encode_vectors(out)
            dim = out.reshape(len(batch), -1).shape[1]
            for i, v in zip(idx, enc):
                vectors[i] = v
        done += min(IMAGE_BATCH, total - start)
        ctx.progress(done / total if total else 1.0, f"Reading pictures ({done}/{total})")
    return {"dim": dim, "vectors": vectors}


@handler("search.embed_text")
def embed_text(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    model_dir = params.get("modelDir")
    texts = _strings(params, "texts")
    if not texts:
        return {"dim": 0, "vectors": []}
    session, tok = _text_parts(model_dir)  # type: ignore[arg-type]
    in_name = session.get_inputs()[0].name
    vectors: list[str] = []
    dim = 0
    for start in range(0, len(texts), TEXT_BATCH):
        ctx.check_cancelled()
        ids = np.array([token_ids(tok, t) for t in texts[start : start + TEXT_BATCH]], dtype=np.int64)
        out = _first_output(session, {in_name: ids})
        dim = out.reshape(len(ids), -1).shape[1]
        vectors.extend(encode_vectors(out))
    with _lock:
        global _text_used
        _text_used = _clock()
    return {"dim": dim, "vectors": vectors}
