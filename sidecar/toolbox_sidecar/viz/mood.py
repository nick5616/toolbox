"""The mood reader (SPEC.md §5.4): emotion, valence/energy and motifs per line.

A small multilingual sentence-embedding model (paraphrase-multilingual-MiniLM,
ONNX, CPU) embeds each line; the line is compared with English "anchor" phrases
for 8 emotions and 12 motifs (anchors.json). Nothing here downloads anything.
"""

from __future__ import annotations

import gc
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable, Protocol, Sequence

import numpy as np

EMOTIONS = ("joy", "love", "sadness", "anger", "fear", "calm", "hope", "awe")
MOTIFS = ("fire", "rain", "snow", "stars", "ocean", "flowers", "hearts", "city", "sun", "night", "storm", "smoke")

# emotion -> (valence, energy), SPEC.md §5.4
TABLE: dict[str, tuple[float, float]] = {
    "joy": (0.8, 0.8),
    "love": (0.7, 0.4),
    "sadness": (-0.7, 0.25),
    "anger": (-0.6, 0.9),
    "fear": (-0.6, 0.7),
    "calm": (0.3, 0.15),
    "hope": (0.6, 0.5),
    "awe": (0.5, 0.6),
}

MAX_LINES = 20_000
MAX_TOKENS = 128
BATCH = 64
TOP_ANCHORS = 3
CONF_SCALE = 0.1
TEMPERATURE = 0.03
MAX_MOTIFS = 3
DEFAULT_MOTIF_THRESHOLD = 0.54
ANCHORS_PATH = Path(__file__).with_name("anchors.json")


class Encoder(Protocol):
    """Maps texts to an (n, d) float array of L2-normalised embeddings."""

    def __call__(self, texts: Sequence[str]) -> np.ndarray: ...


# --- pooling -----------------------------------------------------------------


def mean_pool(hidden: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Mean over the tokens the attention mask keeps: (n, t, d), (n, t) → (n, d)."""
    m = mask.astype(np.float32)[..., None]
    total = (hidden.astype(np.float32) * m).sum(axis=1)
    count = np.maximum(m.sum(axis=1), 1e-9)
    return total / count


def l2_normalize(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v, axis=1, keepdims=True)
    return v / np.maximum(norm, 1e-12)


def pool_and_normalize(hidden: np.ndarray, mask: np.ndarray) -> np.ndarray:
    return l2_normalize(mean_pool(hidden, mask))


# --- encoder -----------------------------------------------------------------


class OnnxEncoder:
    """tokenizers (truncate 128) + onnxruntime (CPU, 2 intra-op threads), batches of 64."""

    def __init__(self, model_path: str, tokenizer_path: str) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.tok = Tokenizer.from_file(tokenizer_path)
        self.tok.enable_truncation(MAX_TOKENS)
        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        so.inter_op_num_threads = 1
        self.session: Any = ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
        self.names = [i.name for i in self.session.get_inputs()]

    def __call__(self, texts: Sequence[str]) -> np.ndarray:
        out: list[np.ndarray] = []
        for i in range(0, len(texts), BATCH):
            enc = self.tok.encode_batch(list(texts[i : i + BATCH]))
            width = max(1, max(len(e.ids) for e in enc))
            ids = np.zeros((len(enc), width), np.int64)
            mask = np.zeros_like(ids)
            for j, e in enumerate(enc):
                n = len(e.ids)
                ids[j, :n] = e.ids
                mask[j, :n] = 1
            feeds = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.names:
                feeds["token_type_ids"] = np.zeros_like(ids)
            hidden = self.session.run(None, feeds)[0]
            out.append(pool_and_normalize(hidden, mask))
        if not out:
            return np.zeros((0, 0), np.float32)
        return np.concatenate(out).astype(np.float32)

    def close(self) -> None:
        self.session = None
        self.tok = None  # type: ignore[assignment]
        gc.collect()


# --- anchors -----------------------------------------------------------------


class Anchors:
    """The parsed anchors.json: phrases in a fixed order (emotions, then motifs)."""

    def __init__(self, raw: bytes) -> None:
        self.raw = raw
        data = json.loads(raw)
        self.emotions: dict[str, list[str]] = {k: list(data["emotions"][k]) for k in EMOTIONS}
        self.motifs: dict[str, list[str]] = {k: list(data["motifs"][k]) for k in MOTIFS}
        self.default_threshold = float(data.get("defaultThreshold", DEFAULT_MOTIF_THRESHOLD))
        th = data.get("thresholds") or {}
        self.thresholds = {k: float(th.get(k, self.default_threshold)) for k in MOTIFS}
        self.phrases: list[str] = []
        self.slices: dict[tuple[str, str], slice] = {}
        for kind, table in (("e", self.emotions), ("m", self.motifs)):
            for name, items in table.items():
                self.slices[(kind, name)] = slice(len(self.phrases), len(self.phrases) + len(items))
                self.phrases.extend(items)

    @classmethod
    def load(cls, path: Path = ANCHORS_PATH) -> "Anchors":
        return cls(path.read_bytes())


def model_fingerprint(model_path: str) -> str:
    """Identifies the model file cheaply: size plus the sha256 of its first and last MiB."""
    size = os.path.getsize(model_path)
    h = hashlib.sha256()
    with open(model_path, "rb") as f:
        h.update(f.read(1 << 20))
        if size > 2 << 20:
            f.seek(size - (1 << 20))
            h.update(f.read(1 << 20))
    return f"{size}:{h.hexdigest()}"


def cache_key(anchors_raw: bytes, fingerprint: str) -> str:
    """sha1 of anchors.json + the model's size/sha."""
    h = hashlib.sha1()
    h.update(anchors_raw)
    h.update(fingerprint.encode())
    return h.hexdigest()


def cache_file(cache_path: str) -> str:
    """The .npy file holding the anchor embeddings; a directory gets anchors.npy inside it."""
    if cache_path.lower().endswith(".npy"):
        return cache_path
    return os.path.join(cache_path, "anchors.npy")


def anchor_embeddings(anchors: Anchors, encoder: Encoder, path: str | None, key: str = "") -> np.ndarray:
    """Embeddings of every anchor phrase.

    Cached in `path` (.npy) with `key` in `<path>.key`; a missing, unreadable or
    mismatching cache is recomputed and rewritten.
    """
    n = len(anchors.phrases)
    if path and os.path.isfile(path):
        try:
            with open(path + ".key", encoding="ascii") as f:
                same = f.read().strip() == key
            arr = np.load(path)
            if same and arr.ndim == 2 and arr.shape[0] == n:
                return arr.astype(np.float32)
        except (OSError, ValueError):
            pass
    emb = np.asarray(encoder(anchors.phrases), dtype=np.float32)
    if path:
        try:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            tmp = path + ".tmp.npy"
            np.save(tmp, emb)
            os.replace(tmp, path)
            with open(path + ".key", "w", encoding="ascii") as f:
                f.write(key)
        except OSError:
            pass
    return emb


# --- reading -----------------------------------------------------------------


def has_letters(text: str) -> bool:
    return any(c.isalpha() for c in text)


def softmax(x: np.ndarray, temperature: float = TEMPERATURE) -> np.ndarray:
    z = (x - x.max()) / temperature
    e = np.exp(z)
    return e / e.sum()


def neutral() -> dict[str, Any]:
    v, e = TABLE["calm"]
    return {"emotion": "calm", "confidence": 0.0, "valence": v, "energy": e, "motifs": [], "scores": {k: 0.0 for k in EMOTIONS}}


def read_one(sim: np.ndarray, anchors: Anchors) -> dict[str, Any]:
    """One reading from a line's cosines against every anchor phrase."""
    scores = np.zeros(len(EMOTIONS), np.float32)
    for i, name in enumerate(EMOTIONS):
        c = np.sort(sim[anchors.slices[("e", name)]])[-TOP_ANCHORS:]
        scores[i] = float(c.mean())
    order = np.argsort(-scores)
    best, second = float(scores[order[0]]), float(scores[order[1]])
    confidence = float(np.clip((best - second) / CONF_SCALE, 0.0, 1.0))
    w = softmax(scores)
    valence = float(sum(w[i] * TABLE[n][0] for i, n in enumerate(EMOTIONS)))
    energy = float(sum(w[i] * TABLE[n][1] for i, n in enumerate(EMOTIONS)))
    hits: list[tuple[float, str]] = []
    for name in MOTIFS:
        c = float(sim[anchors.slices[("m", name)]].max())
        if c + 1e-6 >= anchors.thresholds[name]:  # float32 cosines vs a decimal threshold
            hits.append((c, name))
    hits.sort(reverse=True)
    return {
        "emotion": EMOTIONS[int(order[0])],
        "confidence": round(confidence, 4),
        "valence": round(valence, 4),
        "energy": round(energy, 4),
        "motifs": [n for _, n in hits[:MAX_MOTIFS]],
        "scores": {n: round(float(scores[i]), 4) for i, n in enumerate(EMOTIONS)},
    }


def read_lines(
    lines: Sequence[str],
    encoder: Encoder,
    anchors: Anchors,
    anchor_emb: np.ndarray,
    progress: Callable[[float], None] | None = None,
) -> list[dict[str, Any]]:
    """Readings for every line, in order. Letterless lines are neutral without encoding."""
    texts: dict[str, int] = {}
    for line in lines:
        if has_letters(line) and line not in texts:
            texts[line] = len(texts)
    uniq = sorted(texts, key=len)  # similar lengths batch together, less padding
    sims = np.zeros((len(uniq), len(anchors.phrases)), np.float32)
    step = BATCH * 4
    for i in range(0, len(uniq), step):
        chunk = uniq[i : i + step]
        sims[i : i + len(chunk)] = np.asarray(encoder(chunk), dtype=np.float32) @ anchor_emb.T
        if progress:
            progress(min(1.0, (i + len(chunk)) / max(1, len(uniq))))
    pos = {t: i for i, t in enumerate(uniq)}
    cache: dict[str, dict[str, Any]] = {}
    out: list[dict[str, Any]] = []
    for line in lines:
        if not has_letters(line):
            out.append(neutral())
            continue
        r = cache.get(line)
        if r is None:
            r = cache[line] = read_one(sims[pos[line]], anchors)
        out.append({**r, "motifs": list(r["motifs"]), "scores": dict(r["scores"])})
    return out


def run(
    lines: Sequence[str],
    model_path: str,
    tokenizer_path: str,
    cache_path: str | None,
    progress: Callable[[float], None] | None = None,
    encoder_factory: Callable[[str, str], Any] = OnnxEncoder,
) -> list[dict[str, Any]]:
    """The whole viz.mood job: load, embed anchors (cached), read, free the session."""
    anchors = Anchors.load()
    enc = encoder_factory(model_path, tokenizer_path)
    try:
        path = cache_file(cache_path) if cache_path else None
        key = cache_key(anchors.raw, model_fingerprint(model_path)) if path else ""
        emb = anchor_embeddings(anchors, enc, path, key)
        return read_lines(lines, enc, anchors, emb, progress)
    finally:
        close = getattr(enc, "close", None)
        if close:
            close()
        del enc
        gc.collect()
