"""Redact: box decoding/NMS, the tracker, rendering, image + video apply, cancellation.

The slow tests run the real pinned models (set TOOLBOX_SLOW=1). Models come from
$TOOLBOX_REDACT_MODELS, else are downloaded (sha-verified) into a pytest cache dir.
Photo samples live in .dev/p6-research/samples and are skipped when absent.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from toolbox_sidecar.download import ensure_model
from toolbox_sidecar.handlers import redact as h
from toolbox_sidecar.redact import detect, render, track
from toolbox_sidecar.registry import HANDLERS, Cancelled, HandlerError

def _find_samples() -> Path:
    """.dev/p6-research/samples of the repo (the worktree sits under <repo>/.claude/worktrees)."""
    for parent in Path(__file__).resolve().parents:
        cand = parent / ".dev" / "p6-research" / "samples"
        if cand.is_dir():
            return cand
    return Path(os.environ.get("TOOLBOX_REDACT_SAMPLES", "samples-not-found"))


SAMPLES = _find_samples()

FACE = {
    "file": "face_detection_yunet_2023mar.onnx",
    "url": "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
    "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
}
PLATE = {
    "file": "yolo-v9-t-640-license-plates-end2end.onnx",
    "url": "https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-640-license-plates-end2end.onnx",
    "sha256": "c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076",
}

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


def test_registered():
    for name in ("detect_image", "detect_video", "apply_image", "apply_video", "prefetch"):
        assert f"redact.{name}" in HANDLERS


# -- boxes and NMS -----------------------------------------------------------------------


def test_nms_keeps_best_of_overlapping_and_all_disjoint():
    boxes = [(0, 0, 10, 10, 0.9), (1, 1, 11, 11, 0.8), (50, 50, 60, 60, 0.7)]
    kept = detect.nms(boxes, 0.3)
    assert [b[4] for b in kept] == [0.9, 0.7]
    assert detect.nms([], 0.3) == []


def test_clip_box_drops_slivers():
    assert detect.clip_box((-5, -5, 10, 10, 0.5), 100, 100) == (0.0, 0.0, 10.0, 10.0, 0.5)
    assert detect.clip_box((99.5, 0, 120, 10, 0.5), 100, 100) is None


def test_decode_yunet_synthetic_heads():
    # 64x64 input: stride 8 -> 8x8 cells. One cell (row 2, col 3) fires.
    names, outs = [], []
    for st in (8, 16, 32):
        n = (64 // st) ** 2
        cls, obj = np.zeros((1, n, 1), np.float32), np.zeros((1, n, 1), np.float32)
        bbox = np.zeros((1, n, 4), np.float32)
        if st == 8:
            i = 2 * 8 + 3
            cls[0, i, 0] = obj[0, i, 0] = 0.81
            bbox[0, i] = [0.5, 0.25, np.log(2.0), np.log(3.0)]
        names += [f"cls_{st}", f"obj_{st}", f"bbox_{st}", f"kps_{st}"]
        outs += [cls, obj, bbox, np.zeros((1, n, 10), np.float32)]
    got = detect.decode_yunet(outs, names, 64, 64, 0.6)
    assert len(got) == 1
    x1, y1, x2, y2, score = got[0]
    cx, cy = (3 + 0.5) * 8, (2 + 0.25) * 8
    assert (x1, y1, x2, y2) == pytest.approx((cx - 8, cy - 12, cx + 8, cy + 12))
    assert score == pytest.approx(0.81, abs=1e-3)
    assert detect.decode_yunet(outs, names, 64, 64, 0.9) == []


def test_letterbox_and_plate_decoding_round_trip():
    img = np.zeros((300, 600, 3), np.uint8)
    canvas, r, left, top = detect.letterbox(img, 640)
    assert canvas.shape == (640, 640, 3)
    assert r == pytest.approx(640 / 600)
    assert canvas[0, 0, 0] == 114  # grey bars
    # a plate at (100, 50)-(200, 100) in the source, as the model would report it
    rows = np.array([[0, left + 100 * r, top + 50 * r, left + 200 * r, top + 100 * r, 0, 0.8], [0, 1, 2, 3, 4, 0, 0.1]])
    got = detect.decode_plates(rows, r, left, top, 0.3)
    assert len(got) == 1
    assert got[0][:4] == pytest.approx((100, 50, 200, 100), abs=1)


def test_tile_rects_cover_the_image_with_overlap():
    tiles = detect.tile_rects(2000, 1000)
    assert len(tiles) == 4
    assert min(t[0] for t in tiles) == 0 and max(t[2] for t in tiles) == 2000
    assert min(t[1] for t in tiles) == 0 and max(t[3] for t in tiles) == 1000
    left, right = tiles[0], tiles[1]
    assert (left[2] - right[0]) / (left[2] - left[0]) == pytest.approx(0.2, abs=0.01)


def test_protobuf_round_trip_and_dim_patch():
    # A tiny ModelProto: graph { input "input" [1,3,640,640]; output "o" [1,5,1]; value_info }.
    def varint_field(f, v):
        return (f, 0, v)

    def dim(v):
        return detect._encode([varint_field(1, v)])

    def value_info(name, dims):
        shape = detect._encode([(1, 2, dim(d)) for d in dims])
        tensor = detect._encode([varint_field(1, 1), (2, 2, shape)])
        tp = detect._encode([(1, 2, tensor)])
        return detect._encode([(1, 2, name.encode()), (2, 2, tp)])

    graph = detect._encode(
        [(11, 2, value_info("input", [1, 3, 640, 640])), (12, 2, value_info("o", [1, 5, 1])), (13, 2, value_info("v", [1, 2]))]
    )
    model = detect._encode([varint_field(1, 8), (7, 2, graph)])
    assert detect._encode(detect._parse(model)) == model
    patched = detect.make_dynamic(model)
    g = next(v for f, _, v in detect._parse(patched) if f == 7)
    fields = detect._parse(g)
    assert [f for f, _, _ in fields] == [11, 12]  # value_info dropped

    def dims_of(vi):
        tp = next(v for f, _, v in detect._parse(vi) if f == 2)
        tensor = next(v for f, _, v in detect._parse(tp) if f == 1)
        shape = next(v for f, _, v in detect._parse(tensor) if f == 2)
        return [detect._parse(v) for f, _, v in detect._parse(shape) if f == 1]

    assert dims_of(fields[0][2]) == [[(1, 0, 1)], [(1, 0, 3)], [(2, 2, b"H")], [(2, 2, b"W")]]
    assert dims_of(fields[1][2]) == [[(1, 0, 1)], [(2, 2, b"N_o")], [(1, 0, 1)]]


# -- tracker -----------------------------------------------------------------------------


def det(x, y, w=0.1, h=0.1, s=0.9, kind="face"):
    return (kind, x, y, w, h, s)


def seq(dets_by_frame, step=100):
    return [(i * step, d) for i, d in enumerate(dets_by_frame)]


def test_tracker_links_a_moving_box_into_one_track():
    frames = seq([[det(0.10 + 0.01 * i, 0.3)] for i in range(10)])
    tracks = track.build_tracks(frames, frame_ms=100)
    assert len(tracks) == 1
    t = tracks[0]
    assert t["kind"] == "face" and t["enabled"] and t["nHits"] == 10
    ms = [hh["ms"] for hh in t["hits"]]
    assert ms[0] == 0 and ms[-1] == 900 + track.EXTEND_MS  # extended 200 ms at the end


def test_tracker_separates_kinds_and_distant_boxes():
    frames = seq([[det(0.1, 0.1), det(0.7, 0.7), det(0.1, 0.1, kind="plate")] for _ in range(5)])
    tracks = track.build_tracks(frames, frame_ms=100)
    assert sorted(t["kind"] for t in tracks) == ["face", "face", "plate"]


def test_tracker_interpolates_gaps_up_to_half_a_second():
    frames = seq([[det(0.1, 0.1)], [det(0.1, 0.1)], [], [], [det(0.5, 0.1)], [det(0.5, 0.1)]])
    # hit at 100 ms then 400 ms: the box jumped too far to link (centre 0.4 > 0.5 diag? no: 0.4/0.14 > 0.5)
    tracks = track.build_tracks(frames, frame_ms=100)
    assert len(tracks) == 2  # distance matching refused the jump

    frames = seq([[det(0.1, 0.1)], [det(0.1, 0.1)], [], [], [det(0.14, 0.1)], [det(0.14, 0.1)]])
    tracks = track.build_tracks(frames, frame_ms=100)
    assert len(tracks) == 1
    xs = {hh["ms"]: hh["x"] for hh in tracks[0]["hits"]}
    assert 200 in xs and 300 in xs  # the missing samples were filled
    assert xs[200] < xs[300] < xs[400] + 1e-9


def test_tracker_ends_after_half_a_second_without_a_hit():
    frames = seq([[det(0.1, 0.1)]] * 3 + [[]] * 8 + [[det(0.1, 0.1)]] * 3)
    tracks = track.build_tracks(frames, frame_ms=100)
    assert len(tracks) == 2


def test_tracker_disables_short_low_score_tracks_only():
    frames = seq([[det(0.1, 0.1, s=0.7), det(0.6, 0.6, s=0.95)], [det(0.1, 0.1, s=0.7), det(0.6, 0.6, s=0.95)]])
    tracks = {t["maxScore"]: t for t in track.build_tracks(frames, frame_ms=100)}
    assert tracks[0.7]["enabled"] is False  # 2 hits, weak
    assert tracks[0.95]["enabled"] is True  # 2 hits, but >= 0.9


def test_box_at_interpolates_and_stops_outside():
    hits = [{"ms": 0, "x": 0, "y": 0, "w": 0.1, "h": 0.1}, {"ms": 100, "x": 1, "y": 0, "w": 0.1, "h": 0.1}]
    assert track.box_at(hits, 50) == pytest.approx((0.5, 0, 0.1, 0.1))
    assert track.box_at(hits, 100) == pytest.approx((1, 0, 0.1, 0.1))
    assert track.box_at(hits, -1) is None and track.box_at(hits, 101) is None


def test_summarize_samples_every_200ms():
    tracks = track.build_tracks(seq([[det(0.1, 0.1)]] * 10, step=100), frame_ms=100)
    s = track.summarize(tracks[0])
    assert s["startMs"] == 0 and s["endMs"] == 1100
    assert [x["ms"] for x in s["samples"]][:4] == [0, 200, 400, 600]
    assert s["samples"][-1]["ms"] == s["endMs"]


# -- rendering ---------------------------------------------------------------------------


def noise(h=120, w=160, seed=1):
    return np.random.default_rng(seed).integers(0, 256, (h, w, 3), dtype=np.uint8)


def test_region_padding_and_clipping():
    b = {"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2}
    assert render.region_for(b, "plate", 0, 100, 100) == (40, 40, 60, 60, False)
    assert render.region_for(b, "face", 50, 100, 100) == (30, 30, 70, 70, True)
    edge = {"x": 0.9, "y": 0.9, "w": 0.2, "h": 0.2}
    assert render.region_for(edge, "plate", 15, 100, 100) == (87, 87, 100, 100, False)
    assert render.region_for({"x": 2, "y": 2, "w": 0.1, "h": 0.1}, "plate", 0, 100, 100) is None
    assert render.region_for({"x": 0.1, "y": 0.1, "w": 0, "h": 0.1}, "plate", 0, 100, 100) is None


@pytest.mark.parametrize("style", render.STYLES)
@pytest.mark.parametrize("kind", ["face", "plate"])
def test_effects_only_change_pixels_inside_the_box(style, kind):
    src = noise()
    arr = src.copy()
    region = render.region_for({"x": 0.25, "y": 0.25, "w": 0.4, "h": 0.4}, kind, 15, 160, 120)
    render.apply_regions(arr, [region], style, 6)
    x0, y0, x1, y1, _ = region
    mask = np.zeros(src.shape[:2], bool)
    mask[y0:y1, x0:x1] = True
    assert (arr[~mask] == src[~mask]).all()
    assert (arr[mask] != src[mask]).any()


def test_solid_is_black_blur_and_pixelate_destroy_detail():
    src = noise()
    region = render.region_for({"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}, "plate", 0, 160, 120)
    x0, y0, x1, y1, _ = region
    solid = render.apply_regions(src.copy(), [region], "solid", 6)
    assert solid[y0:y1, x0:x1].max() == 0
    blur = render.apply_regions(src.copy(), [region], "blur", 6)
    assert blur[y0:y1, x0:x1].std() < src[y0:y1, x0:x1].std() / 4
    pix = render.apply_regions(src.copy(), [region], "pixelate", 6)
    bs = render.pixel_block(6, min(y1 - y0, x1 - x0))
    assert bs >= 2
    tile = pix[y0 : y0 + bs, x0 : x0 + bs]
    assert (tile == tile[0, 0]).all()  # one flat colour per block


def test_big_blur_is_fast_and_still_destroys_detail():
    import time

    src = noise(1080, 1920)
    region = render.region_for({"x": 0.2, "y": 0.2, "w": 0.5, "h": 0.5}, "plate", 15, 1920, 1080)
    x0, y0, x1, y1, _ = region
    t = time.time()
    out = render.apply_regions(src.copy(), [region], "blur", 10)
    assert time.time() - t < 1.0  # a full-size sigma-60 Gaussian takes ~1 s per frame
    assert out[y0:y1, x0:x1].std() < 10


def test_face_ellipse_leaves_the_box_corners_alone():
    src = noise()
    region = render.region_for({"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}, "face", 0, 160, 120)
    x0, y0, x1, y1, _ = region
    out = render.apply_regions(src.copy(), [region], "solid", 6)
    assert (out[y0, x0] == src[y0, x0]).all()  # corner untouched
    assert out[(y0 + y1) // 2, (x0 + x1) // 2].max() == 0  # centre black


def test_blur_strength_grows_sigma_and_pixel_block():
    assert render.blur_sigma(10, 100) > render.blur_sigma(1, 100)
    assert render.pixel_block(10, 100) > render.pixel_block(1, 100)
    assert render.blur_sigma(6, 100) == pytest.approx(13.6)


@pytest.mark.parametrize(
    "name,want",
    [("a.JPG", ".jpg"), ("a.jpeg", ".jpg"), ("a.png", ".png"), ("a.webp", ".webp"), ("a.tif", ".png"),
     ("a.tiff", ".png"), ("a.HEIC", ".jpg"), ("a.heif", ".jpg"), ("a.bmp", ".bmp")],
)
def test_output_extension(name, want):
    assert render.output_extension(name) == want


# -- apply_image -------------------------------------------------------------------------


def exif_jpeg(path: Path, orientation=6, gps=True) -> None:
    im = Image.fromarray(noise(80, 120))
    ex = Image.Exif()
    ex[0x0112] = orientation
    ex[0x010F] = "ACME"  # Make
    ex[0x0110] = "Cam 9"  # Model
    if gps:
        ex.get_ifd(0x8825)[1] = "N"
        ex.get_ifd(0x8825)[2] = (51.0, 30.0, 0.0)
    im.save(path, quality=95, exif=ex.tobytes())


def run_apply(cap, src, out, boxes, **kw):
    params = {"path": str(src), "out": str(out), "boxes": boxes, "style": "solid", "strength": 6, "padding": 0,
              "stripMetadata": True, **kw}
    return h.apply_image(cap.ctx, params)


def test_apply_image_png_changes_nothing_outside_the_padded_boxes(cap, tmp_path):
    src = tmp_path / "in.png"
    arr = noise()
    Image.fromarray(arr).save(src)
    box = {"id": "p1", "x": 0.25, "y": 0.25, "w": 0.4, "h": 0.4, "kind": "plate", "enabled": True, "score": 0.9}
    off = {**box, "id": "p2", "x": 0.0, "y": 0.0, "w": 0.1, "h": 0.1, "enabled": False}
    out = tmp_path / "in (redacted).png"
    res = run_apply(cap, src, out, [box, off], padding=15)
    assert res["applied"] == 1 and cap.events("output") == [{"path": str(out)}]
    got = np.asarray(Image.open(out).convert("RGB"))
    x0, y0, x1, y1, _ = render.region_for(box, "plate", 15, 160, 120)
    mask = np.zeros(arr.shape[:2], bool)
    mask[y0:y1, x0:x1] = True
    assert (got[~mask] == arr[~mask]).all()
    assert got[mask].max() == 0
    assert (np.asarray(Image.open(src)) == arr).all()  # input untouched


def test_apply_image_applies_exif_orientation_and_strips_metadata(cap, tmp_path):
    src = tmp_path / "photo.jpg"
    exif_jpeg(src)
    out = tmp_path / "photo (redacted).jpg"
    res = run_apply(cap, src, out, [])
    assert (res["width"], res["height"]) == (80, 120)  # rotated upright
    with Image.open(out) as im:
        assert im.size == (80, 120)
        assert len(im.getexif()) == 0
        assert "exif" not in im.info and "xmp" not in im.info and "photoshop" not in im.info


def test_apply_image_keeps_exif_but_not_gps_when_not_stripping(cap, tmp_path):
    src = tmp_path / "photo.jpg"
    exif_jpeg(src)
    out = tmp_path / "photo (redacted).jpg"
    run_apply(cap, src, out, [], stripMetadata=False)
    with Image.open(out) as im:
        ex = im.getexif()
        assert ex.get(0x010F) == "ACME" and ex.get(0x0110) == "Cam 9"
        assert 0x8825 not in ex
        assert 0x0112 not in ex


def test_apply_image_keeps_the_icc_profile(cap, tmp_path):
    from PIL import ImageCms

    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    src = tmp_path / "a.png"
    Image.fromarray(noise()).save(src, icc_profile=icc)
    out = tmp_path / "a (redacted).png"
    run_apply(cap, src, out, [])
    with Image.open(out) as im:
        assert im.info.get("icc_profile")


def test_apply_image_keeps_alpha(cap, tmp_path):
    rgba = np.dstack([noise(), np.full((120, 160), 77, np.uint8)])
    src = tmp_path / "a.png"
    Image.fromarray(rgba).save(src)
    out = tmp_path / "a (redacted).png"
    run_apply(cap, src, out, [{"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3, "kind": "plate", "enabled": True}])
    got = np.asarray(Image.open(out))
    assert got.shape[2] == 4 and (got[..., 3] == 77).all()


@pytest.mark.parametrize("ext,fmt", [(".webp", "WEBP"), (".bmp", "BMP"), (".jpg", "JPEG")])
def test_apply_image_formats(cap, tmp_path, ext, fmt):
    src = tmp_path / f"a{ext}"
    Image.fromarray(noise()).save(src)
    out = tmp_path / f"a (redacted){ext}"
    run_apply(cap, src, out, [])
    with Image.open(out) as im:
        assert im.format == fmt


def test_apply_image_tiff_input_becomes_png(cap, tmp_path):
    src = tmp_path / "a.tiff"
    Image.fromarray(noise()).save(src)
    out = tmp_path / "a (redacted).png"
    run_apply(cap, src, out, [])
    with Image.open(out) as im:
        assert im.format == "PNG"


def test_apply_image_validation(cap, tmp_path):
    src = tmp_path / "a.png"
    Image.fromarray(noise()).save(src)
    with pytest.raises(HandlerError) as e:
        run_apply(cap, src, tmp_path / "o.png", [{"x": 0, "y": 0, "w": 0, "h": 1}])
    assert e.value.code == "validation"
    with pytest.raises(HandlerError):
        run_apply(cap, src, tmp_path / "o.png", [], style="sparkle")
    with pytest.raises(HandlerError):
        run_apply(cap, src, tmp_path / "o.png", [], strength=11)
    with pytest.raises(HandlerError):
        run_apply(cap, src, tmp_path / "o.png", [], padding=51)
    with pytest.raises(HandlerError):
        run_apply(cap, tmp_path / "missing.png", tmp_path / "o.png", [])
    (tmp_path / "taken.png").write_bytes(b"x")
    with pytest.raises(HandlerError):  # never overwrite
        run_apply(cap, src, tmp_path / "taken.png", [])
    assert (tmp_path / "taken.png").read_bytes() == b"x"


def test_apply_image_cancel_leaves_no_output(cap, tmp_path):
    src = tmp_path / "a.png"
    Image.fromarray(noise()).save(src)
    out = tmp_path / "a (redacted).png"
    cap.ctx.request_cancel()
    with pytest.raises(Cancelled):
        run_apply(cap, src, out, [])
    assert not out.exists() and not Path(str(out) + ".part").exists()


def test_detect_validation(cap, tmp_path):
    src = tmp_path / "a.png"
    Image.fromarray(noise()).save(src)
    with pytest.raises(HandlerError) as e:
        h.detect_image(cap.ctx, {"path": str(src), "faces": False, "plates": False})
    assert e.value.code == "validation"
    with pytest.raises(HandlerError):
        h.detect_image(cap.ctx, {"path": str(src), "faces": True, "plates": False, "sensitivity": "extreme",
                                 "faceModel": str(src)})
    with pytest.raises(HandlerError) as e:  # the engine never downloads: a missing model is an error
        h.detect_image(cap.ctx, {"path": str(src), "faces": True, "plates": False, "faceModel": str(tmp_path / "no.onnx")})
    assert e.value.code == "validation"


# -- prefetch ----------------------------------------------------------------------------


def test_prefetch_validates_and_downloads_via_ensure_model(cap, tmp_path, monkeypatch):
    with pytest.raises(HandlerError):
        h.prefetch(cap.ctx, {"modelDir": str(tmp_path), "model": {"file": "../x", "url": "u", "sha256": "0" * 64}})
    with pytest.raises(HandlerError):
        h.prefetch(cap.ctx, {"model": FACE})
    calls = []

    def fake(ctx, model_dir, file, sha, url):
        calls.append((model_dir, file, sha, url))
        return os.path.join(model_dir, file)

    monkeypatch.setattr(h, "ensure_model", fake)
    res = h.prefetch(cap.ctx, {"modelDir": str(tmp_path), "model": FACE})
    assert res == {"model": FACE["file"], "path": os.path.join(str(tmp_path), FACE["file"])}
    assert calls == [(str(tmp_path), FACE["file"], FACE["sha256"], FACE["url"])]


# -- video apply (no models: a hand-written detections file) -----------------------------


def make_clip(path: Path, size="320x240", secs=3, rate=10) -> None:
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={secs}",
         "-f", "lavfi", "-i", f"sine=duration={secs}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
         "-metadata", "title=secret", str(path)],
        check=True,
    )


def read_frames(path: Path, w: int, h: int) -> list[np.ndarray]:
    r = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                       capture_output=True, check=True)
    n = w * h * 3
    return [np.frombuffer(r.stdout[i : i + n], np.uint8).reshape(h, w, 3) for i in range(0, len(r.stdout) - n + 1, n)]


def region_mean(frame, box):
    h_, w_ = frame.shape[:2]
    x, y, w, hh = box
    return frame[int(y * h_) + 2 : int((y + hh) * h_) - 2, int(x * w_) + 2 : int((x + w) * w_) - 2].mean()


@needs_ffmpeg
def test_apply_video_covers_exactly_the_track_and_manual_ranges(cap, tmp_path):
    clip = tmp_path / "clip.mp4"
    make_clip(clip)
    box = {"x": 0.25, "y": 0.3, "w": 0.25, "h": 0.25}
    hits = [{"ms": ms, **box, "score": 0.9} for ms in (0, 1000)]
    det = tmp_path / "det.json"
    det.write_text(json.dumps({"width": 320, "height": 240, "fps": 10, "tracks": [
        {"id": "t1", "kind": "plate", "hits": hits},
        {"id": "t2", "kind": "plate", "hits": [{"ms": 0, "x": 0.6, "y": 0.6, "w": 0.2, "h": 0.2, "score": 0.9},
                                              {"ms": 3000, "x": 0.6, "y": 0.6, "w": 0.2, "h": 0.2, "score": 0.9}]},
    ]}))
    manual_box = (0.05, 0.05, 0.2, 0.2)
    manual = [{"id": "m1", "x": manual_box[0], "y": manual_box[1], "w": manual_box[2], "h": manual_box[3],
               "kind": "manual", "enabled": True, "score": 1, "startMs": 2000, "endMs": 2500}]
    out = tmp_path / "clip (redacted).mp4"
    res = h.apply_video(cap.ctx, {
        "path": str(clip), "ffmpeg": FFMPEG, "out": str(out), "detectionsPath": str(det), "disabledTracks": ["t2"],
        "manualBoxes": manual, "style": "solid", "strength": 6, "padding": 0, "stripMetadata": True,
    })
    assert res["frames"] == 30 and out.exists() and not Path(str(out) + ".part").exists()
    orig, red = read_frames(clip, 320, 240), read_frames(out, 320, 240)
    assert len(red) == 30
    tbox = (box["x"], box["y"], box["w"], box["h"])
    for i in (0, 5, 10):  # 0..1000 ms: covered (the frame at exactly 1000 ms is the last)
        assert region_mean(red[i], tbox) < 20, i
    for i in (12, 15, 25):  # after the track: untouched
        assert region_mean(red[i], tbox) > 40, i
    for i in (20, 22, 24):  # manual: 2000 <= t < 2500
        assert region_mean(red[i], manual_box) < 20, i
    for i in (19, 25, 28):
        assert region_mean(red[i], manual_box) > 40, i
    assert region_mean(red[5], (0.6, 0.6, 0.2, 0.2)) > 40  # the disabled track is not drawn
    probe = subprocess.run([FFMPEG, "-hide_banner", "-i", str(out)], capture_output=True, text=True).stderr
    assert "Audio:" in probe and "secret" not in probe
    assert len(orig) == 30


@needs_ffmpeg
def test_apply_video_cancel_deletes_the_partial_output(cap, tmp_path):
    clip = tmp_path / "clip.mp4"
    make_clip(clip, secs=1)
    det = tmp_path / "det.json"
    det.write_text(json.dumps({"width": 320, "height": 240, "fps": 10, "tracks": []}))
    out = tmp_path / "o.mp4"
    cap.ctx.request_cancel()
    with pytest.raises(Cancelled):
        h.apply_video(cap.ctx, {"path": str(clip), "ffmpeg": FFMPEG, "out": str(out), "detectionsPath": str(det),
                                "style": "blur", "strength": 6, "padding": 15, "stripMetadata": True})
    assert not out.exists() and not Path(str(out) + ".part").exists()


@needs_ffmpeg
def test_apply_video_missing_detections_is_a_validation_error(cap, tmp_path):
    clip = tmp_path / "clip.mp4"
    make_clip(clip, secs=1)
    det = tmp_path / "det.json"
    det.write_text("not json")
    with pytest.raises(HandlerError) as e:
        h.apply_video(cap.ctx, {"path": str(clip), "ffmpeg": FFMPEG, "out": str(tmp_path / "o.mp4"),
                                "detectionsPath": str(det), "style": "blur"})
    assert e.value.code == "validation"


# -- slow: the real models ---------------------------------------------------------------


@pytest.fixture(scope="session")
def models(tmp_path_factory):
    from toolbox_sidecar.registry import Context
    from toolbox_sidecar.protocol import Writer
    import io

    d = os.environ.get("TOOLBOX_REDACT_MODELS") or str(tmp_path_factory.mktemp("redact-models"))
    ctx = Context("m", Writer(io.StringIO()))
    return (ensure_model(ctx, d, FACE["file"], FACE["sha256"], FACE["url"]),
            ensure_model(ctx, d, PLATE["file"], PLATE["sha256"], PLATE["url"]))


def sample(name):
    p = SAMPLES / name
    if not p.is_file():
        pytest.skip(f"{name} not in .dev/p6-research/samples")
    return p


def run_detect_image(cap, path, models, **kw):
    params = {"path": str(path), "faces": True, "plates": True, "sensitivity": "normal",
              "faceModel": models[0], "plateModel": models[1], **kw}
    return h.detect_image(cap.ctx, params)


@pytest.mark.slow
def test_real_crew_portrait_finds_all_seven_faces(cap, models):
    res = run_detect_image(cap, sample("STS-125_crew_portrait.jpg"), models, plates=False)
    faces = res["boxes"]
    # The seven crew faces (x centres in px of the 3000-wide frame, from the reference run).
    want = [(260 + 66) / 3000, (666 + 66) / 3000, (1093 + 60) / 3000, (1395 + 69) / 3000, (1824 + 56) / 3000,
            (2237 + 65) / 3000, (2581 + 62) / 3000]
    centres = [b["x"] + b["w"] / 2 for b in faces if b["y"] > 0.2]
    for c in want:
        assert any(abs(c - x) < 0.03 for x in centres), (c, centres)
    assert len(faces) <= 8  # a galaxy blob can score 0.63 at the big scale; the review step drops it
    assert (res["width"], res["height"]) == (3000, 2400)


@pytest.mark.slow
def test_real_car_park_finds_all_three_plates(cap, models):
    res = run_detect_image(cap, sample("car_park_sainsburys_geograph_3646022.jpg"), models, faces=False)
    assert [b["kind"] for b in res["boxes"]] == ["plate"] * 3
    assert all(0 < b["x"] < 1 and 0 < b["w"] < 0.5 for b in res["boxes"])


@pytest.mark.slow
def test_real_detect_then_apply_hides_the_faces(cap, models, tmp_path):
    src = sample("STS-125_crew_portrait.jpg")
    res = run_detect_image(cap, src, models, plates=False)
    out = tmp_path / "crew (redacted).png"
    h.apply_image(cap.ctx, {"path": str(src), "out": str(out), "boxes": res["boxes"], "style": "blur",
                            "strength": 6, "padding": 15, "stripMetadata": True})
    a, b = np.asarray(Image.open(src).convert("RGB")), np.asarray(Image.open(out).convert("RGB"))
    for box in res["boxes"]:
        x0, y0, x1, y1, _ = render.region_for(box, "face", 0, a.shape[1], a.shape[0])
        assert np.abs(a[y0:y1, x0:x1].astype(int) - b[y0:y1, x0:x1]).mean() > 8


@pytest.mark.slow
@needs_ffmpeg
def test_real_video_face_moving_across_testsrc2_is_covered(cap, models, tmp_path):
    src = sample("STS-125_crew_portrait.jpg")
    crop = tmp_path / "face.png"
    # A 300x300 crop around the 3rd crew member's face, with the face box at a known place inside it.
    fx, fy, fs = 1093, 844, 119
    left, top = fx - 90, fy - 100
    Image.open(src).convert("RGB").crop((left, top, left + 300, top + 300)).save(crop)
    clip = tmp_path / "moving.mp4"
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=15:duration=10",
         "-i", str(crop), "-filter_complex", "[0][1]overlay=x=t*120:y=200", "-c:v", "libx264", "-pix_fmt", "yuv420p",
         str(clip)],
        check=True,
    )
    cache = tmp_path / "cache" / "j1.json"
    res = h.detect_video(cap.ctx, {"path": str(clip), "ffmpeg": FFMPEG, "faces": True, "plates": False,
                                   "sensitivity": "normal", "faceModel": models[0], "plateModel": models[1],
                                   "cachePath": str(cache)})
    assert cache.is_file() and (res["width"], res["height"]) == (1280, 720)
    tracks = [t for t in res["tracks"] if t["kind"] == "face"]
    assert tracks and tracks[0]["enabled"]
    disabled = [t["id"] for t in tracks if not t["enabled"]]
    out = tmp_path / "moving (redacted).mp4"
    h.apply_video(cap.ctx, {"path": str(clip), "ffmpeg": FFMPEG, "out": str(out), "detectionsPath": str(cache),
                            "disabledTracks": disabled, "style": "solid", "strength": 6, "padding": 15,
                            "stripMetadata": True})
    orig, red = read_frames(clip, 1280, 720), read_frames(out, 1280, 720)
    checked = 0
    for i in range(0, len(red), 10):
        x = int(i / 15 * 120)
        gx0, gy0 = x + 90, 200 + 100  # the face box in frame pixels
        if gx0 + fs > 1280:
            continue
        before, after = orig[i][gy0 : gy0 + fs, gx0 : gx0 + fs], red[i][gy0 : gy0 + fs, gx0 : gx0 + fs]
        inner = (slice(fs // 4, 3 * fs // 4), slice(fs // 4, 3 * fs // 4))
        assert after[inner].mean() < 30 < before[inner].mean(), i
        checked += 1
    assert checked >= 6
