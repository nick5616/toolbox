"""Object Eraser engine and handlers (SPEC.md §9.2, §13)."""

from __future__ import annotations

import os
import time

import numpy as np
import pytest
from PIL import Image

from toolbox_sidecar import eraser as eng
from toolbox_sidecar.download import ensure_model
from toolbox_sidecar.handlers import eraser as h
from toolbox_sidecar.registry import Cancelled, HandlerError

LAMA = {
    "file": "lama_fp32.onnx",
    "sha256": "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
    "url": "https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
}
MIGAN = {
    "file": "migan_pipeline_v2.onnx",
    "sha256": "6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b",
    "url": "https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx",
}


def photo(w: int, h_: int, seed: int = 1) -> np.ndarray:
    """A smooth gradient with mild noise (so unchanged pixels are meaningful)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h_, 0:w]
    img = np.stack([xx * 255 // max(w - 1, 1), yy * 255 // max(h_ - 1, 1), (xx + yy) * 255 // (w + h_ - 2)], -1)
    return np.clip(img + rng.integers(-3, 4, img.shape), 0, 255).astype(np.uint8)


def disc(shape: tuple[int, int], cx: int, cy: int, r: int) -> np.ndarray:
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r


def stub_lama(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    assert image.shape == (1, 3, 512, 512) and image.dtype == np.float32
    assert mask.shape == (1, 1, 512, 512) and mask.dtype == np.float32
    assert set(np.unique(mask)) <= {0.0, 1.0}
    assert image.max() <= 1.0
    out = np.full((1, 3, 512, 512), 128.0, np.float32)  # LaMa outputs 0..255
    return out


def stub_migan(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    assert image.dtype == np.uint8 and mask.dtype == np.uint8
    assert image.shape[2:] == mask.shape[2:]
    out = image.copy()
    out[:, :] = np.where(mask == 0, 200, image)  # 0 = hole
    return out


# -- pure helpers ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "w,h_,r",
    [(100, 100, 8), (1024, 768, 12), (2048, 1536, 24), (4000, 3000, 40), (12000, 9000, 40)],
)
def test_dilation_radius(w, h_, r):
    assert eng.dilation_radius(w, h_) == r


def test_dilate_mask_grows_and_empty():
    m = np.zeros((100, 100), bool)
    m[50, 50] = True
    d = eng.dilate_mask(m, 8)
    assert d[50, 58] and d[42, 50] and not d[50, 60]
    assert d.sum() > 150
    assert not eng.dilate_mask(np.zeros((10, 10), bool), 8).any()
    m2 = np.zeros((20, 20), bool)
    m2[0, 0] = True
    assert eng.dilate_mask(m2, 8)[8, 0]  # at the border without wrapping


def test_find_regions_and_merge():
    m = np.zeros((2000, 3000), bool)
    m[100:150, 100:150] = True
    m[120:160, 400:440] = True  # crops overlap -> merged
    m[1800:1850, 2800:2850] = True  # far -> separate
    boxes = eng.find_regions(m)
    assert len(boxes) == 3
    merged = eng.merge_regions(boxes, 3000, 2000)
    assert len(merged) == 2
    assert merged[0][:2] == (100, 100) and merged[0][2] == 340


def test_crop_square_geometry():
    # side = max(512, 2*max(w,h)), centred, shifted inside
    x0, y0, side = eng.crop_square((1000, 1000, 400, 100), 3000, 2000)
    assert side == 800 and (x0, y0) == (1200 - 400, 1050 - 400)
    x0, y0, side = eng.crop_square((0, 0, 10, 10), 3000, 2000)
    assert (x0, y0, side) == (0, 0, 512)
    x0, y0, side = eng.crop_square((2990, 1990, 10, 10), 3000, 2000)
    assert (x0, y0) == (3000 - 512, 2000 - 512)
    # small image: whole image, padded
    x0, y0, side = eng.crop_square((10, 10, 20, 20), 300, 200)
    assert side == 300 and x0 == 0 and y0 == -50


def test_extract_crop_pads_by_reflection_and_zero():
    a = np.arange(12, dtype=np.uint8).reshape(3, 4)
    c = eng.extract_crop(a, 0, -1, 4, fill=False)
    assert c.shape == (4, 4) and (c[0] == a[1]).all()
    z = eng.extract_crop(a, 0, -1, 4, fill=True)
    assert (z[0] == 0).all() and (z[1:] == a).all()


def test_feather_zero_outside():
    m = disc((100, 100), 50, 50, 20)
    a = eng.feather(m, 3.0)
    assert (a[~m] == 0).all() and a[50, 50] == pytest.approx(1.0, abs=1e-3) and 0 < a[50, 31] < 1


def test_output_format():
    assert eng.output_format("a.JPG")[1:2] == ("JPEG",)
    assert eng.output_format("a.jpeg")[0] == ".jpeg"
    assert eng.output_format("a.webp")[1] == "WEBP"
    assert eng.output_format("a.heic")[:2] == (".jpg", "JPEG")
    assert eng.output_format("a.tiff")[:2] == (".png", "PNG")
    assert eng.output_format("a.bmp")[:2] == (".png", "PNG")
    assert eng.output_format("a.png")[:2] == (".png", "PNG")


def test_load_mask_resizes_and_thresholds(tmp_path):
    m = np.zeros((50, 100), np.uint8)
    m[10:20, 20:40] = 255
    m[30:35, 60:70] = 100  # below threshold
    Image.fromarray(m).save(tmp_path / "m.png")
    out = eng.load_mask(str(tmp_path / "m.png"), (200, 100))
    assert out.shape == (100, 200) and out[30, 60] and out.sum() == 10 * 20 * 4
    assert not out[65, 130]


def test_load_mask_transparent_not_painted(tmp_path):
    rgba = np.zeros((10, 10, 4), np.uint8)
    rgba[..., :3] = 255  # white but fully transparent
    Image.fromarray(rgba).save(tmp_path / "m.png")
    assert not eng.load_mask(str(tmp_path / "m.png"), (10, 10)).any()


# -- inpainting with stub models ----------------------------------------------------------


def test_inpaint_best_outside_identical_and_regions():
    img = photo(1600, 1200)
    mask = np.zeros((1200, 1600), bool)
    mask |= disc(mask.shape, 200, 200, 40)
    mask |= disc(mask.shape, 1400, 1000, 40)
    dil = eng.dilate_mask(mask, eng.dilation_radius(1600, 1200))
    out, regions = eng.inpaint_best(img, dil, stub_lama)
    assert regions == 2
    assert out.dtype == np.uint8 and out.shape == img.shape
    assert (out[~dil] == img[~dil]).all()  # byte-identical outside the dilated mask
    assert abs(int(out[200, 200, 0]) - 128) <= 2  # filled inside
    assert not (out[dil] == img[dil]).all()


def test_inpaint_best_small_image_padded():
    img = photo(300, 200)
    mask = disc((200, 300), 150, 100, 15)
    dil = eng.dilate_mask(mask, 8)
    out, regions = eng.inpaint_best(img, dil, stub_lama)
    assert regions == 1 and out.shape == img.shape
    assert (out[~dil] == img[~dil]).all()
    assert abs(int(out[100, 150, 1]) - 128) <= 2


def test_inpaint_best_mask_at_border():
    img = photo(1600, 1200)
    mask = np.zeros((1200, 1600), bool)
    mask[0:30, 0:30] = True
    mask[1170:1200, 1570:1600] = True
    out, regions = eng.inpaint_best(img, mask, stub_lama)
    assert regions == 2
    assert (out[~mask] == img[~mask]).all()


def test_inpaint_fast_inverts_mask_and_keeps_outside():
    img = photo(640, 480)
    mask = disc((480, 640), 320, 240, 30)
    out, regions = eng.inpaint_fast(img, mask, stub_migan)
    assert regions == 1
    assert (out[~mask] == img[~mask]).all()
    assert abs(int(out[240, 320, 0]) - 200) <= 1


class CancelCtx:
    def __init__(self, cancel_after: int):
        self.n, self.cancel_after = 0, cancel_after
        self.progress_calls: list[tuple[float, str]] = []

    def check_cancelled(self):
        self.n += 1
        if self.n > self.cancel_after:
            raise Cancelled()

    def progress(self, pct, msg="", *, force=False):
        self.progress_calls.append((pct, msg))


def test_inpaint_best_progress_and_cancel_between_regions():
    img = photo(1600, 1200)
    mask = np.zeros((1200, 1600), bool)
    mask[100:140, 100:140] = True
    mask[1000:1040, 1400:1440] = True
    ctx = CancelCtx(10)
    eng.inpaint_best(img, mask, stub_lama, ctx)  # type: ignore[arg-type]
    assert [m for _p, m in ctx.progress_calls] == ["Erasing area 1 of 2", "Erasing area 2 of 2"]
    calls = []

    def counting(i, m):
        calls.append(1)
        return stub_lama(i, m)

    with pytest.raises(Cancelled):
        eng.inpaint_best(img, mask, counting, CancelCtx(1))  # type: ignore[arg-type]
    assert len(calls) == 1  # stopped before the second region


# -- handler -------------------------------------------------------------------------------


def _setup(tmp_path, name="shot.png", size=(400, 300), model_file="m.onnx"):
    arr = photo(*size)
    src = tmp_path / name
    Image.fromarray(arr).save(src)
    mask = np.zeros((size[1], size[0]), np.uint8)
    mask[disc(mask.shape, size[0] // 2, size[1] // 2, 20)] = 255
    Image.fromarray(mask).save(tmp_path / "mask.png")
    model = tmp_path / model_file
    model.write_bytes(b"x")
    return {
        "path": str(src),
        "mask": str(tmp_path / "mask.png"),
        "out": str(tmp_path / "out"),
        "model": "best",
        "modelPath": str(model),
    }, arr, mask > 0


@pytest.fixture
def stubbed(monkeypatch):
    monkeypatch.setattr(eng, "lama_runner", lambda _p: stub_lama)
    monkeypatch.setattr(eng, "migan_runner", lambda _p: stub_migan)


def test_handler_png_outside_identical(tmp_path, cap, stubbed):
    params, arr, mask = _setup(tmp_path)
    res = h.inpaint(cap.ctx, params)
    assert res["regions"] == 1 and res["warning"] == ""
    assert os.path.basename(res["output"]) == "shot (erased).png"
    out = np.asarray(Image.open(res["output"]).convert("RGB"))
    dil = eng.dilate_mask(mask, eng.dilation_radius(400, 300))
    assert (out[~dil] == arr[~dil]).all()
    assert not (out[mask] == arr[mask]).all()
    assert [e["path"] for e in cap.events("output")] == [res["output"]]


def test_handler_does_not_modify_input_and_unique_names(tmp_path, cap, stubbed):
    params, _arr, _m = _setup(tmp_path)
    before = (tmp_path / "shot.png").read_bytes()
    a = h.inpaint(cap.ctx, params)["output"]
    b = h.inpaint(cap.ctx, params)["output"]
    assert a != b and os.path.exists(a) and os.path.exists(b)
    assert (tmp_path / "shot.png").read_bytes() == before


def test_handler_fast_model(tmp_path, cap, stubbed):
    params, arr, mask = _setup(tmp_path)
    params["model"] = "fast"
    res = h.inpaint(cap.ctx, params)
    out = np.asarray(Image.open(res["output"]).convert("RGB"))
    assert abs(int(out[150, 200, 0]) - 200) <= 1


def test_handler_jpeg_keeps_exif_icc_drops_orientation(tmp_path, cap, stubbed):
    params, arr, _m = _setup(tmp_path, name="p.jpg")
    im = Image.fromarray(arr)
    exif = Image.Exif()
    exif[0x010F] = "TestMaker"
    exif[0x0112] = 1
    icc = b"\x00" * 128
    im.save(tmp_path / "p.jpg", quality=95, exif=exif.tobytes())
    res = h.inpaint(cap.ctx, params)
    assert res["output"].endswith("p (erased).jpg")
    out = Image.open(res["output"])
    assert out.getexif().get(0x010F) == "TestMaker"
    assert 0x0112 not in out.getexif()


def test_handler_applies_exif_orientation(tmp_path, cap, stubbed):
    arr = photo(300, 200)
    im = Image.fromarray(arr)
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW on display -> 200x300
    src = tmp_path / "r.jpg"
    im.save(src, quality=95, exif=exif.tobytes())
    mask = np.zeros((300, 200), np.uint8)
    mask[100:140, 80:120] = 255
    Image.fromarray(mask).save(tmp_path / "mask.png")
    (tmp_path / "m.onnx").write_bytes(b"x")
    res = h.inpaint(
        cap.ctx,
        {"path": str(src), "mask": str(tmp_path / "mask.png"), "out": str(tmp_path / "o"), "model": "best", "modelPath": str(tmp_path / "m.onnx")},
    )
    assert Image.open(res["output"]).size == (200, 300)


def test_handler_webp_tiff_and_alpha(tmp_path, cap, stubbed):
    params, arr, _m = _setup(tmp_path, name="a.webp")
    Image.fromarray(arr).save(tmp_path / "a.webp", quality=95)
    assert h.inpaint(cap.ctx, params)["output"].endswith("a (erased).webp")
    params, arr, _m = _setup(tmp_path, name="a.tiff")
    Image.fromarray(arr).save(tmp_path / "a.tiff")
    assert h.inpaint(cap.ctx, params)["output"].endswith("a (erased).png")
    # alpha channel is carried through unchanged
    rgba = np.dstack([arr, np.full(arr.shape[:2], 77, np.uint8)])
    params, _a, _m = _setup(tmp_path, name="al.png")
    Image.fromarray(rgba, "RGBA").save(tmp_path / "al.png")
    out = Image.open(h.inpaint(cap.ctx, params)["output"])
    assert out.mode == "RGBA" and (np.asarray(out)[..., 3] == 77).all()


def test_handler_large_area_warning(tmp_path, cap, stubbed):
    params, _a, _m = _setup(tmp_path)
    mask = np.zeros((300, 400), np.uint8)
    mask[20:280, 20:380] = 255
    Image.fromarray(mask).save(tmp_path / "mask.png")
    assert h.inpaint(cap.ctx, params)["warning"] == "Large areas may look smeared"


def test_handler_mask_size_mismatch_is_resized(tmp_path, cap, stubbed):
    params, _a, _m = _setup(tmp_path)
    mask = np.zeros((150, 200), np.uint8)
    mask[60:90, 80:120] = 255
    Image.fromarray(mask).save(tmp_path / "mask.png")
    assert h.inpaint(cap.ctx, params)["regions"] == 1


@pytest.mark.parametrize(
    "patch,code",
    [
        ({"path": ""}, "validation"),
        ({"model": "medium"}, "validation"),
        ({"modelPath": "nope.onnx"}, "validation"),
        ({"mask": "nope.png"}, "validation"),
        ({"path": "nope.png"}, "validation"),
        ({"out": ""}, "validation"),
    ],
)
def test_handler_param_validation(tmp_path, cap, stubbed, patch, code):
    params, _a, _m = _setup(tmp_path)
    params.update(patch)
    with pytest.raises(HandlerError) as e:
        h.inpaint(cap.ctx, params)
    assert e.value.code == code


def test_handler_empty_mask_rejected(tmp_path, cap, stubbed):
    params, _a, _m = _setup(tmp_path)
    Image.fromarray(np.zeros((300, 400), np.uint8)).save(tmp_path / "mask.png")
    with pytest.raises(HandlerError) as e:
        h.inpaint(cap.ctx, params)
    assert e.value.message == "Paint over what to erase first"


def test_handler_cancelled_leaves_no_output(tmp_path, cap, stubbed):
    params, _a, _m = _setup(tmp_path)
    cap.ctx.request_cancel()
    with pytest.raises(Cancelled):
        h.inpaint(cap.ctx, params)
    assert not os.path.exists(params["out"]) or os.listdir(params["out"]) == []


def test_handler_model_load_failure(tmp_path, cap, monkeypatch):
    def boom(_p):
        raise RuntimeError("bad onnx")

    monkeypatch.setattr(eng, "lama_runner", boom)
    params, _a, _m = _setup(tmp_path)
    with pytest.raises(HandlerError) as e:
        h.inpaint(cap.ctx, params)
    assert e.value.code == "tool_failed"


def test_prefetch_downloads_and_verifies(tmp_path, cap):
    import hashlib

    data = b"model" * 100
    src = tmp_path / "src.bin"
    src.write_bytes(data)
    spec = {"file": "x.onnx", "sha256": hashlib.sha256(data).hexdigest(), "url": src.as_uri()}
    res = h.prefetch(cap.ctx, {"modelDir": str(tmp_path / "md"), "model": spec})
    assert res["path"] == str(tmp_path / "md" / "x.onnx") and os.path.isfile(res["path"])
    with pytest.raises(HandlerError):
        h.prefetch(cap.ctx, {"modelDir": str(tmp_path / "md2"), "model": {**spec, "sha256": "f" * 64}})
    with pytest.raises(HandlerError):
        h.prefetch(cap.ctx, {"modelDir": str(tmp_path / "md3"), "model": {**spec, "file": "../x"}})
    assert not os.path.exists(tmp_path / "md2" / "x.onnx")


# -- slow: real models ---------------------------------------------------------------------


@pytest.fixture(scope="module")
def real_models(tmp_path_factory, request):
    d = os.environ.get("TOOLBOX_ERASER_MODELS") or str(tmp_path_factory.mktemp("eraser-models"))

    class Quiet:
        def stage(self, *_a):
            pass

        def progress(self, *_a, **_k):
            pass

        def check_cancelled(self):
            pass

    return {
        "best": ensure_model(Quiet(), d, LAMA["file"], LAMA["sha256"], LAMA["url"]),  # type: ignore[arg-type]
        "fast": ensure_model(Quiet(), d, MIGAN["file"], MIGAN["sha256"], MIGAN["url"]),  # type: ignore[arg-type]
    }


def _scene(w, h_):
    """A smooth backdrop with a dark object that LaMa must remove without a ghost."""
    arr = photo(w, h_).astype(np.int16)
    yy, xx = np.mgrid[0:h_, 0:w]
    obj = ((xx - w // 2) / (w * 0.06)) ** 2 + ((yy - h_ // 2) / (h_ * 0.18)) ** 2 <= 1
    arr[obj] = (20, 20, 20)
    return arr.clip(0, 255).astype(np.uint8), obj


@pytest.mark.slow
@pytest.mark.parametrize("model", ["best", "fast"])
def test_real_model_removes_object(tmp_path, cap, real_models, model):
    w, h_ = 1024, 768
    arr, obj = _scene(w, h_)
    src = tmp_path / "scene.png"
    Image.fromarray(arr).save(src)
    Image.fromarray((obj * 255).astype(np.uint8)).save(tmp_path / "mask.png")
    t0 = time.perf_counter()
    res = h.inpaint(
        cap.ctx,
        {"path": str(src), "mask": str(tmp_path / "mask.png"), "out": str(tmp_path / "o"), "model": model, "modelPath": real_models[model]},
    )
    out = np.asarray(Image.open(res["output"]).convert("RGB")).astype(np.float32)
    # the dark object (luma 20) must be gone: the filled area follows the smooth backdrop
    clean = photo(w, h_).astype(np.float32)
    err = np.abs(out[obj] - clean[obj]).mean()
    assert err < 45, f"{model}: mean error {err:.1f} (object ghost remains)"
    assert out[obj].mean() > 60
    dil = eng.dilate_mask(obj, eng.dilation_radius(w, h_))
    assert (out[~dil] == arr[~dil]).all()


@pytest.mark.slow
def test_real_best_large_photo_speed(tmp_path, cap, real_models):
    w, h_ = 4000, 3000  # 12 MP
    arr, obj = _scene(w, h_)
    src = tmp_path / "big.jpg"
    Image.fromarray(arr).save(src, quality=95)
    mask = np.zeros((h_, w), np.uint8)
    mask[obj] = 255
    Image.fromarray(mask).save(tmp_path / "mask.png")
    t0 = time.perf_counter()
    res = h.inpaint(
        cap.ctx,
        {"path": str(src), "mask": str(tmp_path / "mask.png"), "out": str(tmp_path / "o"), "model": "best", "modelPath": real_models["best"]},
    )
    elapsed = time.perf_counter() - t0
    assert res["regions"] == 1
    assert elapsed < 10, f"{elapsed:.1f}s"
