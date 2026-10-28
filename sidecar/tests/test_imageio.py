"""imageio.load_image / image.convert."""

from __future__ import annotations

import os

import numpy as np
import pytest
from PIL import Image, ImageCms

from toolbox_sidecar import imageio
from toolbox_sidecar.handlers import image as image_handler
from toolbox_sidecar.registry import HandlerError


def _gradient(w=40, h=30):
    a = np.zeros((h, w, 3), np.uint8)
    a[..., 0] = np.linspace(0, 255, w, dtype=np.uint8)[None, :]
    a[..., 1] = np.linspace(0, 255, h, dtype=np.uint8)[:, None]
    return Image.fromarray(a)


def test_png_rgb_and_rgba(tmp_path):
    p = tmp_path / "a.png"
    _gradient().save(p)
    assert imageio.load_image(str(p)).mode == "RGB"
    q = tmp_path / "b.png"
    _gradient().convert("RGBA").save(q)
    assert imageio.load_image(str(q)).mode == "RGBA"


def test_palette_and_gray_modes(tmp_path):
    p = tmp_path / "p.png"
    _gradient().convert("P").save(p)
    assert imageio.load_image(str(p)).mode == "RGB"
    g = tmp_path / "g.png"
    _gradient().convert("L").save(g)
    assert imageio.load_image(str(g)).mode == "RGB"
    t = tmp_path / "t.png"
    Image.new("P", (4, 4), 0).save(t, transparency=0)
    assert imageio.load_image(str(t)).mode == "RGBA"


def test_exif_orientation_applied(tmp_path):
    im = _gradient(40, 30)
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW on display
    p = tmp_path / "o.jpg"
    im.save(p, exif=exif)
    assert imageio.load_image(str(p)).size == (30, 40)


def test_icc_converted_to_srgb(tmp_path):
    prof = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
    p = tmp_path / "i.png"
    _gradient().save(p, icc_profile=prof.tobytes())
    im = imageio.load_image(str(p))
    assert im.mode == "RGB" and im.size == (40, 30)


def test_heic_round_trip(tmp_path):
    p = tmp_path / "x.heic"
    imageio.register_heif()
    _gradient(64, 48).save(p, format="HEIF", quality=90)
    im = imageio.load_image(str(p))
    assert im.size == (64, 48) and im.mode == "RGB"


def test_unreadable(tmp_path):
    p = tmp_path / "bad.png"
    p.write_bytes(b"not an image")
    with pytest.raises(HandlerError) as e:
        imageio.load_image(str(p))
    assert e.value.code == "validation" and e.value.message == "Couldn't read this image"


def test_save_unique_never_overwrites(tmp_path):
    im = _gradient()
    a = imageio.save_unique(im, str(tmp_path), "x (mask)", "png", "PNG")
    b = imageio.save_unique(im, str(tmp_path), "x (mask)", "png", "PNG")
    assert os.path.basename(a) == "x (mask).png" and os.path.basename(b) == "x (mask) (1).png"


def test_image_convert(tmp_path, cap):
    src = tmp_path / "s.png"
    _gradient().convert("RGBA").save(src)
    dst = tmp_path / "sub" / "out.png"
    res = image_handler.convert(cap.ctx, {"input": str(src), "output": str(dst)})
    assert res == {"width": 40, "height": 30}
    assert Image.open(dst).mode == "RGBA"
    assert not (tmp_path / "sub" / "out.png.part").exists()


def test_image_convert_validation(tmp_path, cap):
    with pytest.raises(HandlerError) as e:
        image_handler.convert(cap.ctx, {"input": str(tmp_path / "none.png"), "output": str(tmp_path / "o.png")})
    assert e.value.code == "validation"
    with pytest.raises(HandlerError):
        image_handler.convert(cap.ctx, {"input": "x"})
