"""Video detection and redaction through FFmpeg raw-frame pipes (SPEC.md §8.2).

FFmpeg decodes (autorotated) to bgr24 on a pipe; frames are processed here and,
for ``apply``, written to a second FFmpeg that encodes H.264 and copies the audio.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from collections.abc import Iterator
from fractions import Fraction
from typing import Any

import numpy as np

from ..registry import Context, HandlerError
from . import DETECT_LONG_SIDE, MAX_DETECT_FPS, THRESHOLDS, detect, render, track

MP4_AUDIO = {"aac", "mp3", "mp2", "ac3", "eac3", "alac", "opus"}
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


class Probe:
    """What the pipes need: the upright frame size, frame rate, duration, audio codec."""

    def __init__(self, width: int, height: int, fps: Fraction, duration_ms: int, audio_codec: str | None) -> None:
        self.width, self.height, self.fps = width, height, fps
        self.duration_ms, self.audio_codec = duration_ms, audio_codec

    @property
    def est_frames(self) -> int:
        return max(1, round(self.duration_ms / 1000 * float(self.fps)))


def _popen(cmd: list[str], **kw: Any) -> subprocess.Popen[bytes]:
    return subprocess.Popen(cmd, creationflags=_NO_WINDOW, stdin=kw.pop("stdin", subprocess.DEVNULL), **kw)


def _kill(*procs: subprocess.Popen[bytes] | None) -> None:
    for p in procs:
        if p is not None and p.poll() is None:
            try:
                p.kill()
            except OSError:
                pass
    for p in procs:
        if p is not None:
            try:
                p.wait(timeout=10)
            except Exception:
                pass


def probe(ffmpeg: str, path: str) -> Probe:
    """Reads fps/duration with PyAV and the upright size from FFmpeg's own first frame."""
    import av
    from PIL import Image

    try:
        with av.open(path) as c:
            v = next((s for s in c.streams if s.type == "video"), None)
            if v is None:
                raise HandlerError("validation", "This file has no video")
            rate = v.average_rate or v.guessed_rate or Fraction(30)
            fps = Fraction(rate.numerator, rate.denominator)
            if c.duration:
                dur = int(c.duration / 1000)
            elif v.duration and v.time_base:
                dur = int(float(v.duration * v.time_base) * 1000)
            else:
                dur = 0
            a = next((s for s in c.streams if s.type == "audio"), None)
            audio = a.codec_context.name if a is not None else None
    except HandlerError:
        raise
    except Exception as e:
        raise HandlerError("validation", "Couldn't read this video", str(e)) from e
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "image2pipe", "-c:v", "bmp", "-"]
    r = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW, stdin=subprocess.DEVNULL)
    if r.returncode != 0 or not r.stdout:
        raise HandlerError("validation", "Couldn't read this video", r.stderr.decode("utf-8", "replace")[-300:])
    with Image.open(io.BytesIO(r.stdout)) as im:
        w, h = im.size
    return Probe(w, h, fps, dur, audio)


def detect_size(p: Probe) -> tuple[int, int]:
    """The decoded size for detection: long side DETECT_LONG_SIDE, never enlarged."""
    long_side = max(p.width, p.height)
    if long_side <= DETECT_LONG_SIDE:
        return p.width, p.height
    s = DETECT_LONG_SIDE / long_side
    return max(2, round(p.width * s)), max(2, round(p.height * s))


def _read_frames(proc: subprocess.Popen[bytes], w: int, h: int) -> Iterator[np.ndarray]:
    """Yields writable (h, w, 3) uint8 arrays until the pipe ends."""
    n = w * h * 3
    while True:
        buf = np.empty((h, w, 3), np.uint8)
        view = memoryview(buf).cast("B")
        got = 0
        while got < n:
            k = proc.stdout.readinto(view[got:])  # type: ignore[union-attr]
            if not k:
                break
            got += k
        if got < n:
            return
        yield buf


def _tail(f: Any) -> str:
    try:
        f.flush()
        f.seek(0)
        return f.read().decode("utf-8", "replace").strip()[-400:]
    except Exception:
        return ""


# -- detection -------------------------------------------------------------------------


def detect_video(
    ctx: Context,
    *,
    ffmpeg: str,
    path: str,
    faces: bool,
    plates: bool,
    sensitivity: str,
    face_model: str | None,
    plate_model: str | None,
    cache_path: str,
) -> dict[str, Any]:
    import tempfile

    ctx.stage("Reading video")
    p = probe(ffmpeg, path)
    ctx.check_cancelled()
    w, h = detect_size(p)
    fps = min(float(p.fps), MAX_DETECT_FPS)
    fps_arg = f"{fps:.5f}".rstrip("0").rstrip(".")
    frame_ms = 1000.0 / fps
    expected = max(1, round(p.duration_ms / 1000 * fps))
    face_thr, plate_thr = THRESHOLDS[sensitivity]
    fsess = detect.session(face_model, dynamic=True) if faces and face_model else None
    psess = detect.session(plate_model) if plates and plate_model else None

    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-an", "-sn",
           "-vf", f"fps={fps_arg},scale={w}:{h}", "-pix_fmt", "bgr24", "-f", "rawvideo", "-"]
    err = tempfile.TemporaryFile()
    proc = _popen(cmd, stdout=subprocess.PIPE, stderr=err, bufsize=0)
    frames: list[tuple[int, list[tuple[str, float, float, float, float, float]]]] = []

    def find_faces(bgr: np.ndarray) -> list[tuple[str, float, float, float, float, float]]:
        return [
            ("face", b[0] / w, b[1] / h, (b[2] - b[0]) / w, (b[3] - b[1]) / h, b[4])
            for b in detect.detect_faces(fsess, bgr, face_thr, (max(w, h),))
        ]

    def find_plates(bgr: np.ndarray) -> list[tuple[str, float, float, float, float, float]]:
        rgb = np.ascontiguousarray(bgr[..., ::-1])
        return [
            ("plate", b[0] / w, b[1] / h, (b[2] - b[0]) / w, (b[3] - b[1]) / h, b[4])
            for b in detect.detect_plates(psess, rgb, plate_thr, tile=False)
        ]

    ctx.stage("Finding faces and plates")
    try:
        for idx, bgr in enumerate(_read_frames(proc, w, h)):
            ctx.check_cancelled()
            dets = find_faces(bgr) if fsess is not None else []
            if psess is not None:
                dets += find_plates(bgr)
            frames.append((round(idx * frame_ms), dets))
            ctx.progress(min(0.99, (idx + 1) / expected), f"Frame {idx + 1} of about {expected}")
        proc.wait(timeout=30)
        if proc.returncode not in (0, None) and not frames:
            raise HandlerError("tool_failed", "FFmpeg couldn't decode this video", _tail(err))
    finally:
        _kill(proc)
        err.close()
    if not frames:
        raise HandlerError("validation", "This video has no frames")

    ctx.stage("Linking detections")
    duration_ms = p.duration_ms or round(len(frames) * frame_ms)
    tracks = track.build_tracks(frames, aspect=p.width / p.height, duration_ms=duration_ms, frame_ms=round(frame_ms))
    os.makedirs(os.path.dirname(os.path.abspath(cache_path)), exist_ok=True)
    tmp = cache_path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"width": p.width, "height": p.height, "fps": float(p.fps), "tracks": tracks}, f)
    os.replace(tmp, cache_path)
    return {
        "width": p.width,
        "height": p.height,
        "durationMs": duration_ms,
        "tracks": [track.summarize(t) for t in tracks],
    }


# -- apply -----------------------------------------------------------------------------


def _load_tracks(path: str, disabled: set[str]) -> list[dict[str, Any]]:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        tracks = data["tracks"]
    except (OSError, ValueError, KeyError) as e:
        raise HandlerError("validation", "The detections for this video are missing", "Run the detection again") from e
    return [t for t in tracks if t.get("id") not in disabled and t.get("hits")]


def boxes_at(
    tracks: list[dict[str, Any]], manual: list[dict[str, Any]], ms: float
) -> list[tuple[dict[str, float], str]]:
    """(box, kind) pairs covering time ms: interpolated track boxes plus manual boxes."""
    out: list[tuple[dict[str, float], str]] = []
    for t in tracks:
        b = track.box_at(t["hits"], ms)
        if b is not None:
            out.append(({"x": b[0], "y": b[1], "w": b[2], "h": b[3]}, t["kind"]))
    for m in manual:
        if m["startMs"] <= ms < m["endMs"]:
            out.append((m, "manual"))
    return out


def apply_video(
    ctx: Context,
    *,
    ffmpeg: str,
    path: str,
    out: str,
    detections_path: str,
    disabled: set[str],
    manual: list[dict[str, Any]],
    style: str,
    strength: int,
    padding: int,
    strip: bool,
) -> dict[str, Any]:
    import tempfile

    ctx.stage("Reading video")
    p = probe(ffmpeg, path)
    ctx.check_cancelled()
    tracks = _load_tracks(detections_path, disabled)
    manual = [m for m in manual if m.get("enabled", True)]
    w, h = p.width, p.height
    fps = f"{p.fps.numerator}/{p.fps.denominator}"
    ms_per_frame = 1000.0 / float(p.fps)

    dec = [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-an", "-sn",
           "-fps_mode", "passthrough", "-pix_fmt", "bgr24", "-f", "rawvideo", "-"]
    enc = [ffmpeg, "-v", "error", "-y", "-hide_banner",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", fps, "-i", "-",
           "-i", path, "-map", "0:v", "-map", "1:a?", "-sn", "-dn"]
    if w % 2 or h % 2:
        enc += ["-vf", "pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2"]
    enc += ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
    if p.audio_codec:
        enc += ["-c:a", "copy"] if p.audio_codec in MP4_AUDIO else ["-c:a", "aac", "-b:a", "192k"]
    enc += ["-map_metadata", "-1", "-map_chapters", "-1"] if strip else ["-map_metadata", "1"]
    part = out + ".part"
    enc += ["-movflags", "+faststart", "-f", "mp4", part]

    derr, eerr = tempfile.TemporaryFile(), tempfile.TemporaryFile()
    dproc = eproc = None
    count = 0
    ok = False
    try:
        dproc = _popen(dec, stdout=subprocess.PIPE, stderr=derr, bufsize=0)
        eproc = _popen(enc, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=eerr, bufsize=0)
        ctx.stage("Hiding faces and plates")
        for idx, frame in enumerate(_read_frames(dproc, w, h)):
            ctx.check_cancelled()
            ms = idx * ms_per_frame
            regions = [
                r
                for box, kind in boxes_at(tracks, manual, ms)
                if (r := render.region_for(box, kind, padding, w, h)) is not None
            ]
            if regions:
                render.apply_regions(frame, regions, style, strength)
            try:
                eproc.stdin.write(memoryview(frame).cast("B"))  # type: ignore[union-attr]
            except (BrokenPipeError, OSError) as e:
                raise HandlerError("tool_failed", "FFmpeg couldn't write the video", _tail(eerr)) from e
            count += 1
            ctx.progress(min(0.99, count / p.est_frames), f"Frame {count} of about {p.est_frames}")
        if count == 0:
            raise HandlerError("tool_failed", "FFmpeg couldn't decode this video", _tail(derr))
        ctx.stage("Finishing")
        eproc.stdin.close()  # type: ignore[union-attr]
        if eproc.wait() != 0:
            raise HandlerError("tool_failed", "FFmpeg couldn't encode the video", _tail(eerr))
        ctx.check_cancelled()
        os.replace(part, out)
        ok = True
    finally:
        _kill(dproc, eproc)
        derr.close()
        eerr.close()
        if not ok:
            try:
                os.remove(part)
            except OSError:
                pass
    return {"out": out, "frames": count, "width": w, "height": h}
