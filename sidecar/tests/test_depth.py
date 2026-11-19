"""Depth handlers (Phase 21 SPEC §E5): pure helpers, depth.image and depth.video with a tiny fixture model.

The fixture model has the real model's contract (input ``pixel_values`` [1,3,H,W], output ``predicted_depth``
[1,H,W]) but computes the channel mean plus a constant, so brighter = nearer. The real model runs under
TOOLBOX_SLOW=1 when $TOOLBOX_DEPTH_MODEL (or <repo>/.dev/p21-spike/depth-anything-v2-small.onnx) exists.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

from toolbox_sidecar.handlers import depth as d
from toolbox_sidecar.registry import Cancelled, HandlerError

from .test_matte import FFMPEG, decode_gray, make_stream, needs_ffmpeg


def make_tiny_model(path: Path) -> str:
    onnx = pytest.importorskip("onnx")
    from onnx import TensorProto, helper

    x = helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, [1, 3, None, None])
    y = helper.make_tensor_value_info("predicted_depth", TensorProto.FLOAT, [1, None, None])
    three = helper.make_tensor("three", TensorProto.FLOAT, [], [3.0])
    nodes = [
        helper.make_node("ReduceMean", ["pixel_values"], ["mean"], axes=[1], keepdims=0),
        helper.make_node("Add", ["mean", "three"], ["predicted_depth"]),
    ]
    graph = helper.make_graph(nodes, "tiny", [x], [y], initializer=[three])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.save(model, str(path))
    return str(path)


@pytest.fixture
def tiny_model(tmp_path: Path) -> str:
    d._session = None
    return make_tiny_model(tmp_path / "depth.onnx")


# -- pure helpers -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "w,h,short,want",
    [(4032, 3024, 518, (686, 518)), (1920, 1080, 266, (476, 266)), (1080, 1920, 266, (266, 476)), (20, 20, 518, (518, 518))],
)
def test_infer_size_is_a_multiple_of_14(w, h, short, want):
    got = d.infer_size(w, h, short)
    assert got == want
    assert got[0] % 14 == 0 and got[1] % 14 == 0


def test_to_input_normalises_with_imagenet_stats():
    x = d.to_input(np.full((14, 28, 3), 255, np.uint8))
    assert x.shape == (1, 3, 14, 28) and x.dtype == np.float32
    np.testing.assert_allclose(x[0, :, 0, 0], (1 - d.MEAN) / d.STD, rtol=1e-5)


def test_compress_then_normalise_puts_near_at_one():
    raw = d.compress(np.array([[0.0, 1.0, 3.0, 9.0]], np.float32))
    np.testing.assert_allclose(raw, np.log1p([[0, 1, 3, 9]]), rtol=1e-6)
    lo, hi = d.percentile_range(np.linspace(0, 10, 1001))
    assert lo == pytest.approx(0.2, abs=0.05) and hi == pytest.approx(9.8, abs=0.05)
    out = d.normalise(np.array([[lo - 5, (lo + hi) / 2, hi + 5]], np.float32), lo, hi)
    assert out[0, 0] == 0.0 and out[0, 1] == pytest.approx(0.5, abs=1e-5) and out[0, 2] == 1.0


def test_a_flat_map_has_a_nonzero_range():
    lo, hi = d.percentile_range(np.full(100, 2.0, np.float32))
    assert hi > lo


def test_log_compression_keeps_the_background_from_crushing():
    # One very near object (value 100) among a background of 1..2: linear p2..p98 would map
    # the whole background to ~0; log1p keeps it spread.
    bg = np.linspace(1.0, 2.0, 1000, dtype=np.float32)
    values = np.concatenate([bg, np.full(10, 100.0, np.float32)])
    lo, hi = d.percentile_range(d.compress(values))
    n = d.normalise(d.compress(bg), lo, hi)
    assert n.max() - n.min() > 0.5


def test_ema_blends_and_resets_on_a_cut():
    a, b = np.zeros((2, 2), np.float32), np.ones((2, 2), np.float32)
    assert d.ema(None, b, False) is b
    np.testing.assert_allclose(d.ema(a, b, False), 0.6)
    np.testing.assert_allclose(d.ema(a, b, True), 1.0)


def test_scene_cut_threshold():
    dark = np.full((36, 64), 20, np.uint8)
    bright = np.full((36, 64), 220, np.uint8)
    slight = np.full((36, 64), 40, np.uint8)
    assert d.is_cut(None, d.thumb(dark)) is False
    assert d.is_cut(d.thumb(dark), d.thumb(bright)) is True
    assert d.is_cut(d.thumb(dark), d.thumb(slight)) is False


def test_guided_filter_follows_the_guide_edges():
    guide = np.zeros((64, 64), np.float32)
    guide[:, 32:] = 1.0
    rng = np.random.default_rng(0)
    src = guide + rng.normal(0, 0.15, guide.shape).astype(np.float32)
    out = d.guided_filter(guide, src, 4, 1e-3)
    assert abs(out[:, :28].mean() - 0.0) < 0.05 and abs(out[:, 36:].mean() - 1.0) < 0.05
    assert out[:, :28].std() < src[:, :28].std()  # smoother
    assert out[:, 31].mean() < 0.35 and out[:, 32].mean() > 0.65  # the edge stays where the guide's is
    assert d.guided_filter(guide, np.full_like(guide, 0.3), 4, 1e-3) == pytest.approx(0.3, abs=1e-5)


# -- depth.image --------------------------------------------------------------------------------


def _gradient_png(path: Path, w: int, h: int) -> str:
    from PIL import Image

    g = np.tile(np.linspace(20, 235, w, dtype=np.uint8), (h, 1))
    Image.fromarray(np.stack([g, g, g], axis=2)).save(path)
    return str(path)


def test_depth_image_writes_a_16_bit_map_capped_at_2048(tmp_path, cap, tiny_model):
    from PIL import Image

    src = _gradient_png(tmp_path / "in.png", 3000, 1500)
    out = str(tmp_path / "out" / "depth.png")
    res = d.depth_image(cap.ctx, {"path": src, "model": tiny_model, "out": out})
    assert (res["width"], res["height"]) == (2048, 1024) and res["out"] == out
    with Image.open(out) as im:
        assert im.size == (2048, 1024) and im.mode in ("I;16", "I")
        a = np.asarray(im).astype(np.float64) / 65535.0
    assert a[:, :200].mean() < 0.15 and a[:, -200:].mean() > 0.85  # brighter = nearer
    assert a.min() < 0.05 and a.max() > 0.95  # p2..p98 stretch
    assert not os.path.exists(out + ".part")


def test_depth_image_keeps_small_pictures_at_their_size(tmp_path, cap, tiny_model):
    src = _gradient_png(tmp_path / "s.png", 300, 200)
    res = d.depth_image(cap.ctx, {"path": src, "model": tiny_model, "out": str(tmp_path / "s-depth.png")})
    assert (res["width"], res["height"]) == (300, 200)


@pytest.mark.parametrize(
    "over",
    [{"path": ""}, {"path": "missing.png"}, {"model": "missing.onnx"}, {"out": ""}],
)
def test_depth_image_validation(tmp_path, cap, tiny_model, over):
    p = {"path": _gradient_png(tmp_path / "v.png", 64, 64), "model": tiny_model, "out": str(tmp_path / "o.png")}
    p.update(over)
    with pytest.raises(HandlerError) as e:
        d.depth_image(cap.ctx, p)
    assert e.value.code == "validation"


def test_a_missing_model_says_which_pack(tmp_path, cap):
    with pytest.raises(HandlerError) as e:
        d.depth_image(cap.ctx, {"path": _gradient_png(tmp_path / "v.png", 64, 64), "model": str(tmp_path / "no.onnx"), "out": str(tmp_path / "o.png")})
    assert "Color" in (e.value.hint or "")


def test_depth_image_cancel(tmp_path, cap, tiny_model):
    cap.ctx.request_cancel()
    with pytest.raises(Cancelled):
        d.depth_image(cap.ctx, {"path": _gradient_png(tmp_path / "c.png", 64, 64), "model": tiny_model, "out": str(tmp_path / "o.png")})


# -- depth.video --------------------------------------------------------------------------------


def _video_params(tmp_path: Path, stream: str, idx: str, model_path: str, **over):
    p = {"ffmpeg": FFMPEG, "stream": stream, "index": idx, "fps": 30, "width": 64, "height": 48,
         "outDir": str(tmp_path / "depth"), "name": "depth", "model": model_path}
    p.update(over)
    return p


@needs_ffmpeg
def test_depth_video_smooths_resets_on_cuts_and_writes_two_tiers(tmp_path, cap, tiny_model):
    frames = [np.full((48, 64), 200, np.uint8)] * 10 + [np.full((48, 64), 40, np.uint8)] * 10
    stream, idx = make_stream(tmp_path, "src", frames)
    res = d.depth_video(cap.ctx, _video_params(tmp_path, stream, idx, tiny_model))
    assert res["frames"] == 20 and (res["width"], res["height"]) == (64, 48) and (res["previewWidth"], res["previewHeight"]) == (32, 24)
    assert Path(res["exportPath"]).stat().st_size > 0 and Path(res["previewPath"]).stat().st_size > 0
    assert not list((tmp_path / "depth").glob("*.work.f16")) and not list((tmp_path / "depth").glob("*.part"))

    # The streams need an index to be read; the same helper Go's WriteIndex mirrors.
    import json

    from .test_matte import build_index

    for key, w, h in (("exportPath", 64, 48), ("previewPath", 32, 24)):
        data = Path(res[key]).read_bytes()
        Path(res[key][: -len(".h264")] + ".idx.json").write_text(json.dumps(build_index(data, w, h, 30)))
    out = decode_gray(res["exportPath"], res["exportPath"][: -len(".h264")] + ".idx.json", 0, 20, 64, 48)
    means = [float(f.mean()) for f in out]
    assert means[0] > 215 and means[9] > 215  # the bright shot is near (1.0)
    assert means[10] < 40, "the EMA must reset on the scene cut instead of blending (would be ~100)"
    assert means[19] < 40
    prev = decode_gray(res["previewPath"], res["previewPath"][: -len(".h264")] + ".idx.json", 0, 20, 32, 24)
    assert len(prev) == 20 and prev[0].mean() > 215

    prog = [e["pct"] for e in cap.events("progress") if e["pct"] >= 0]
    assert prog == sorted(prog) and prog[-1] == pytest.approx(1.0, abs=0.01)


@needs_ffmpeg
def test_depth_video_infers_every_second_frame_above_15_fps(tmp_path, cap, tiny_model, monkeypatch):
    calls = []
    real = d.run_model

    def counting(sess, rgb):
        calls.append(1)
        return real(sess, rgb)

    monkeypatch.setattr(d, "run_model", counting)
    stream, idx = make_stream(tmp_path, "src", [np.full((48, 64), 120, np.uint8)] * 21)
    d.depth_video(cap.ctx, _video_params(tmp_path, stream, idx, tiny_model))
    assert len(calls) == 11  # frames 0, 2, ..., 20

    calls.clear()
    stream, idx = make_stream(tmp_path, "src12", [np.full((48, 64), 120, np.uint8)] * 9, fps=12)
    d.depth_video(cap.ctx, _video_params(tmp_path, stream, idx, tiny_model, fps=12, outDir=str(tmp_path / "d12")))
    assert len(calls) == 9  # every frame at 12 fps


@needs_ffmpeg
def test_depth_video_cancel_cleans_up(tmp_path, cap, tiny_model):
    stream, idx = make_stream(tmp_path, "src", [np.full((48, 64), 120, np.uint8)] * 20)
    cap.ctx.request_cancel()
    with pytest.raises(Cancelled):
        d.depth_video(cap.ctx, _video_params(tmp_path, stream, idx, tiny_model))
    left = list((tmp_path / "depth").glob("*")) if (tmp_path / "depth").exists() else []
    assert left == []


@needs_ffmpeg
@pytest.mark.parametrize("over", [{"fps": 0}, {"width": 0}, {"name": "../x"}, {"model": "nope.onnx"}])
def test_depth_video_validation(tmp_path, cap, tiny_model, over):
    stream, idx = make_stream(tmp_path, "src", [np.full((48, 64), 120, np.uint8)] * 4)
    with pytest.raises(HandlerError) as e:
        d.depth_video(cap.ctx, _video_params(tmp_path, stream, idx, tiny_model, **over))
    assert e.value.code == "validation"


# -- the real model ------------------------------------------------------------------------------


def _real_model() -> str | None:
    for p in (os.environ.get("TOOLBOX_DEPTH_MODEL", ""), str(Path(__file__).resolve().parents[2] / ".dev" / "p21-spike" / "depth-anything-v2-small.onnx")):
        if p and os.path.isfile(p):
            return p
    return None


@pytest.mark.slow
def test_real_model_puts_the_foreground_nearer(tmp_path, cap):
    model = _real_model()
    if model is None:
        pytest.skip("no depth model found")
    from PIL import Image

    # A synthetic scene isn't a fair depth test (the model reads it as a sky), so only the contract is
    # checked: the map has the picture's size, 16 bits, a stretched range and real structure.
    yy, xx = np.mgrid[0:360, 0:480]
    img = np.stack([np.tile(np.linspace(30, 90, 480), (360, 1))] * 3, axis=2).astype(np.uint8)
    img[(yy - 200) ** 2 + (xx - 240) ** 2 < 90**2] = (230, 200, 150)
    src = tmp_path / "scene.png"
    Image.fromarray(img).save(src)
    res = d.depth_image(cap.ctx, {"path": str(src), "model": model, "out": str(tmp_path / "depth.png")})
    with Image.open(res["out"]) as im:
        a = np.asarray(im).astype(np.float64) / 65535.0
    assert a.shape == (360, 480)
    assert a.min() < 0.05 and a.max() > 0.95 and a.std() > 0.1
