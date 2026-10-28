"""bgremove: pure functions on synthetic images, download verification, validation."""

from __future__ import annotations

import hashlib
import os

import numpy as np
import pytest
from PIL import Image

from toolbox_sidecar import download
from toolbox_sidecar.handlers import bgremove as bg
from toolbox_sidecar.registry import Cancelled, HandlerError

SPEC = {"file": "m.onnx", "sha256": "0" * 64, "url": "https://x/m.onnx", "kind": "isnet"}


def _params(tmp_path, **kw):
    src = tmp_path / "in.png"
    Image.new("RGB", (8, 8)).save(src)
    p = {"input": str(src), "outputDir": str(tmp_path / "out"), "modelDir": str(tmp_path / "m"), "model": dict(SPEC)}
    p.update(kw)
    return p


def test_preprocess_shapes_and_norm():
    im = Image.new("RGB", (50, 30), (255, 255, 255))
    x = bg.preprocess(im, "isnet", 64)
    assert x.shape == (1, 3, 64, 64) and x.dtype == np.float32
    assert np.allclose(x, 0.5)  # (1-0.5)/1
    y = bg.preprocess(im, "birefnet", 64)
    assert np.allclose(y[0, 0], (1 - 0.485) / 0.229, atol=1e-4)
    assert np.allclose(y[0, 2], (1 - 0.406) / 0.225, atol=1e-4)


def test_mask_from_output_per_kind():
    raw = np.zeros((1, 1, 4, 4), np.float32)
    raw[0, 0, :, 2:] = 5.0
    m = bg.mask_from_output([raw], "isnet", (8, 8))  # min-max, no sigmoid
    a = np.asarray(m)
    assert m.size == (8, 8) and a.min() == 0 and a.max() == 255
    logits = np.full((1, 1, 4, 4), -20.0, np.float32)
    logits[0, 0, :2] = 20.0
    a = np.asarray(bg.mask_from_output([np.zeros((1, 1, 2, 2)), logits], "birefnet", (4, 4)))  # last output, sigmoid
    assert a[0, 0] == 255 and a[3, 0] == 0


def test_guided_filter_keeps_range_and_edges():
    guide = np.zeros((32, 32), np.uint8)
    guide[:, 16:] = 255
    alpha = guide.copy()
    out = bg.guided_filter(alpha, guide)
    assert out.dtype == np.uint8 and out[:, :4].max() < 10 and out[:, -4:].min() > 245


def test_clean_edges_color_bleed():
    rgb = np.zeros((10, 20, 3), np.uint8)
    rgb[:, :10] = (200, 0, 0)  # subject red
    rgb[:, 10:] = (0, 255, 0)  # old background green leaking into the edge
    alpha = np.zeros((10, 20), np.uint8)
    alpha[:, :10] = 255
    alpha[:, 10:13] = 100  # semi-transparent halo
    out = bg.clean_edges(rgb, alpha)
    assert (out[:, 10:13] == (200, 0, 0)).all()
    assert (out[:, 17:] == (0, 255, 0)).all()  # beyond the band: untouched
    assert (out[:, :10] == (200, 0, 0)).all()


def test_clean_edges_noop_cases():
    rgb = np.random.randint(0, 255, (5, 5, 3), np.uint8)
    assert (bg.clean_edges(rgb, np.zeros((5, 5), np.uint8)) == rgb).all()
    assert (bg.clean_edges(rgb, np.full((5, 5), 255, np.uint8)) == rgb).all()


def test_crop_box_padding_and_clamp():
    a = np.zeros((100, 200), np.uint8)
    a[40:60, 50:80] = 255
    assert bg.crop_box(a, 0) == (50, 40, 80, 60)
    assert bg.crop_box(a, 10) == (40, 30, 90, 70)
    assert bg.crop_box(a, 500) == (0, 0, 200, 100)
    assert bg.crop_box(np.full((4, 4), 5, np.uint8), 3) is None  # <= 8 is background


def _scene():
    rgb = Image.new("RGB", (100, 80), (10, 20, 30))
    a = np.zeros((80, 100), np.uint8)
    a[20:40, 30:60] = 255
    return rgb, Image.fromarray(a, "L")


def test_compose_transparent_with_crop():
    rgb, mask = _scene()
    out, found = bg.compose(rgb, mask, "transparent", crop=True, padding=5)
    assert found and out.mode == "RGBA" and out.size == (40, 30)
    assert out.getpixel((20, 15))[3] == 255 and out.getpixel((0, 0))[3] == 0


def test_compose_color_and_mask():
    rgb, mask = _scene()
    out, _ = bg.compose(rgb, mask, "color", color="#ff0000", clean=False)
    assert out.mode == "RGB" and out.getpixel((0, 0)) == (255, 0, 0) and out.getpixel((40, 30)) == (10, 20, 30)
    out, _ = bg.compose(rgb, mask, "mask", crop=True, padding=0)
    assert out.mode == "L" and out.size == (30, 20)


def test_compose_empty_mask_no_crop():
    rgb = Image.new("RGB", (30, 20))
    out, found = bg.compose(rgb, Image.new("L", (30, 20), 0), "transparent", crop=True, padding=4)
    assert not found and out.size == (30, 20)


def test_parse_hex():
    assert bg.parse_hex("#0a1B2c") == (10, 27, 44)


@pytest.mark.parametrize(
    "patch",
    [
        {"input": ""},
        {"model": None},
        {"model": {**SPEC, "kind": "u2net"}},
        {"model": {**SPEC, "sha256": "abc"}},
        {"model": {**SPEC, "file": "../evil.onnx"}},
        {"output": "png"},
        {"output": "color", "color": "red"},
        {"padding": 501},
        {"padding": -1},
        {"padding": True},
        {"crop": "yes"},
        {"refine": 1},
    ],
)
def test_run_param_validation(tmp_path, cap, patch):
    with pytest.raises(HandlerError) as e:
        bg.run(cap.ctx, _params(tmp_path, **patch))
    assert e.value.code == "validation"


def test_run_missing_input(tmp_path, cap):
    with pytest.raises(HandlerError) as e:
        bg.run(cap.ctx, _params(tmp_path, input=str(tmp_path / "nope.png")))
    assert e.value.code == "validation"


# -- download -------------------------------------------------------------------------


def _blob(tmp_path, data=b"model-bytes" * 1000):
    src = tmp_path / "src.bin"
    src.write_bytes(data)
    return src.as_uri(), hashlib.sha256(data).hexdigest(), data


def test_download_ok(tmp_path, cap):
    url, sha, data = _blob(tmp_path)
    p = download.ensure_model(cap.ctx, str(tmp_path / "md"), "m.onnx", sha, url)
    assert open(p, "rb").read() == data
    assert not os.path.exists(p + ".part")
    prog = cap.events("progress")
    assert prog[0]["msg"] == "Downloading model" and prog[-1]["pct"] == 1.0


def test_download_skipped_when_present(tmp_path, cap):
    d = tmp_path / "md"
    d.mkdir()
    (d / "m.onnx").write_bytes(b"x")
    assert download.ensure_model(cap.ctx, str(d), "m.onnx", "0" * 64, "file:///nonexistent") == str(d / "m.onnx")


def test_download_sha_mismatch_deletes(tmp_path, cap):
    url, _sha, _ = _blob(tmp_path)
    with pytest.raises(HandlerError) as e:
        download.ensure_model(cap.ctx, str(tmp_path / "md"), "m.onnx", "f" * 64, url)
    assert e.value.message == "Model download was corrupted — try again"
    assert os.listdir(tmp_path / "md") == []


def test_download_network_error_cleans_up(tmp_path, cap):
    with pytest.raises(HandlerError) as e:
        download.ensure_model(cap.ctx, str(tmp_path / "md"), "m.onnx", "0" * 64, (tmp_path / "missing").as_uri())
    assert e.value.code == "tool_failed"
    assert os.listdir(tmp_path / "md") == []


def test_download_cancelled(tmp_path, cap):
    url, sha, _ = _blob(tmp_path)
    cap.ctx.request_cancel()
    with pytest.raises(Cancelled):
        download.ensure_model(cap.ctx, str(tmp_path / "md"), "m.onnx", sha, url)
    assert os.listdir(tmp_path / "md") == []


# -- slow: real model ---------------------------------------------------------------


@pytest.mark.slow
def test_isnet_disc_iou(tmp_path, cap):
    models = os.environ.get("TOOLBOX_BG_MODELS", r"C:\Users\nickb\repos\toolbox\.dev\p4-research\bg\models")
    f = "isnet-general-use.onnx"
    if not os.path.isfile(os.path.join(models, f)):
        pytest.skip("isnet model not available")
    yy, xx = np.mgrid[0:300, 0:400]
    disc = (yy - 150) ** 2 + (xx - 200) ** 2 < 90**2
    arr = np.full((300, 400, 3), 40, np.uint8)
    arr[disc] = (230, 60, 40)
    src = tmp_path / "disc.png"
    Image.fromarray(arr).save(src)
    params = {
        "input": str(src), "outputDir": str(tmp_path / "o"), "modelDir": models, "output": "mask",
        "model": {"file": f, "sha256": "0" * 64, "url": "https://unused", "kind": "isnet"},
    }
    res = bg.run(cap.ctx, params)
    m = np.asarray(Image.open(res["output"])) > 127
    iou = (m & disc).sum() / (m | disc).sum()
    assert iou > 0.8, iou
