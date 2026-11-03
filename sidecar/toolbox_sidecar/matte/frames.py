"""Frame I/O for mattes: read an Annex-B edit stream from a keyframe, write a grey matte stream.

Reading (SPEC 10.3): the index says where the keyframe at or before ``from_frame`` starts; those bytes
are piped to FFmpeg, which decodes to rgb24 at the wanted size; frames before ``from_frame`` are dropped.
Writing: raw grey frames go to an FFmpeg x264 encoder with the edit-stream settings (SPEC 7.1) into
``<out>.part``, renamed by the caller.
"""

from __future__ import annotations

import bisect
import json
import os
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator
from typing import Any

import numpy as np

from ..registry import HandlerError

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
_FEED_CHUNK = 1 << 20


class StreamIndex:
    """``<stream>.idx.json``: frame ``n`` is bytes ``[offsets[n], offsets[n+1])``; ``keys`` are IDR frames."""

    def __init__(self, frames: int, offsets: list[int], keys: list[int]) -> None:
        self.frames, self.offsets, self.keys = frames, offsets, keys

    @classmethod
    def load(cls, path: str) -> "StreamIndex":
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            frames, offsets, keys = int(d["frames"]), [int(o) for o in d["offsets"]], [int(k) for k in d["keys"]]
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise HandlerError("validation", "The edit stream's index is unreadable", str(e)) from e
        if frames < 1 or len(offsets) != frames + 1 or not keys or keys[0] != 0:
            raise HandlerError("validation", "The edit stream's index is damaged")
        return cls(frames, offsets, keys)

    def key_at_or_before(self, frame: int) -> int:
        i = bisect.bisect_right(self.keys, frame) - 1
        return self.keys[max(i, 0)]


def _tail(f: Any) -> str:
    try:
        f.flush()
        f.seek(0)
        return f.read().decode("utf-8", "replace").strip()[-400:]
    except Exception:
        return ""


def kill(*procs: "subprocess.Popen[bytes] | None") -> None:
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


class FrameReader:
    """Yields ``(h, w, 3)`` uint8 RGB arrays for frames ``[from_frame, to_frame)`` of a stream.

    Use as a context manager: the FFmpeg process and the feeder thread are always cleaned up.
    """

    def __init__(
        self, ffmpeg: str, stream: str, index: StreamIndex, from_frame: int, to_frame: int, fps: float, width: int, height: int
    ) -> None:
        if not 0 <= from_frame < to_frame <= index.frames:
            raise HandlerError("validation", "The frame range is outside the edit stream")
        self.ffmpeg, self.stream, self.index = ffmpeg, stream, index
        self.from_frame, self.to_frame, self.fps = from_frame, to_frame, fps
        self.width, self.height = width, height
        self.start = index.key_at_or_before(from_frame)
        self._proc: subprocess.Popen[bytes] | None = None
        self._err = tempfile.TemporaryFile()
        self._feeder: threading.Thread | None = None

    def _feed(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdin is not None
        lo, hi = self.index.offsets[self.start], self.index.offsets[self.to_frame]
        try:
            with open(self.stream, "rb") as f:
                f.seek(lo)
                left = hi - lo
                while left > 0:
                    buf = f.read(min(_FEED_CHUNK, left))
                    if not buf:
                        break
                    proc.stdin.write(buf)
                    left -= len(buf)
        except (BrokenPipeError, OSError, ValueError):
            pass
        finally:
            try:
                proc.stdin.close()
            except (OSError, ValueError):
                pass

    def __enter__(self) -> "FrameReader":
        cmd = [
            self.ffmpeg, "-v", "error", "-nostdin", "-f", "h264", "-framerate", f"{self.fps:g}", "-i", "pipe:0",
            "-an", "-sn", "-fps_mode", "passthrough",
            "-vf", f"scale={self.width}:{self.height}:flags=bicubic", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
        ]
        self._proc = subprocess.Popen(
            cmd, creationflags=_NO_WINDOW, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._err, bufsize=0
        )
        self._feeder = threading.Thread(target=self._feed, daemon=True)
        self._feeder.start()
        return self

    def __exit__(self, *exc: object) -> None:
        kill(self._proc)
        if self._feeder is not None:
            self._feeder.join(timeout=10)
        self._err.close()

    def __iter__(self) -> Iterator[np.ndarray]:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        w, h = self.width, self.height
        n = w * h * 3
        skip = self.from_frame - self.start
        want = self.to_frame - self.from_frame
        delivered = 0
        seen = 0
        while delivered < want:
            buf = np.empty((h, w, 3), np.uint8)
            view = memoryview(buf).cast("B")
            got = 0
            while got < n:
                k = proc.stdout.readinto(view[got:])
                if not k:
                    break
                got += k
            if got < n:
                break
            seen += 1
            if seen <= skip:
                continue
            delivered += 1
            yield buf
        if delivered < want:
            raise HandlerError("tool_failed", "FFmpeg couldn't decode the edit stream", _tail(self._err))


class Encoder:
    """Raw grey frames -> H.264 Annex-B (edit-stream settings, SPEC 7.1) at ``out_part``."""

    def __init__(self, ffmpeg: str, width: int, height: int, fps: float, out_part: str) -> None:
        self.width, self.height, self.out_part = width, height, out_part
        self._err = tempfile.TemporaryFile()
        cmd = [
            ffmpeg, "-v", "error", "-hide_banner", "-nostdin", "-y",
            "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{width}x{height}", "-r", f"{fps:g}", "-i", "pipe:0",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-profile:v", "high", "-bf", "0", "-g", "10",
            "-keyint_min", "10", "-sc_threshold", "0", "-x264-params", "aud=1:repeat-headers=1",
            "-pix_fmt", "yuv420p", "-f", "h264", out_part,
        ]
        self._proc: subprocess.Popen[bytes] | None = subprocess.Popen(
            cmd, creationflags=_NO_WINDOW, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=self._err, bufsize=0
        )
        self.count = 0

    def write(self, gray: np.ndarray) -> None:
        if gray.shape != (self.height, self.width) or gray.dtype != np.uint8:
            raise ValueError("matte frame has the wrong shape or type")
        assert self._proc is not None and self._proc.stdin is not None
        try:
            self._proc.stdin.write(memoryview(np.ascontiguousarray(gray)).cast("B"))
        except (BrokenPipeError, OSError) as e:
            raise HandlerError("tool_failed", "FFmpeg couldn't write the matte", _tail(self._err)) from e
        self.count += 1

    def finish(self) -> None:
        """Closes the pipe and waits; raises when FFmpeg failed."""
        assert self._proc is not None and self._proc.stdin is not None
        try:
            self._proc.stdin.close()
        except OSError:
            pass
        if self._proc.wait() != 0:
            raise HandlerError("tool_failed", "FFmpeg couldn't encode the matte", _tail(self._err))

    def abort(self) -> None:
        """Kills FFmpeg and removes the partial file."""
        self.close()
        try:
            os.remove(self.out_part)
        except OSError:
            pass

    def close(self) -> None:
        kill(self._proc)
        self._err.close()
