"""upscale: tiling, alpha, scale handling, cancellation, validation."""

from __future__ import annotations

import numpy as np
import pytest
import torch
import torch.nn.functional as F
from PIL import Image

from toolbox_sidecar.handlers import upscale as up
from toolbox_sidecar.registry import Cancelled, HandlerError

SPEC = {"file": "m.pth", "sha256": "0" * 64, "url": "https://x/m.pth"}


def nearest4(t):
    return F.interpolate(t, scale_factor=4, mode="nearest")


class ConvNet:
    """3x3 conv then nearest x4: has a receptive field, so tiling needs overlap."""

    def __init__(self):
        g = torch.Generator().manual_seed(1)
        self.w = torch.randn(3, 3, 3, 3, generator=g) * 0.2

    def __call__(self, t):
        return nearest4(F.conv2d(t, self.w, padding=1)).clamp(0, 1)


def _arr(h, w, seed=0):
    return np.random.default_rng(seed).integers(0, 256, (h, w, 3), dtype=np.uint8)


def test_identity_tiles_match_nearest():
    a = _arr(70, 90)
    out = up.upscale_array(nearest4, a, 4, tile=32, overlap=8)
    assert out.shape == (280, 360, 3)
    assert (out == np.repeat(np.repeat(a, 4, 0), 4, 1)).all()


def test_tiled_equals_untiled_with_receptive_field():
    a = _arr(70, 90, 3)
    net = ConvNet()
    whole = up.upscale_array(net, a, 4, tile=512, overlap=0)
    tiled = up.upscale_array(net, a, 4, tile=32, overlap=16)
    assert (whole == tiled).all()


def test_cancel_between_tiles(cap):
    calls = []

    def infer(t):
        calls.append(1)
        cap.ctx.request_cancel()
        return nearest4(t)

    with pytest.raises(Cancelled):
        up.upscale_array(infer, _arr(64, 64), 4, tile=32, overlap=4, ctx=cap.ctx)
    assert len(calls) == 1


def test_progress_reported(cap):
    up.upscale_array(nearest4, _arr(64, 64), 4, tile=32, overlap=4, ctx=cap.ctx)
    msgs = [e["msg"] for e in cap.events("progress")]
    assert any("tile" in m for m in msgs)


class FakeModel:
    scale = 4

    def __call__(self, t):
        return nearest4(t)


@pytest.fixture
def fake_model(monkeypatch, tmp_path):
    monkeypatch.setattr(up, "ensure_model", lambda ctx, d, f, s, u: str(tmp_path / f))
    monkeypatch.setattr(up, "_load_model", lambda path, device: FakeModel())
    monkeypatch.setattr(up, "pick_device", lambda: "cpu")


def _run(cap, tmp_path, src_img, **kw):
    src = tmp_path / "in.png"
    src_img.save(src)
    out = tmp_path / "res" / ("out." + kw.get("format", "png"))
    p = {"input": str(src), "output": str(out), "model": SPEC, "modelDir": str(tmp_path), "scale": 4, "format": "png"}
    p.update(kw)
    return up.run(cap.ctx, p), out


def test_run_4x_and_2x(fake_model, cap, tmp_path):
    img = Image.fromarray(_arr(20, 30))
    res, out = _run(cap, tmp_path, img)
    assert res == {"inWidth": 30, "inHeight": 20, "outWidth": 120, "outHeight": 80, "device": "cpu"}
    assert Image.open(out).size == (120, 80)
    res, out = _run(cap, tmp_path, img, scale=2)
    assert (res["outWidth"], res["outHeight"]) == (60, 40) and Image.open(out).size == (60, 40)
    assert cap.events("output")[-1]["path"] == str(out)


def test_run_alpha_resized_separately(fake_model, cap, tmp_path):
    rgba = Image.fromarray(_arr(10, 10)).convert("RGBA")
    a = np.zeros((10, 10), np.uint8)
    a[:, 5:] = 255
    rgba.putalpha(Image.fromarray(a))
    _, out = _run(cap, tmp_path, rgba)
    im = Image.open(out)
    assert im.mode == "RGBA" and im.size == (40, 40)
    assert im.getpixel((2, 20))[3] == 0 and im.getpixel((38, 20))[3] == 255


@pytest.mark.parametrize("fmt,expected", [("png", "PNG"), ("jpg", "JPEG"), ("webp", "WEBP")])
def test_run_formats(fake_model, cap, tmp_path, fmt, expected):
    _, out = _run(cap, tmp_path, Image.fromarray(_arr(8, 8)), format=fmt)
    assert Image.open(out).format == expected


def test_run_jpg_with_alpha_flattens(fake_model, cap, tmp_path):
    _, out = _run(cap, tmp_path, Image.fromarray(_arr(8, 8)).convert("RGBA"), format="jpg")
    assert Image.open(out).mode == "RGB"


@pytest.mark.parametrize("patch", [{"scale": 3}, {"scale": True}, {"format": "gif"}, {"model": None}, {"output": ""}])
def test_run_validation(tmp_path, cap, patch):
    src = tmp_path / "i.png"
    Image.new("RGB", (4, 4)).save(src)
    p = {"input": str(src), "output": str(tmp_path / "o.png"), "model": SPEC, "modelDir": str(tmp_path), "scale": 4, "format": "png"}
    p.update(patch)
    with pytest.raises(HandlerError) as e:
        up.run(cap.ctx, p)
    assert e.value.code == "validation"
