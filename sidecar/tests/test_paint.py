"""Paint+ Lab perception handlers (Phase 19 SPEC.md §2.5), with stub models."""

from __future__ import annotations

import os

import numpy as np
import pytest
from PIL import Image

from toolbox_sidecar.handlers import paint as h
from toolbox_sidecar.registry import HandlerError


def gradient(w: int, h_: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h_, 0:w]
    return np.stack([xx * 255 // (w - 1), yy * 255 // (h_ - 1), (xx + yy) * 255 // (w + h_ - 2)], -1).astype(np.uint8)


def disc(shape: tuple[int, int], cx: int, cy: int, r: int) -> np.ndarray:
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r


def stub_migan(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Fills the hole with the mean colour of what is kept (context dependent, deterministic)."""
    keep = mask[0, 0] > 0
    out = image.copy()
    mean = image[0][:, keep].mean(axis=1) if keep.any() else np.zeros(3)
    for c in range(3):
        out[0, c][~keep] = np.uint8(mean[c])
    return out


@pytest.fixture
def files(tmp_path):
    src = gradient(128, 128)
    Image.fromarray(src).save(tmp_path / "src.png")
    mask = (disc((128, 128), 64, 64, 14) * 255).astype(np.uint8)
    Image.fromarray(mask).save(tmp_path / "mask.png")
    model = tmp_path / "migan.onnx"
    model.write_bytes(b"x")
    return {"src": src, "dir": tmp_path, "model": str(model)}


@pytest.fixture
def stubbed(monkeypatch):
    monkeypatch.setattr(h, "_runner", lambda model, path: stub_migan)


def fill_params(files, **kw):
    d = files["dir"]
    p = {
        "src": str(d / "src.png"), "mask": str(d / "mask.png"), "out": str(d / "res" / "out.png"),
        "model": "fast", "modelPath": files["model"], "passes": 1, "ghost": 0, "drift": 0,
        "driftDir": "", "offset": [0, 0], "seed": 7,
    }
    p.update(kw)
    return p


def read(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"))


def test_fill_single_pass_changes_only_masked(files, cap, stubbed):
    res = h.fill(cap.ctx, fill_params(files))
    assert res["passes"] == 1
    out = read(res["output"])
    mask = disc((128, 128), 64, 64, 14)
    assert (out[~mask] == files["src"][~mask]).all()
    assert (out[mask] != files["src"][mask]).any()


def test_fill_passes_events_and_files(files, cap, stubbed):
    res = h.fill(cap.ctx, fill_params(files, passes=3, ghost=0.3))
    assert res["passes"] == 3
    d = os.path.dirname(res["output"])
    for n in (1, 2, 3):
        assert os.path.isfile(os.path.join(d, f"pass-{n}.png"))
    paths = [e["path"] for e in cap.events("output")]
    assert [os.path.basename(p) for p in paths] == ["pass-1.png", "pass-2.png", "pass-3.png"]
    assert (read(res["output"]) == read(paths[-1])).all()
    assert cap.events("progress")[-1]["pct"] == 1.0


def test_fill_ghost_one_keeps_source(files, cap, stubbed):
    res = h.fill(cap.ctx, fill_params(files, passes=2, ghost=1))
    assert (read(res["output"]) == files["src"]).all()


def test_fill_ghost_blends(files, cap, stubbed):
    full = read(h.fill(cap.ctx, fill_params(files, ghost=0))["output"]).astype(int)
    half = read(h.fill(cap.ctx, fill_params(files, ghost=0.5))["output"]).astype(int)
    src = files["src"].astype(int)
    mask = disc((128, 128), 64, 64, 14)
    assert (np.abs(half[mask] - (src[mask] + full[mask]) / 2) <= 1).all()


def test_fill_deterministic_same_seed(files, cap, stubbed):
    kw = {"passes": 4, "ghost": 0.2, "drift": 1.0}
    a = read(h.fill(cap.ctx, fill_params(files, seed=11, **kw))["output"])
    b = read(h.fill(cap.ctx, fill_params(files, seed=11, **kw))["output"])
    c = read(h.fill(cap.ctx, fill_params(files, seed=12, **kw))["output"])
    assert (a == b).all()
    assert (a != c).any()


def test_fill_drift_changes_output(files, cap, stubbed):
    a = read(h.fill(cap.ctx, fill_params(files, passes=3, drift=0))["output"])
    b = read(h.fill(cap.ctx, fill_params(files, passes=3, drift=1.0))["output"])
    assert (a != b).any()


def test_fill_offset_shifts_context(files, cap, stubbed):
    a = read(h.fill(cap.ctx, fill_params(files))["output"])
    b = read(h.fill(cap.ctx, fill_params(files, offset=[40, 0]))["output"])
    assert (a != b).any()


def test_fill_melt_grows_downward(files, cap, stubbed):
    res = h.fill(cap.ctx, fill_params(files, passes=6, driftDir="down"))
    out = read(res["output"])
    changed = (out != files["src"]).any(axis=2)
    ys, _ = np.nonzero(changed)
    assert ys.max() > 64 + 14 + 3  # beyond the original mask's bottom
    assert ys.min() >= 64 - 14 - 6  # only the 1 px all-round growth per pass upwards


def test_fill_alpha_kept_outside(files, cap, stubbed):
    d = files["dir"]
    rgba = np.dstack([files["src"], np.full((128, 128), 255, np.uint8)])
    rgba[:20, :, 3] = 0
    Image.fromarray(rgba, "RGBA").save(d / "src.png")
    res = h.fill(cap.ctx, fill_params(files))
    out = np.asarray(Image.open(res["output"]))
    assert out.shape[2] == 4 and (out[:20, :, 3] == 0).all() and (out[100:, :, 3] == 255).all()


@pytest.mark.parametrize(
    "kw,msg",
    [
        ({"passes": 0}, "passes"),
        ({"passes": 13}, "passes"),
        ({"ghost": 1.5}, "ghost"),
        ({"drift": -1}, "drift"),
        ({"driftDir": "sideways"}, "driftDir"),
        ({"model": "huge"}, "model"),
        ({"offset": [1]}, "offset"),
        ({"seed": 1.5}, "seed"),
    ],
)
def test_fill_validation(files, cap, stubbed, kw, msg):
    with pytest.raises(HandlerError) as e:
        h.fill(cap.ctx, fill_params(files, **kw))
    assert e.value.code == "validation" and msg in e.value.message


def test_fill_empty_mask_and_missing_model(files, cap, stubbed):
    Image.fromarray(np.zeros((128, 128), np.uint8)).save(files["dir"] / "mask.png")
    with pytest.raises(HandlerError, match="Paint over"):
        h.fill(cap.ctx, fill_params(files))
    with pytest.raises(HandlerError) as e:
        h.fill(cap.ctx, fill_params(files, modelPath=str(files["dir"] / "none.onnx")))
    assert e.value.code == "validation"


def test_fill_cancel_between_passes(files, cap, stubbed):
    from toolbox_sidecar.registry import Cancelled

    cap.ctx._cancel.set()
    with pytest.raises(Cancelled):
        h.fill(cap.ctx, fill_params(files, passes=2))


def test_shift_helpers():
    m = np.zeros((10, 10), bool)
    m[4, 4] = True
    assert h.shift_mask(m, 2, -1)[3, 6] and h.shift_mask(m, 2, -1).sum() == 1
    assert not h.shift_mask(m, 20, 0).any()
    a = np.arange(100, dtype=np.uint8).reshape(10, 10)
    s = h.shift_image(a, 1, 0)
    assert (s[:, 1:] == a[:, :-1]).all()


# -- segment ---------------------------------------------------------------------------


class FakeSam:
    def __init__(self) -> None:
        self.set_calls = 0
        self.predict_calls = 0
        self._features = None
        self._orig_hw = None
        self._is_image_set = False
        self._is_batch = False

    def set_image(self, arr):
        self.set_calls += 1
        self._features = arr.sum()
        self._orig_hw = [arr.shape[:2]]
        self._is_image_set = True

    def predict(self, point_coords, point_labels, multimask_output):
        assert self._is_image_set and not multimask_output
        self.predict_calls += 1
        hh, ww = self._orig_hw[0]
        m = np.zeros((1, hh, ww), np.float32)
        x, y = point_coords[0]
        m[0, int(y) - 5 : int(y) + 5, int(x) - 5 : int(x) + 5] = 1
        return m, np.array([0.9], np.float32), None


@pytest.fixture
def fake_sam(monkeypatch, tmp_path):
    from toolbox_sidecar.matte import sam

    pred = FakeSam()
    monkeypatch.setattr(h, "_sam", h.SamCache())
    monkeypatch.setattr(h, "_load_sam", lambda path, dev: pred)
    monkeypatch.setattr(sam, "pick_device", lambda: "cpu")
    model = tmp_path / "sam.pt"
    model.write_bytes(b"x")
    return pred, str(model)


def seg_params(tmp_path, model, points):
    return {"src": str(tmp_path / "src.png"), "out": str(tmp_path / "m.png"), "modelPath": model, "points": points}


def test_segment_mask_and_embedding_cache(tmp_path, cap, fake_sam):
    pred, model = fake_sam
    Image.fromarray(gradient(64, 64)).save(tmp_path / "src.png")
    r1 = h.segment(cap.ctx, seg_params(tmp_path, model, [{"x": 30, "y": 30, "positive": True}]))
    m = np.asarray(Image.open(r1["output"]))
    assert m.shape == (64, 64) and m[30, 30] == 255 and m[0, 0] == 0 and r1["score"] == pytest.approx(0.9)
    h.segment(cap.ctx, seg_params(tmp_path, model, [{"x": 20, "y": 20, "positive": True}, {"x": 5, "y": 5, "positive": False}]))
    assert pred.set_calls == 1 and pred.predict_calls == 2  # second click reused the embedding
    Image.fromarray(gradient(64, 64)[::-1].copy()).save(tmp_path / "src.png")
    h.segment(cap.ctx, seg_params(tmp_path, model, [{"x": 30, "y": 30, "positive": True}]))
    assert pred.set_calls == 2


def test_sam_cache_lru_size():
    c = h.SamCache(size=2)
    c.predictor = FakeSam()
    arr = np.zeros((4, 4, 3), np.uint8)
    for k in "abc":
        assert not c.set_image(k, arr)
    assert list(c.entries) == ["b", "c"]
    assert c.set_image("c", arr) and not c.set_image("a", arr)


@pytest.mark.parametrize(
    "points",
    [None, [], [{"x": 1, "y": 1, "positive": False}], [{"x": 99, "y": 1, "positive": True}], [{"x": 1}], [{"x": 1, "y": 1, "positive": True}] * 65],
)
def test_segment_validation(tmp_path, cap, fake_sam, points):
    _, model = fake_sam
    Image.fromarray(gradient(64, 64)).save(tmp_path / "src.png")
    with pytest.raises(HandlerError) as e:
        h.segment(cap.ctx, seg_params(tmp_path, model, points))
    assert e.value.code == "validation"


# -- cutout / enhance / warm -----------------------------------------------------------


class FakeSession:
    class _In:
        name = "in"

    def get_inputs(self):
        return [self._In()]

    def run(self, _names, feed):
        x = feed["in"]
        assert x.shape == (1, 3, 1024, 1024)
        logits = np.full((1, 1, 1024, 1024), -10.0, np.float32)
        logits[..., :512] = 10.0  # left half is the subject
        return [logits]


def test_cutout_wiring(tmp_path, cap, monkeypatch):
    from toolbox_sidecar.handlers import bgremove as bg

    monkeypatch.setattr(bg, "_get_session", lambda path: FakeSession())
    Image.fromarray(gradient(64, 48)).save(tmp_path / "src.png")
    (tmp_path / "m.onnx").write_bytes(b"x")
    res = h.cutout(cap.ctx, {
        "src": str(tmp_path / "src.png"), "out": str(tmp_path / "o" / "cut.png"),
        "model": {"file": "m.onnx", "kind": "birefnet"}, "modelDir": str(tmp_path),
    })
    out = np.asarray(Image.open(res["output"]))
    assert out.shape == (48, 64, 4) and out[10, 5, 3] == 255 and out[10, 60, 3] == 0
    assert res["coverage"] == pytest.approx(0.5, abs=0.02)


def test_cutout_missing_model_and_bad_kind(tmp_path, cap):
    Image.fromarray(gradient(8, 8)).save(tmp_path / "src.png")
    base = {"src": str(tmp_path / "src.png"), "out": str(tmp_path / "c.png"), "modelDir": str(tmp_path)}
    with pytest.raises(HandlerError, match="downloaded"):
        h.cutout(cap.ctx, {**base, "model": {"file": "none.onnx", "kind": "isnet"}})
    with pytest.raises(HandlerError, match="kind"):
        h.cutout(cap.ctx, {**base, "model": {"file": "none.onnx", "kind": "x"}})


def test_enhance_wiring_and_anime_refused(tmp_path, cap, monkeypatch):
    torch = pytest.importorskip("torch")
    from toolbox_sidecar.handlers import upscale as up

    class Fake:
        scale = 4

        def __call__(self, t):
            return torch.nn.functional.interpolate(t, scale_factor=4, mode="nearest")

    monkeypatch.setattr(up, "_load_model", lambda p, d: Fake())
    monkeypatch.setattr(up, "pick_device", lambda: "cpu")
    Image.fromarray(gradient(20, 12)).save(tmp_path / "src.png")
    (tmp_path / h.ENHANCE_FILE).write_bytes(b"x")
    (tmp_path / "RealESRGAN_x4plus_anime_6B.pth").write_bytes(b"x")
    p = {"src": str(tmp_path / "src.png"), "out": str(tmp_path / "e.png"), "model": {"file": h.ENHANCE_FILE},
         "modelDir": str(tmp_path), "scale": 4}
    assert Image.open(h.enhance(cap.ctx, p)["output"]).size == (80, 48)
    assert Image.open(h.enhance(cap.ctx, {**p, "scale": 2})["output"]).size == (40, 24)
    with pytest.raises(HandlerError, match="photo"):
        h.enhance(cap.ctx, {**p, "model": {"file": "RealESRGAN_x4plus_anime_6B.pth"}})
    with pytest.raises(HandlerError, match="scale"):
        h.enhance(cap.ctx, {**p, "scale": 3})


def test_warm_missing_model_is_fine(tmp_path, cap, monkeypatch):
    called = []
    monkeypatch.setattr(h, "_runner", lambda m, p: called.append(p))
    assert h.warm(cap.ctx, {"model": "fast", "modelPath": str(tmp_path / "none")}) == {}
    assert not called
    (tmp_path / "m.onnx").write_bytes(b"x")
    h.warm(cap.ctx, {"model": "fast", "modelPath": str(tmp_path / "m.onnx")})
    assert called


def test_prefetch_refuses_other_models(tmp_path, cap):
    spec = {"file": "other.pth", "sha256": "0" * 64, "url": "https://example.invalid/x"}
    with pytest.raises(HandlerError):
        h.prefetch(cap.ctx, {"model": spec, "modelDir": str(tmp_path)})
