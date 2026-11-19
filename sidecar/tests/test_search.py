"""search.* handlers: preprocessing, embeddings (fake sessions), tokenizing, prefetch."""

from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from toolbox_sidecar.handlers import search
from toolbox_sidecar.registry import HANDLERS, Cancelled, HandlerError

DIM = 8


class FakeSession:
    """Fake onnxruntime session. Visual: projects the per-image pixel mean. Text: ids."""

    def __init__(self, kind: str, threads: int = 1) -> None:
        self.kind = kind
        self.threads = threads
        self.calls: list[np.ndarray] = []

    def get_inputs(self):
        return [SimpleNamespace(name="pixel_values" if self.kind == "visual" else "input_ids")]

    def get_outputs(self):
        return [SimpleNamespace(name="emb"), SimpleNamespace(name="other")]

    def run(self, names, feeds):
        assert names == ["emb"]
        (x,) = feeds.values()
        self.calls.append(x)
        n = len(x)
        if self.kind == "visual":
            assert x.dtype == np.float32 and x.shape[1:] == (3, 224, 224)
            mean = x.reshape(n, 3, -1).mean(axis=2)  # (n, 3)
            w = np.arange(1, 3 * DIM + 1, dtype=np.float32).reshape(3, DIM)
            return [mean @ w + 0.01]
        assert x.dtype == np.int64 and x.shape[1:] == (64,)
        w = np.arange(1, 64 * DIM + 1, dtype=np.float32).reshape(64, DIM) / 100
        return [x.astype(np.float32) @ w + 1.0]


@pytest.fixture(autouse=True)
def _fresh():
    search.reset()
    yield
    search.reset()


@pytest.fixture
def sessions(monkeypatch):
    made: list[tuple[str, FakeSession]] = []

    def make(path, threads):
        s = FakeSession("visual" if "visual" in Path(path).parts else "text", threads)
        made.append((path, s))
        return s

    monkeypatch.setattr(search, "_make_session", make)
    return made


@pytest.fixture
def model_dir(tmp_path):
    d = tmp_path / "model"
    (d / "visual").mkdir(parents=True)
    (d / "textual").mkdir()
    (d / "visual" / "model.onnx").write_bytes(b"x")
    (d / "textual" / "model.onnx").write_bytes(b"x")
    _write_toy_tokenizer(d / "textual" / "tokenizer.json")
    return str(d)


def _write_toy_tokenizer(path: Path) -> None:
    """A WordLevel toy: <pad>=0 <eos>=1 <unk>=2, then words; appends <eos> like the real one."""
    from tokenizers import Tokenizer, models, pre_tokenizers, processors

    vocab = {"<pad>": 0, "<eos>": 1, "<unk>": 2}
    for w in "a photo of an apple dog cat red blue the".split():
        vocab[w] = len(vocab)
    tok = Tokenizer(models.WordLevel(vocab, unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    tok.post_processor = processors.TemplateProcessing(single="$A <eos>", special_tokens=[("<eos>", 1)])
    tok.save(str(path))


def _decode(v: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(v), dtype="<f2").astype(np.float32)


def _img(tmp_path: Path, name: str, size=(40, 20), color=(200, 30, 30)) -> str:
    p = tmp_path / name
    Image.new("RGB", size, color).save(p)
    return str(p)


def test_registered():
    for name in ("search.prefetch", "search.embed_images", "search.embed_text"):
        assert name in HANDLERS


# -- images --------------------------------------------------------------------------


def test_preprocess_shape_range_and_squash():
    im = Image.new("RGB", (300, 100), (255, 0, 128))
    x = search.preprocess(im)
    assert x.shape == (3, 224, 224) and x.dtype == np.float32
    assert x.min() >= -1.0 and x.max() <= 1.0
    assert np.allclose(x[0], 1.0) and np.allclose(x[1], -1.0)
    assert np.allclose(x[2], (128 / 255 - 0.5) / 0.5, atol=1e-5)
    # palette / RGBA inputs convert to RGB
    assert search.preprocess(Image.new("RGBA", (10, 30), (0, 0, 0, 0))).shape == (3, 224, 224)


def test_encode_vectors_roundtrip_and_norm():
    rows = np.array([[3.0, 4.0, 0.0], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], dtype=np.float32)
    enc = search.encode_vectors(rows)
    first = _decode(enc[0])
    assert first.dtype == np.float32 and np.allclose(first, [0.6, 0.8, 0.0], atol=1e-3)
    assert abs(np.linalg.norm(_decode(enc[2])) - 1.0) < 2e-3
    assert len(base64.b64decode(enc[0])) == 3 * 2  # float16
    assert np.all(np.isfinite(_decode(enc[1])))  # zero vector stays finite


def test_embed_images_order_norm_and_batches(cap, sessions, model_dir, tmp_path):
    colors = [(i * 11 % 256, (i * 53) % 256, (i * 97) % 256) for i in range(40)]
    paths = [_img(tmp_path, f"i{i}.png", (30 + i, 20), c) for i, c in enumerate(colors)]
    r = search.embed_images(cap.ctx, {"modelDir": model_dir, "paths": paths, "threads": 3})
    assert r["dim"] == DIM and len(r["vectors"]) == 40
    assert sessions[0][1].threads == 3 and len(sessions) == 1
    assert [len(c) for c in sessions[0][1].calls] == [16, 16, 8]
    for i, v in enumerate(r["vectors"]):
        vec = _decode(v)
        assert abs(np.linalg.norm(vec) - 1) < 2e-3
        # order: the same picture alone gives the same vector
        one = search.embed_images(cap.ctx, {"modelDir": model_dir, "paths": [paths[i]]})
        assert np.allclose(_decode(one["vectors"][0]), vec, atol=2e-3)
    assert cap.events("progress")


def test_session_is_resident_and_reloads_on_new_dir(cap, sessions, model_dir, tmp_path):
    p = _img(tmp_path, "a.png")
    search.embed_images(cap.ctx, {"modelDir": model_dir, "paths": [p]})
    search.embed_images(cap.ctx, {"modelDir": model_dir, "paths": [p]})
    assert len(sessions) == 1
    other = tmp_path / "other"
    (other / "visual").mkdir(parents=True)
    (other / "visual" / "model.onnx").write_bytes(b"x")
    search.embed_images(cap.ctx, {"modelDir": str(other), "paths": [p]})
    assert len(sessions) == 2


def test_unreadable_picture_gives_empty_entry(cap, sessions, model_dir, tmp_path):
    good = _img(tmp_path, "g.png")
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not a picture")
    r = search.embed_images(cap.ctx, {"modelDir": model_dir, "paths": [str(bad), good, str(tmp_path / "missing.png")]})
    assert r["vectors"][0] == "" and r["vectors"][2] == "" and r["vectors"][1] != ""
    logs = cap.events("log")
    assert len(logs) == 2 and all(l["level"] == "warning" for l in logs)


def test_all_unreadable_still_succeeds(cap, sessions, model_dir, tmp_path):
    r = search.embed_images(cap.ctx, {"modelDir": model_dir, "paths": [str(tmp_path / "nope.png")]})
    assert r == {"dim": 0, "vectors": [""]}


def test_embed_images_cancel_between_batches(cap, sessions, model_dir, tmp_path):
    paths = [_img(tmp_path, f"c{i}.png") for i in range(40)]
    session_calls = []

    class Cancelling(FakeSession):
        def run(self, names, feeds):
            session_calls.append(1)
            cap.ctx.request_cancel()
            return super().run(names, feeds)

    search._visual = (model_dir, Cancelling("visual"))
    with pytest.raises(Cancelled):
        search.embed_images(cap.ctx, {"modelDir": model_dir, "paths": paths})
    assert len(session_calls) == 1


def test_missing_model_is_a_clear_error(cap, sessions, tmp_path):
    with pytest.raises(HandlerError) as e:
        search.embed_images(cap.ctx, {"modelDir": str(tmp_path), "paths": []})
    assert e.value.code == "dependency_missing"


# -- text ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,want",
    [
        ("A Photo of an Apple!", "a photo of an apple"),
        ("red_apple, on-the.table?", "red apple onthetable"),
        ("  lots   of\t\nspace  ", "lots of space"),
        ("it's (a) [test] {x} <y> \"q\" #1 $2 %3 &4 *5 +6 /7 \\8 ^9 `0 |~", "its a test x y q 1 2 3 4 5 6 7 8 9 0"),
        ("Ünïcode ÉCOLE", "ünïcode école"),
        ("", ""),
    ],
)
def test_clean_text(raw, want):
    assert search.clean_text(raw) == want


def test_token_ids_pad_truncate_eos(model_dir):
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(os.path.join(model_dir, "textual", "tokenizer.json"))
    ids = search.token_ids(tok, "A photo of an apple!")
    assert len(ids) == 64
    words = ids[: ids.index(1)]
    assert words == [tok.token_to_id(w) for w in "a photo of an apple".split()]
    assert ids[len(words)] == 1 and set(ids[len(words) + 1 :]) == {0}
    unknown = search.token_ids(tok, "zebra")
    assert unknown[:2] == [2, 1]
    empty = search.token_ids(tok, "")
    assert empty[0] == 1 and sum(empty[1:]) == 0
    long = search.token_ids(tok, " ".join(["dog"] * 100))
    assert len(long) == 64 and long[:63] == [tok.token_to_id("dog")] * 63 and long[63] == 1


def test_embed_text(cap, sessions, model_dir):
    texts = ["a photo of an apple", "a photo of a dog"] * 40  # 80 > one batch of 64
    r = search.embed_text(cap.ctx, {"modelDir": model_dir, "texts": texts})
    assert r["dim"] == DIM and len(r["vectors"]) == 80
    text_session = next(s for p, s in sessions if "textual" in Path(p).parts)
    assert [len(c) for c in text_session.calls] == [64, 16]
    assert r["vectors"][0] == r["vectors"][2] != r["vectors"][1]
    assert abs(np.linalg.norm(_decode(r["vectors"][0])) - 1) < 2e-3
    assert search.embed_text(cap.ctx, {"modelDir": model_dir, "texts": []}) == {"dim": 0, "vectors": []}


def test_text_session_dropped_when_idle(cap, sessions, model_dir, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(search, "_clock", lambda: now[0])
    search.embed_text(cap.ctx, {"modelDir": model_dir, "texts": ["dog"]})
    assert len(sessions) == 1 and search._text is not None
    now[0] += search.TEXT_IDLE_SECONDS - 1
    assert search.drop_idle_text() is False and search._text is not None
    search.embed_text(cap.ctx, {"modelDir": model_dir, "texts": ["cat"]})
    assert len(sessions) == 1  # still resident
    now[0] += search.TEXT_IDLE_SECONDS + 1
    assert search.drop_idle_text() is True and search._text is None
    search.embed_text(cap.ctx, {"modelDir": model_dir, "texts": ["cat"]})
    assert len(sessions) == 2  # reloaded on demand


def test_text_lazy_check_on_call(cap, sessions, model_dir, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(search, "_clock", lambda: now[0])
    search.embed_text(cap.ctx, {"modelDir": model_dir, "texts": ["dog"]})
    now[0] += 10 * search.TEXT_IDLE_SECONDS
    search.embed_text(cap.ctx, {"modelDir": model_dir, "texts": ["dog"]})
    assert len(sessions) == 2


# -- prefetch ------------------------------------------------------------------------


def test_prefetch_validates(cap, tmp_path):
    good = {"path": "a/b.bin", "url": "http://x/y", "sha256": "0" * 64, "bytes": 1}
    for params in (
        {"files": [good]},
        {"modelDir": str(tmp_path)},
        {"modelDir": str(tmp_path), "files": []},
        {"modelDir": str(tmp_path), "files": [{**good, "path": "../x"}]},
        {"modelDir": str(tmp_path), "files": [{**good, "path": "/abs"}]},
        {"modelDir": str(tmp_path), "files": [{**good, "sha256": "zz"}]},
    ):
        with pytest.raises(HandlerError) as e:
            search.prefetch(cap.ctx, params)
        assert e.value.code == "validation"


def test_prefetch_downloads_into_subfolders(cap, tmp_path, monkeypatch):
    payload = {"visual/m.onnx": b"v" * 30, "config.json": b"c" * 10}
    calls = []

    def fake_ensure(ctx, folder, file, sha, url):
        calls.append((folder, file, sha, url))
        ctx.stage("Downloading model")
        ctx.progress(0.5, "x")
        os.makedirs(folder, exist_ok=True)
        data = payload[(os.path.relpath(folder, tmp_path / "md").replace("\\", "/") + "/" + file).lstrip("./")]
        Path(folder, file).write_bytes(data)
        ctx.progress(1.0, "x", force=True)
        return os.path.join(folder, file)

    monkeypatch.setattr(search, "ensure_model", fake_ensure)
    files = [
        {"path": "visual/m.onnx", "url": "http://h/v", "sha256": hashlib.sha256(b"v" * 30).hexdigest(), "bytes": 30},
        {"path": "config.json", "url": "http://h/c", "sha256": hashlib.sha256(b"c" * 10).hexdigest(), "bytes": 10},
    ]
    md = tmp_path / "md"
    r = search.prefetch(cap.ctx, {"files": files, "modelDir": str(md)})
    assert r == {"dir": str(md)}
    assert calls[0][:2] == (str(md / "visual"), "m.onnx") and calls[1][:2] == (str(md), "config.json")
    assert (md / "visual" / "m.onnx").read_bytes() == b"v" * 30
    pcts = [e["pct"] for e in cap.events("progress")]
    assert pcts == sorted(pcts) and pcts[-1] == 1.0 and any(0 < p < 1 for p in pcts)
    assert any(abs(p - 0.75) < 1e-9 for p in pcts)  # 30/40 done after the big file


# -- the real model (TOOLBOX_SLOW=1 TOOLBOX_SEARCH_MODEL_DIR=<dir>) -------------------


def _apple(size=224) -> Image.Image:
    from PIL import ImageDraw

    im = Image.new("RGB", (size, size), (235, 235, 230))
    d = ImageDraw.Draw(im)
    d.ellipse((40, 55, 184, 205), fill=(200, 25, 30))
    d.line((112, 60, 120, 25), fill=(90, 55, 25), width=6)
    d.ellipse((120, 22, 160, 45), fill=(60, 150, 50))
    return im


@pytest.mark.slow
def test_real_model_apple_beats_blue_square(cap, tmp_path):
    model_dir = os.environ.get("TOOLBOX_SEARCH_MODEL_DIR")
    if not model_dir or not os.path.isdir(model_dir):
        pytest.skip("set TOOLBOX_SEARCH_MODEL_DIR to the downloaded model folder")
    apple, blue = tmp_path / "apple.png", tmp_path / "blue.png"
    _apple().save(apple)
    Image.new("RGB", (224, 224), (20, 30, 200)).save(blue)
    iv = search.embed_images(cap.ctx, {"modelDir": model_dir, "paths": [str(apple), str(blue)]})
    tv = search.embed_text(cap.ctx, {"modelDir": model_dir, "texts": ["a photo of an apple"]})
    t = _decode(tv["vectors"][0])
    s_apple, s_blue = (float(_decode(v) @ t) for v in iv["vectors"])
    assert iv["dim"] == tv["dim"] == 768
    assert s_apple > s_blue
