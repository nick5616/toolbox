"""viz.mood: the mood reader. Unit tests use a fake encoder; the accuracy test needs the model."""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import time
from pathlib import Path

import numpy as np
import pytest

from toolbox_sidecar.handlers import viz
from toolbox_sidecar.registry import HANDLERS, HandlerError
from toolbox_sidecar.viz import mood

DATA = Path(__file__).parent / "data" / "mood_lines.json"
DIM = 16


class FakeEncoder:
    """Deterministic embeddings: each text hashes to a unit vector."""

    def __init__(self, *_: object) -> None:
        self.calls: list[list[str]] = []
        self.closed = False

    def __call__(self, texts):
        self.calls.append(list(texts))
        out = np.zeros((len(texts), DIM), np.float32)
        for i, t in enumerate(texts):
            seed = int.from_bytes(hashlib.sha1(t.encode()).digest()[:4], "little")
            out[i] = np.random.default_rng(seed).normal(size=DIM)
        return mood.l2_normalize(out)

    def close(self) -> None:
        self.closed = True


# -- pooling ------------------------------------------------------------------


def test_mean_pool_respects_mask():
    hidden = np.array([[[1.0, 0.0], [3.0, 0.0], [100.0, 100.0]]], np.float32)
    mask = np.array([[1, 1, 0]])
    assert mood.mean_pool(hidden, mask).tolist() == [[2.0, 0.0]]


def test_pool_and_normalize_is_unit_length():
    rng = np.random.default_rng(1)
    hidden = rng.normal(size=(5, 7, 12)).astype(np.float32)
    mask = (rng.random((5, 7)) > 0.3).astype(np.int64)
    mask[:, 0] = 1
    v = mood.pool_and_normalize(hidden, mask)
    assert np.allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-5)


# -- anchors and cache ----------------------------------------------------------


def test_anchors_json_shape():
    a = mood.Anchors.load()
    assert list(a.emotions) == list(mood.EMOTIONS)
    assert list(a.motifs) == list(mood.MOTIFS)
    assert all(1 <= len(v) <= 12 for v in a.emotions.values())
    assert all(1 <= len(v) <= 6 for v in a.motifs.values())
    assert len(a.phrases) == sum(map(len, a.emotions.values())) + sum(map(len, a.motifs.values()))


def test_cache_key_depends_on_anchors_and_model():
    k = mood.cache_key(b"{}", "1:abc")
    assert k == hashlib.sha1(b"{}1:abc").hexdigest()
    assert mood.cache_key(b"{ }", "1:abc") != k
    assert mood.cache_key(b"{}", "2:abc") != k


def test_model_fingerprint_changes_with_content(tmp_path):
    a = tmp_path / "a.onnx"
    b = tmp_path / "b.onnx"
    a.write_bytes(b"x" * (3 << 20))
    b.write_bytes(b"y" * (3 << 20))
    assert mood.model_fingerprint(str(a)) != mood.model_fingerprint(str(b))
    assert mood.model_fingerprint(str(a)).startswith(str(3 << 20))


def test_cache_file_naming(tmp_path):
    d = str(tmp_path)
    assert mood.cache_file(d, "k") == os.path.join(d, "anchors-k.npy")
    assert mood.cache_file(os.path.join(d, "whatever.npy"), "k") == os.path.join(d, "anchors-k.npy")


def test_anchor_embeddings_cached(tmp_path):
    a = mood.Anchors.load()
    path = str(tmp_path / "sub" / "anchors-x.npy")
    enc = FakeEncoder()
    first = mood.anchor_embeddings(a, enc, path)
    assert os.path.isfile(path) and len(enc.calls) == 1
    second = mood.anchor_embeddings(a, enc, path)
    assert len(enc.calls) == 1  # served from the cache
    assert np.allclose(first, second)
    Path(path).write_bytes(b"garbage")  # a corrupt cache is recomputed
    mood.anchor_embeddings(a, enc, path)
    assert len(enc.calls) == 2


# -- reading --------------------------------------------------------------------


def test_softmax_temperature_and_table():
    w = mood.softmax(np.array([0.5, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]))
    assert w.sum() == pytest.approx(1.0)
    assert w[0] > 0.99  # 0.3 gap at T=0.03 is decisive
    flat = mood.softmax(np.zeros(8))
    assert np.allclose(flat, 1 / 8)


def _sim_for(anchors: mood.Anchors, emotion: str, level: float = 0.8) -> np.ndarray:
    sim = np.full(len(anchors.phrases), 0.1, np.float32)
    sim[anchors.slices[("e", emotion)]] = level
    return sim


@pytest.mark.parametrize("emotion", mood.EMOTIONS)
def test_read_one_each_emotion(emotion):
    a = mood.Anchors.load()
    r = mood.read_one(_sim_for(a, emotion), a)
    assert r["emotion"] == emotion
    assert r["confidence"] == 1.0
    assert r["valence"] == pytest.approx(mood.TABLE[emotion][0], abs=0.01)
    assert r["energy"] == pytest.approx(mood.TABLE[emotion][1], abs=0.01)
    assert set(r["scores"]) == set(mood.EMOTIONS)


def test_confidence_is_margin_over_tenth():
    a = mood.Anchors.load()
    sim = _sim_for(a, "joy", 0.5)
    sim[a.slices[("e", "love")]] = 0.45
    r = mood.read_one(sim, a)
    assert r["emotion"] == "joy"
    assert r["confidence"] == pytest.approx(0.5, abs=0.01)


def test_top3_mean_per_emotion():
    a = mood.Anchors.load()
    sim = np.zeros(len(a.phrases), np.float32)
    s = a.slices[("e", "joy")]
    sim[s.start : s.start + 3] = [0.9, 0.6, 0.3]
    sim[s.start + 3 :s.stop] = 0.0
    r = mood.read_one(sim, a)
    assert r["scores"]["joy"] == pytest.approx(0.6, abs=1e-3)


def test_motif_threshold_and_top3():
    a = mood.Anchors.load()
    sim = _sim_for(a, "calm", 0.3)
    levels = {"fire": 0.9, "rain": 0.8, "snow": 0.7, "stars": 0.6, "ocean": 0.2}
    for name, v in levels.items():
        sim[a.slices[("m", name)]] = v
    r = mood.read_one(sim, a)
    assert r["motifs"] == ["fire", "rain", "snow"]  # best first, at most 3
    sim2 = _sim_for(a, "calm", 0.3)
    sim2[a.slices[("m", "sun")]] = a.thresholds["sun"] - 0.01
    assert mood.read_one(sim2, a)["motifs"] == []
    sim2[a.slices[("m", "sun")]] = a.thresholds["sun"]
    assert mood.read_one(sim2, a)["motifs"] == ["sun"]


@pytest.mark.parametrize("text", ["", "   ", "♪", "♪ ♪ ♪", "(...)", "123 456", "---"])
def test_letterless_lines_are_neutral(text):
    a = mood.Anchors.load()
    enc = FakeEncoder()
    out = mood.read_lines([text], enc, a, enc(a.phrases))
    assert out[0]["emotion"] == "calm" and out[0]["confidence"] == 0
    assert out[0]["motifs"] == []
    assert len(enc.calls) == 1  # only the anchors were encoded


def test_read_lines_order_duplicates_and_mix():
    a = mood.Anchors.load()
    enc = FakeEncoder()
    emb = enc(a.phrases)
    lines = ["hello world", "♪", "hello world", "another one", ""]
    out = mood.read_lines(lines, enc, a, emb)
    assert len(out) == 5
    assert out[0] == out[2]
    assert out[0] is not out[2] and out[0]["motifs"] is not out[2]["motifs"]
    assert out[1]["confidence"] == 0 and out[4]["confidence"] == 0
    encoded = [t for call in enc.calls[1:] for t in call]
    assert sorted(encoded) == ["another one", "hello world"]  # unique letter lines only


def test_run_frees_encoder_and_writes_cache(tmp_path):
    model = tmp_path / "model.onnx"
    model.write_bytes(b"m" * 100)
    made: list[FakeEncoder] = []

    def factory(*args):
        e = FakeEncoder(*args)
        made.append(e)
        return e

    cache = str(tmp_path / "cache")
    out = mood.run(["x y z", "♪"], str(model), "tok.json", cache, encoder_factory=factory)
    assert len(out) == 2 and made[0].closed
    files = glob.glob(os.path.join(cache, "anchors-*.npy"))
    assert len(files) == 1 and re.fullmatch(r"anchors-[0-9a-f]{40}\.npy", os.path.basename(files[0]))
    mood.run(["x y z"], str(model), "tok.json", cache, encoder_factory=factory)
    assert len(made[1].calls) == 1  # anchors came from the cache: only the line is encoded


# -- handlers -------------------------------------------------------------------


def test_handlers_registered():
    assert "viz.mood" in HANDLERS and "viz.prefetch" in HANDLERS


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"lines": "nope", "modelPath": "a", "tokenizerPath": "b"},
        {"lines": [1], "modelPath": "a", "tokenizerPath": "b"},
        {"lines": [], "tokenizerPath": "b"},
        {"lines": [""] * (mood.MAX_LINES + 1), "modelPath": "a", "tokenizerPath": "b"},
    ],
)
def test_mood_validates(cap, params):
    with pytest.raises(HandlerError) as e:
        viz.mood(cap.ctx, params)
    assert e.value.code == "validation"


def test_mood_missing_model(cap, tmp_path):
    with pytest.raises(HandlerError) as e:
        viz.mood(cap.ctx, {"lines": ["a"], "modelPath": str(tmp_path / "no"), "tokenizerPath": str(tmp_path / "no2")})
    assert e.value.code == "tool_failed"


def test_mood_handler_result(cap, tmp_path, monkeypatch):
    model = tmp_path / "m.onnx"
    tok = tmp_path / "t.json"
    model.write_bytes(b"1")
    tok.write_bytes(b"2")
    monkeypatch.setattr(mood, "OnnxEncoder", FakeEncoder)
    real_run = mood.run
    monkeypatch.setattr(mood, "run", lambda *a, **k: real_run(*a, **{**k, "encoder_factory": FakeEncoder}))
    res = viz.mood(cap.ctx, {"lines": ["la la la", "♪"], "modelPath": str(model), "tokenizerPath": str(tok), "anchorsCachePath": str(tmp_path)})
    assert [set(x) for x in res["lines"]] == [{"emotion", "confidence", "valence", "energy", "motifs", "scores"}] * 2
    json.dumps(res)


@pytest.mark.parametrize(
    "params",
    [
        {"modelDir": "d"},
        {"modelDir": "d", "files": []},
        {"modelDir": "d", "files": [{"file": "../x", "sha256": "0" * 64, "url": "u"}]},
        {"modelDir": "d", "files": [{"file": "x", "sha256": "bad", "url": "u"}]},
        {"files": [{"file": "x", "sha256": "0" * 64, "url": "u"}]},
    ],
)
def test_prefetch_validates(cap, params):
    with pytest.raises(HandlerError) as e:
        viz.prefetch(cap.ctx, params)
    assert e.value.code == "validation"


def test_prefetch_downloads_each_file(cap, tmp_path, monkeypatch):
    import toolbox_sidecar.download as dl

    got = []

    def fake(ctx, model_dir, file, sha, url):
        got.append((model_dir, file))
        ctx.progress(0.5, "x")
        return os.path.join(model_dir, file)

    monkeypatch.setattr(dl, "ensure_model", fake)
    files = [{"file": "a.onnx", "sha256": "a" * 64, "url": "u1"}, {"file": "tokenizer.json", "sha256": "b" * 64, "url": "u2"}]
    res = viz.prefetch(cap.ctx, {"modelDir": str(tmp_path), "files": files})
    assert [f for _, f in got] == ["a.onnx", "tokenizer.json"]
    assert res["files"] == ["a.onnx", "tokenizer.json"]


# -- accuracy (needs the model) ----------------------------------------------------


def _model_files() -> tuple[str, str] | None:
    d = os.environ.get("TOOLBOX_MOOD_MODEL_DIR")
    if d:
        models = sorted(glob.glob(os.path.join(d, "model*.onnx")))
        tok = os.path.join(d, "tokenizer.json")
        if models and os.path.isfile(tok):
            return models[0], tok
        return None
    if os.environ.get("TOOLBOX_SLOW") == "1":
        import platform
        import sys

        from toolbox_sidecar.download import ensure_model

        rev = "https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/e8f8c211226b894fcb81acc59f3b34ba3efd5f42/"
        arm = sys.platform == "darwin" and platform.machine() == "arm64"
        model = (
            ("model_qint8_arm64.onnx", "783fea82d71a58179b830a4dbd2d58447e640609e98eedf9ffa12622d375a672", rev + "onnx/model_qint8_arm64.onnx")
            if arm
            else ("model_quint8_avx2.onnx", "98a01d88b7de996cdea58c32ca71208c09968d143798814b2ea09d3439dc334f", rev + "onnx/model_quint8_avx2.onnx")
        )
        tok = ("tokenizer.json", "2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8", rev + "tokenizer.json")
        dest = os.environ.get("TOOLBOX_MOOD_DOWNLOAD_DIR") or str(Path(__file__).parents[2] / ".dev" / "mood-test-models")

        class _Ctx:
            def stage(self, *_): ...
            def progress(self, *_, **__): ...
            def check_cancelled(self): ...

        return (
            ensure_model(_Ctx(), dest, model[0], model[1], model[2]),  # type: ignore[arg-type]
            ensure_model(_Ctx(), dest, tok[0], tok[1], tok[2]),  # type: ignore[arg-type]
        )
    return None


def test_labelled_set_is_valid():
    rows = json.loads(DATA.read_text(encoding="utf-8"))
    a = mood.Anchors.load()
    assert len(rows) >= 120
    non_en = [r for r in rows if r["lang"] != "en"]
    assert len(non_en) >= 25 and len({r["lang"] for r in non_en}) >= 5
    anchors = {p.casefold() for p in a.phrases}
    for r in rows:
        assert r["emotion"] in mood.EMOTIONS and set(r["motifs"]) <= set(mood.MOTIFS)
        assert r["text"].casefold() not in anchors
    assert len({r["text"] for r in rows}) == len(rows)


def _evaluate(rows, model, tok, tmp_path):
    t0 = time.perf_counter()
    got = mood.run([r["text"] for r in rows], model, tok, str(tmp_path))
    return got, time.perf_counter() - t0


def test_accuracy_with_model(tmp_path):
    files = _model_files()
    if files is None:
        pytest.skip("mood model not present (set TOOLBOX_MOOD_MODEL_DIR or TOOLBOX_SLOW=1)")
    rows = json.loads(DATA.read_text(encoding="utf-8"))
    got, dt = _evaluate(rows, files[0], files[1], tmp_path)
    ok = [g["emotion"] == r["emotion"] for g, r in zip(got, rows)]
    non_en = [o for o, r in zip(ok, rows) if r["lang"] != "en"]
    acc, acc_ne = sum(ok) / len(ok), sum(non_en) / len(non_en)
    tp = fp = fn = 0
    for g, r in zip(got, rows):
        want, have = set(r["motifs"]), set(g["motifs"])
        tp += len(want & have)
        fp += len(have - want)
        fn += len(want - have)
    prec, rec = tp / max(1, tp + fp), tp / max(1, tp + fn)
    print(f"\nmood: emotion {acc:.3f} non-en {acc_ne:.3f} motif P {prec:.3f} R {rec:.3f} ({dt * 1000 / len(rows):.1f} ms/line incl. load)")
    assert acc >= 0.75
    assert acc_ne >= 0.6
    assert prec >= 0.8
    assert rec >= 0.5
    # a second call reuses the cached anchors and gives close answers (the model is
    # dynamically quantised, so batch composition shifts scores slightly)
    again = mood.run([r["text"] for r in rows[:10]], files[0], files[1], str(tmp_path))
    for g, h in zip(got[:10], again):
        assert all(abs(g["scores"][k] - h["scores"][k]) < 0.1 for k in mood.EMOTIONS)
