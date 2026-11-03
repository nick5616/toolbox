"""Edit Studio mattes: frame I/O, the SAM chunk planner and sampling, validation, a fake-predictor run.

Fast tests need only FFmpeg. The slow tests (TOOLBOX_SLOW=1) run the real models, found in
$TOOLBOX_MATTE_MODELS (a folder with rvm_mobilenetv3_fp32.onnx and sam2.1_hiera_tiny.pt), else in
<repo>/.dev/p9-research/models.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from toolbox_sidecar.handlers import matte as h
from toolbox_sidecar.matte import frames, sam
from toolbox_sidecar.matte.frames import Encoder, FrameReader, StreamIndex
from toolbox_sidecar.registry import HANDLERS, Cancelled, HandlerError

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


# -- helpers -----------------------------------------------------------------------------


def build_index(data: bytes, width: int, height: int, fps: int) -> dict[str, Any]:
    """Python twin of Go's BuildIndex: one access unit per AUD (NAL 9); IDR (NAL 5) frames are keys."""
    starts: list[int] = []
    keys: list[int] = []
    for m in re.finditer(b"\x00\x00\x01", data):
        p = m.start()
        nal = data[p + 3] & 0x1F
        begin = p - 1 if p > 0 and data[p - 1] == 0 else p
        if nal == 9:
            starts.append(begin)
        elif nal == 5 and (not keys or keys[-1] != len(starts) - 1):
            keys.append(len(starts) - 1)
    offsets = starts + [len(data)]
    return {"version": 1, "codec": "avc1.64001f", "width": width, "height": height, "fps": fps,
            "frames": len(starts), "offsets": offsets, "keys": keys, "bytes": len(data)}


def make_stream(tmp: Path, name: str, grays: list[np.ndarray], fps: int = 30) -> tuple[str, str]:
    """Encodes grey frames with the matte encoder and writes the stream's index."""
    h_, w_ = grays[0].shape
    out = str(tmp / f"{name}.h264")
    enc = Encoder(FFMPEG, w_, h_, fps, out)
    for g in grays:
        enc.write(g)
    enc.finish()
    enc.close()
    data = Path(out).read_bytes()
    idx = str(tmp / f"{name}.idx.json")
    Path(idx).write_text(json.dumps(build_index(data, w_, h_, fps)))
    return out, idx


def decode_gray(path: str, index: str, lo: int, hi: int, w: int, h_: int, fps: int = 30) -> list[np.ndarray]:
    idx = StreamIndex.load(index)
    with FrameReader(FFMPEG, path, idx, lo, hi, fps, w, h_) as r:
        return [f[..., 0].copy() for f in r]


def square(w: int, h_: int, x: int, y: int, s: int) -> np.ndarray:
    a = np.zeros((h_, w), np.uint8)
    a[y : y + s, x : x + s] = 255
    return a


def iou(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a > 127, b > 127
    u = (a | b).sum()
    return 1.0 if u == 0 else float((a & b).sum() / u)


# -- registration and validation ----------------------------------------------------------


def test_registered():
    for name in ("people", "select", "select_preview", "prefetch"):
        assert f"matte.{name}" in HANDLERS


def _params(tmp_path: Path, **over: Any) -> dict[str, Any]:
    (tmp_path / "s.h264").write_bytes(b"x")
    (tmp_path / "s.idx.json").write_text(json.dumps({"frames": 2, "offsets": [0, 1, 2], "keys": [0]}))
    (tmp_path / "m.onnx").write_bytes(b"x")
    p: dict[str, Any] = {
        "ffmpeg": "ffmpeg", "stream": str(tmp_path / "s.h264"), "index": str(tmp_path / "s.idx.json"),
        "fromFrame": 0, "toFrame": 2, "fps": 30, "width": 64, "height": 48, "outPath": str(tmp_path / "o.h264"),
        "model": {"file": "m.onnx", "sha256": "0" * 64}, "modelDir": str(tmp_path),
    }
    p.update(over)
    return p


@pytest.mark.parametrize(
    "over",
    [
        {"ffmpeg": ""},
        {"stream": "missing.h264"},
        {"index": "missing.json"},
        {"fromFrame": -1},
        {"fromFrame": 2, "toFrame": 2},
        {"toFrame": 99},  # past the stream
        {"fps": 0},
        {"fps": 500},
        {"width": 63},
        {"height": 0},
        {"outPath": ""},
        {"model": {"file": "../m.onnx", "sha256": "0" * 64}},
        {"model": {"file": "absent.onnx", "sha256": "0" * 64}},
        {"model": None},
    ],
)
def test_people_validation(tmp_path, cap, over):
    with pytest.raises(HandlerError) as e:
        h.people(cap.ctx, _params(tmp_path, **over))
    assert e.value.code == "validation"


def test_missing_model_has_a_hint(tmp_path, cap):
    with pytest.raises(HandlerError) as e:
        h.people(cap.ctx, _params(tmp_path, model={"file": "absent.onnx", "sha256": "0" * 64}))
    assert "Music edits" in e.value.hint


@pytest.mark.parametrize(
    "clicks",
    [None, [], "x", [{"frame": 0, "x": 1, "y": 1}], [{"frame": 0, "x": 1, "y": 1, "positive": False}],
     [{"frame": 5, "x": 1, "y": 1, "positive": True}], [{"frame": 0, "x": 99, "y": 1, "positive": True}]],
)
def test_select_validation(tmp_path, cap, clicks):
    pytest.importorskip("sam2")
    with pytest.raises(HandlerError) as e:
        h.select(cap.ctx, _params(tmp_path, clicks=clicks))
    assert e.value.code == "validation"


def test_select_rejects_long_ranges(tmp_path, cap):
    pytest.importorskip("sam2")
    idx = {"frames": 2000, "offsets": list(range(2001)), "keys": [0]}
    (tmp_path / "s.idx.json").write_text(json.dumps(idx))
    p = _params(tmp_path, toFrame=1900, clicks=[{"frame": 0, "x": 1, "y": 1, "positive": True}])
    (tmp_path / "s.idx.json").write_text(json.dumps(idx))
    with pytest.raises(HandlerError) as e:
        h.select(cap.ctx, p)
    assert "60 seconds" in e.value.message


def test_prefetch_validation(cap):
    with pytest.raises(HandlerError) as e:
        h.prefetch(cap.ctx, {"modelDir": "x", "model": {"file": "a"}})
    assert e.value.code == "validation"


# -- pure planning -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "n,fps,want",
    [(1, 30, [0]), (5, 15, [0, 1, 2, 3, 4]), (7, 30, [0, 2, 4, 6]), (6, 30, [0, 2, 4, 5]), (9, 24, [0, 2, 4, 6, 8]),
     (10, 60, [0, 4, 8, 9])],
)
def test_sample_frames(n, fps, want):
    assert sam.sample_frames(n, fps) == want


def test_sample_rate_never_exceeds_cap():
    for fps in (15, 24, 25, 29.97, 30, 50, 60, 120):
        s = sam.sample_frames(3000, fps)
        assert len(s[:-1]) / (3000 / fps) <= sam.MAX_SAM_FPS + 0.1


def test_nearest_pos():
    s = [0, 2, 4, 6, 7]
    assert [sam.nearest_pos(s, f) for f in range(8)] == [0, 0, 1, 1, 2, 2, 3, 4]
    assert sam.nearest_pos(s, -3) == 0 and sam.nearest_pos(s, 99) == 4


def test_blend_pos():
    s = [0, 2, 4, 5]
    assert sam.blend_pos(0, s) == (0, 0.0)
    assert sam.blend_pos(1, s) == (0, 0.5)
    assert sam.blend_pos(2, s) == (1, 0.0)
    assert sam.blend_pos(4, s) == (2, 0.0)
    p, t = sam.blend_pos(5, s)
    assert (p, t) == (2, 1.0)
    assert sam.blend_pos(3, [3]) == (0, 0.0)


@pytest.mark.parametrize("m,anchor,size", [(1, 0, 4), (10, 0, 4), (10, 9, 4), (10, 4, 4), (200, 100, 96), (96, 0, 96), (97, 50, 96), (300, 299, 96)])
def test_plan_passes(m, anchor, size):
    ps = sam.plan_passes(m, anchor, size)
    covered: set[int] = set()
    for p in ps:
        assert 0 <= p.lo <= p.start <= p.hi < m and p.hi - p.lo + 1 <= size
        assert p.start == (p.lo if p.direction == "fwd" else p.hi)
        covered |= set(range(p.lo, p.hi + 1))
    assert covered == set(range(m))
    fwd = [p for p in ps if p.direction == "fwd"]
    bwd = [p for p in ps if p.direction == "bwd"]
    assert ps[: len(fwd)] == fwd  # forward first, then backward
    assert fwd[0].start == anchor and fwd[0].seed == "clicks" and fwd[-1].hi == m - 1
    assert all(p.seed == "mask" for p in fwd[1:] + bwd[1:])
    for a, b in zip(fwd, fwd[1:]):
        assert b.start == a.hi
    for a, b in zip(bwd, bwd[1:]):
        assert b.start == a.lo
    if anchor > 0:
        assert bwd[0].start == anchor and bwd[0].seed == "clicks" and bwd[-1].lo == 0
    else:
        assert not bwd


def test_plan_rejects_bad_input():
    for args in [(0, 0, 4), (5, 5, 4), (5, 0, 1)]:
        with pytest.raises(ValueError):
            sam.plan_passes(*args)


def test_sam_size():
    assert sam.sam_size(1920, 1080) == (1024, 576)
    assert sam.sam_size(1080, 1920) == (576, 1024)
    assert sam.sam_size(640, 480) == (640, 480)


def test_logits_to_alpha_blends_before_threshold():
    lg = np.array([[-4.0, 4.0]], np.float32)
    a = sam.logits_to_alpha(lg, 4, 1)
    assert list(a[0]) == [0, 0, 255, 255]


# -- frame I/O (FFmpeg) --------------------------------------------------------------------


@needs_ffmpeg
def test_encoder_round_trip_and_stream_format(tmp_path):
    w, h_ = 64, 48
    grays = [np.full((h_, w), v, np.uint8) for v in (0, 40, 128, 200, 255)]
    grays[2][:, : w // 2] = 10
    out, idx = make_stream(tmp_path, "rt", grays)
    data = Path(out).read_bytes()
    assert data[:4] == b"\x00\x00\x00\x01"
    info = json.loads(Path(idx).read_text())
    assert info["frames"] == 5 and info["keys"] == [0]
    got = decode_gray(out, idx, 0, 5, w, h_)
    for g, want in zip(got, grays):
        assert np.abs(g.astype(int) - want.astype(int)).max() <= 2
    assert not Path(out + ".part").exists()


@needs_ffmpeg
def test_reader_starts_at_the_keyframe_before_from_frame(tmp_path):
    w, h_ = 32, 32
    grays = [np.full((h_, w), 10 * i, np.uint8) for i in range(26)]
    out, idx = make_stream(tmp_path, "keys", grays)
    info = json.loads(Path(idx).read_text())
    assert info["keys"] == [0, 10, 20]  # -g 10
    for lo, hi in [(13, 24), (10, 11), (20, 26), (0, 3), (19, 20)]:
        r = StreamIndex.load(idx)
        assert r.key_at_or_before(lo) == (lo // 10) * 10
        got = decode_gray(out, idx, lo, hi, w, h_)
        assert len(got) == hi - lo
        for k, g in enumerate(got):
            assert abs(int(g.mean()) - 10 * (lo + k)) <= 3, (lo, k)


@needs_ffmpeg
def test_reader_rescales_and_rejects_bad_ranges(tmp_path):
    grays = [np.full((32, 32), 100, np.uint8)] * 12
    out, idx = make_stream(tmp_path, "scale", grays)
    got = decode_gray(out, idx, 2, 5, 16, 16)
    assert got[0].shape == (16, 16)
    with pytest.raises(HandlerError):
        FrameReader(FFMPEG, out, StreamIndex.load(idx), 5, 99, 30, 32, 32)


def test_index_validation(tmp_path):
    p = tmp_path / "i.json"
    p.write_text("not json")
    with pytest.raises(HandlerError):
        StreamIndex.load(str(p))
    p.write_text(json.dumps({"frames": 3, "offsets": [0, 1], "keys": [0]}))
    with pytest.raises(HandlerError):
        StreamIndex.load(str(p))


@needs_ffmpeg
def test_encoder_abort_removes_part(tmp_path):
    out = str(tmp_path / "x.h264.part")
    enc = Encoder(FFMPEG, 16, 16, 30, out)
    enc.write(np.zeros((16, 16), np.uint8))
    enc.abort()
    assert not os.path.exists(out)
    with pytest.raises(ValueError):
        Encoder(FFMPEG, 16, 16, 30, out).write(np.zeros((8, 8), np.uint8))


# -- the select pipeline with a fake predictor -----------------------------------------------


class FakePredictor:
    """Stands in for SAM: "segments" the bright square of each chunk frame, and records the calls."""

    def __init__(self, fail_first_on: str | None = None) -> None:
        self.calls: list[tuple] = []
        self.dir = ""
        self.fail = fail_first_on

    def init_state(self, d, offload_video_to_cpu=False, offload_state_to_cpu=False):
        assert offload_video_to_cpu and offload_state_to_cpu
        self.dir = d
        names = sorted(os.listdir(d))
        assert names == [f"{i:05d}.jpg" for i in range(len(names))]
        self.calls.append(("init", len(names)))
        return {"n": len(names)}

    def _logits(self, i: int):
        import torch
        from PIL import Image

        im = np.asarray(Image.open(os.path.join(self.dir, f"{i:05d}.jpg")).convert("L"))
        return torch.from_numpy(np.where(im > 128, 10.0, -10.0).astype(np.float32))[None, None]

    def add_new_points_or_box(self, state, frame_idx, obj_id, points, labels, **kw):
        self.calls.append(("points", frame_idx, len(points)))
        return frame_idx, [obj_id], self._logits(frame_idx)

    def add_new_mask(self, state, frame_idx, obj_id, mask):
        assert mask.dtype.is_floating_point is False and mask.dim() == 2
        self.calls.append(("mask", frame_idx))

    def propagate_in_video(self, state, start_frame_idx=None, reverse=False):
        self.calls.append(("prop", start_frame_idx, reverse))
        rng = range(start_frame_idx, -1, -1) if reverse else range(start_frame_idx, state["n"])
        for i in rng:
            yield i, [1], self._logits(i)


def moving_squares(n: int, w: int = 64, h_: int = 48, s: int = 10) -> list[np.ndarray]:
    return [square(w, h_, 2 + (i * (w - s - 4)) // max(n - 1, 1), 15 + (i % 3), s) for i in range(n)]


@needs_ffmpeg
def test_select_with_fake_predictor_tracks_and_blends(tmp_path, cap):
    pytest.importorskip("PIL")
    n, w, h_ = 41, 64, 48
    truth = moving_squares(n, w, h_)
    stream, idx = make_stream(tmp_path, "src", truth)
    pred = FakePredictor()
    out = str(tmp_path / "matte.h264")
    clicks = [sam.Click(frame=20, x=30.0, y=20.0, positive=True), sam.Click(frame=30, x=44.0, y=20.0, positive=False)]
    res = sam.run_select(
        cap.ctx, ffmpeg=FFMPEG, stream=stream, index=StreamIndex.load(idx), from_frame=0, to_frame=n, fps=30,
        width=w, height=h_, out_path=out, model_path="unused", clicks=clicks, work_dir=str(tmp_path / "work"),
        factory=lambda device: pred, chunk=6,
    )
    assert res["frames"] == n and res["sampled"] == 21  # every 2nd frame (15 fps of 30) plus the last
    assert not os.path.exists(out + ".part")
    # forward chunks come first, each later one seeded by a mask; the anchor is seeded by points
    kinds = [c[0] for c in pred.calls]
    assert kinds[:3] == ["init", "points", "points"] or kinds[:2] == ["init", "points"]
    props = [c for c in pred.calls if c[0] == "prop"]
    assert props[0][2] is False and props[-1][2] is True
    assert any(c[0] == "mask" for c in pred.calls)
    seen_rev = False
    for c in props:
        if c[2]:
            seen_rev = True
        else:
            assert not seen_rev  # no forward pass after a backward one
    # no chunk dirs or frames left behind
    assert not (tmp_path / "work" / "frames").exists()
    got = decode_gray(out, _index_of(out, w, h_), 0, n, w, h_)
    assert len(got) == n
    # a blended frame of saturated logits is the overlap of its two neighbours, so IoU dips between samples
    scores = [iou(g, t) for g, t in zip(got, truth)]
    assert min(scores) > 0.45
    assert min(scores[::2]) > 0.9  # the sampled frames are exact
    assert np.mean(scores) > 0.7
    prog = [e["pct"] for e in cap.events("progress") if e["pct"] >= 0]
    assert prog and max(prog) <= 1.0


def _index_of(stream: str, w: int, h_: int) -> str:
    p = stream.replace(".h264", ".idx.json")
    Path(p).write_text(json.dumps(build_index(Path(stream).read_bytes(), w, h_, 30)))
    return p


@needs_ffmpeg
def test_select_from_a_frame_offset_and_cancel(tmp_path, cap):
    n, w, h_ = 30, 64, 48
    truth = moving_squares(n, w, h_)
    stream, idx = make_stream(tmp_path, "src", truth)
    out = str(tmp_path / "o.h264")
    res = sam.run_select(
        cap.ctx, ffmpeg=FFMPEG, stream=stream, index=StreamIndex.load(idx), from_frame=7, to_frame=19, fps=30,
        width=w, height=h_, out_path=out, model_path="unused", clicks=[sam.Click(0, 20.0, 20.0, True)],
        work_dir=str(tmp_path / "w"), factory=lambda d: FakePredictor(), chunk=4,
    )
    assert res["frames"] == 12
    got = decode_gray(out, _index_of(out, w, h_), 0, 12, w, h_)
    scores = [iou(g, t) for g, t in zip(got, truth[7:19])]
    assert min(scores[::2]) > 0.9 and np.mean(scores) > 0.7

    cap.ctx.request_cancel()
    with pytest.raises(Cancelled):
        sam.run_select(
            cap.ctx, ffmpeg=FFMPEG, stream=stream, index=StreamIndex.load(idx), from_frame=0, to_frame=10, fps=30,
            width=w, height=h_, out_path=str(tmp_path / "c.h264"), model_path="unused",
            clicks=[sam.Click(0, 20.0, 20.0, True)], work_dir=str(tmp_path / "w2"), factory=lambda d: FakePredictor(),
        )
    assert not os.path.exists(str(tmp_path / "c.h264"))
    assert not os.path.exists(str(tmp_path / "c.h264.part"))


@needs_ffmpeg
def test_mps_failure_retries_the_chunk_on_cpu_and_logs_once(tmp_path, cap):
    n, w, h_ = 24, 64, 48
    stream, idx = make_stream(tmp_path, "src", moving_squares(n, w, h_))
    pred = FakePredictor()
    seen: list[str] = []

    def factory(device: str):
        seen.append(device)
        if device == "mps":
            raise RuntimeError("The operator 'aten::foo' is not currently implemented for the MPS device")
        return pred

    sam.run_select(
        cap.ctx, ffmpeg=FFMPEG, stream=stream, index=StreamIndex.load(idx), from_frame=0, to_frame=n, fps=30,
        width=w, height=h_, out_path=str(tmp_path / "o.h264"), model_path="unused",
        clicks=[sam.Click(10, 30.0, 20.0, True)], work_dir=str(tmp_path / "w"), factory=factory, chunk=5, device="mps",
    )
    assert seen[0] == "mps" and set(seen[1:]) == {"cpu"}
    warns = [e for e in cap.events("log") if "CPU" in e["line"]]
    assert len(warns) == 1


@needs_ffmpeg
def test_preview_writes_a_png_mask(tmp_path, cap):
    from PIL import Image

    w, h_ = 64, 48
    stream, idx = make_stream(tmp_path, "src", moving_squares(10, w, h_))
    out = str(tmp_path / "try.png")
    res = sam.run_preview(
        cap.ctx, ffmpeg=FFMPEG, stream=stream, index=StreamIndex.load(idx), frame=4, fps=30, width=w, height=h_,
        out_path=out, model_path="unused", clicks=[sam.Click(0, 30.0, 20.0, True)], work_dir=str(tmp_path / "w"),
        factory=lambda d: FakePredictor(),
    )
    im = Image.open(out)
    assert im.mode == "L" and im.size == (w, h_)
    assert iou(np.asarray(im), moving_squares(10, w, h_)[4]) > 0.8
    assert 0 < res["coverage"] < 0.2


# -- slow: the real models ------------------------------------------------------------------


def _models() -> Path:
    env = os.environ.get("TOOLBOX_MATTE_MODELS")
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        cand = parent / ".dev" / "p9-research" / "models"
        if cand.is_dir():
            return cand
    return Path("models-not-found")


def _real_params(tmp: Path, stream: str, idx: str, w: int, h_: int, n: int, model: str, out: str, **over: Any) -> dict[str, Any]:
    p = {
        "ffmpeg": FFMPEG, "stream": stream, "index": idx, "fromFrame": 0, "toFrame": n, "fps": 30, "width": w, "height": h_,
        "outPath": out, "model": {"file": model, "sha256": "0" * 64}, "modelDir": str(_models()), "workDir": str(tmp / "work"),
    }
    p.update(over)
    return p


def _need(model: str) -> None:
    if not (_models() / model).is_file():
        pytest.skip(f"{model} not found (set TOOLBOX_MATTE_MODELS)")


@pytest.mark.slow
@needs_ffmpeg
def test_people_matte_is_stable(tmp_path, cap):
    """RVM on a moving figure: right frame count, valid alpha, no flicker between neighbouring frames."""
    _need("rvm_mobilenetv3_fp32.onnx")
    w, h_, n = 320, 192, 40
    frames_ = []
    for i in range(n):  # a dark "person" (head + body) walking across a light, textured background
        img = np.full((h_, w, 3), 190, np.uint8)
        img[::8] = 170
        x = 40 + i * 5
        yy, xx = np.mgrid[0:h_, 0:w]
        body = (((xx - x) / 28.0) ** 2 + ((yy - 120) / 60.0) ** 2) < 1
        head = (((xx - x) / 16.0) ** 2 + ((yy - 52) / 18.0) ** 2) < 1
        img[body | head] = (60, 50, 45)
        frames_.append(img)
    src = tmp_path / "src.h264"
    import subprocess

    raw = b"".join(f.tobytes() for f in frames_)
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h_}", "-r", "30", "-i", "-",
         "-c:v", "libx264", "-g", "10", "-bf", "0", "-pix_fmt", "yuv420p", "-x264-params", "aud=1:repeat-headers=1",
         "-f", "h264", str(src)], input=raw, check=True)
    idx = tmp_path / "src.idx.json"
    idx.write_text(json.dumps(build_index(src.read_bytes(), w, h_, 30)))
    out = str(tmp_path / "people.h264")
    t0 = time.time()
    res = h.people(cap.ctx, _real_params(tmp_path, str(src), str(idx), w, h_, n, "rvm_mobilenetv3_fp32.onnx", out, fromFrame=5, toFrame=n))
    dt = time.time() - t0
    print(f"people: {n - 5} frames at {w}x{h_} in {dt:.1f}s")
    assert res["frames"] == n - 5
    got = decode_gray(out, _index_of(out, w, h_), 0, n - 5, w, h_)
    assert len(got) == n - 5
    flicker = [float(np.abs(a.astype(int) - b.astype(int)).mean()) for a, b in zip(got, got[1:])]
    assert max(flicker) < 12.0  # mean change per pixel between neighbours stays small
    cover = [float((g > 127).mean()) for g in got[3:]]
    assert max(cover) - min(cover) < 0.15


@pytest.mark.slow
@needs_ffmpeg
def test_select_tracks_a_moving_square(tmp_path, cap):
    """Real SAM 2.1 over 120 frames (sampled at 15 fps): IoU > 0.8 on average and at every sampled frame."""
    pytest.importorskip("sam2")
    _need("sam2.1_hiera_tiny.pt")
    w, h_, n = 192, 128, 120
    truth = []
    for i in range(n):
        img = np.full((h_, w), 40, np.uint8)
        img[::6] = 55
        x = 8 + (i * (w - 56)) // (n - 1)
        img[40:80, x : x + 40] = 235
        truth.append(np.where(img == 235, 255, 0).astype(np.uint8))
    # SAM needs RGB-ish content: make the stream from the same grey frames.
    stream, idx = make_stream(tmp_path, "sq", [np.where(t > 0, 235, 40).astype(np.uint8) for t in truth])
    out = str(tmp_path / "sel.h264")
    clicks = [{"frame": 60, "x": 8 + (60 * (w - 56)) // (n - 1) + 20, "y": 60.0, "positive": True}]
    t0 = time.time()
    res = h.select(cap.ctx, _real_params(tmp_path, stream, idx, w, h_, n, "sam2.1_hiera_tiny.pt", out, clicks=clicks))
    dt = time.time() - t0
    print(f"select: {res['sampled']} sampled of {n} frames on {res['device']} in {dt:.1f}s ({dt / res['sampled']:.2f}s/sampled)")
    got = decode_gray(out, _index_of(out, w, h_), 0, n, w, h_)
    scores = [iou(g, t) for g, t in zip(got, truth)]
    print("select IoU min/mean", min(scores), float(np.mean(scores)))
    assert len(got) == n
    assert float(np.mean(scores)) > 0.8
    assert float(np.percentile(scores, 10)) > 0.7


@pytest.mark.slow
@needs_ffmpeg
def test_select_preview_mask(tmp_path, cap):
    from PIL import Image

    pytest.importorskip("sam2")
    _need("sam2.1_hiera_tiny.pt")
    w, h_ = 192, 128
    frame = square(w, h_, 60, 40, 40)
    stream, idx = make_stream(tmp_path, "pv", [np.where(frame > 0, 235, 40).astype(np.uint8)] * 12)
    out = str(tmp_path / "try.png")
    t0 = time.time()
    h.select_preview(cap.ctx, _real_params(tmp_path, stream, idx, w, h_, 0, "sam2.1_hiera_tiny.pt", out, fromFrame=3,
                                           toFrame=4, clicks=[{"frame": 3, "x": 80.0, "y": 60.0, "positive": True},
                                                              {"frame": 9, "x": 5.0, "y": 5.0, "positive": True}]))
    print(f"preview in {time.time() - t0:.1f}s")
    assert iou(np.asarray(Image.open(out)), frame) > 0.8
