"""Shared fixtures: generated audio signals and a fake Context."""

from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from toolbox_sidecar.protocol import Writer  # noqa: E402
from toolbox_sidecar.registry import Context  # noqa: E402

SR = 22050


def midi_hz(m: int) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def _note(freq: float, dur: float) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    y = sum(a * np.sin(2 * np.pi * freq * h * t) for h, a in [(1, 1.0), (2, 0.5), (3, 0.25)])
    return y * np.minimum(1, t / 0.01) * np.exp(-t * 1.2)


def make_track(bpm: float, chords: list[list[int]]) -> np.ndarray:
    """One chord per bar (4 beats) plus a click on every beat."""
    beat = 60.0 / bpm
    out = np.zeros(int(len(chords) * 4 * beat * SR) + SR // 2)
    for i, chord in enumerate(chords):
        start = int(i * 4 * beat * SR)
        for m in chord:
            n = _note(midi_hz(m), 4 * beat)
            out[start : start + len(n)] += n * 0.25
    t = np.arange(int(0.03 * SR)) / SR
    click = 0.8 * np.sin(2 * np.pi * 1500 * t) * np.exp(-t * 150)
    for b in range(len(chords) * 4):
        s = int(b * beat * SR)
        out[s : s + len(click)] += click
    return out / (np.abs(out).max() * 1.05)


C, F, G = [60, 64, 67], [53, 57, 60], [55, 59, 62]
A, D, E = [57, 60, 64], [50, 53, 57], [52, 56, 59]


def _write(path: Path, y: np.ndarray) -> str:
    sf.write(str(path), y, SR)
    return str(path)


@pytest.fixture
def cmaj_120(tmp_path: Path) -> str:
    """120 BPM click track, C–F–G–C twice (~16 s)."""
    return _write(tmp_path / "cmaj_120.wav", make_track(120, [C, F, G, C, C, F, G, C]))


@pytest.fixture
def amin_100(tmp_path: Path) -> str:
    """100 BPM click track, Am–Dm–E–Am twice (~19 s)."""
    return _write(tmp_path / "amin_100.wav", make_track(100, [A, D, E, A, A, D, E, A]))


@pytest.fixture
def c_triad(tmp_path: Path) -> str:
    """Sustained C-major triad C4/E4/G4, 4 s."""
    t = np.arange(4 * SR) / SR
    y = sum(np.sin(2 * np.pi * midi_hz(m) * t) for m in (60, 64, 67)) / 3 * 0.8
    y *= np.minimum(1, t / 0.02) * np.minimum(1, (4 - t) / 0.05)
    return _write(tmp_path / "c_triad.wav", y)


@pytest.fixture
def silence(tmp_path: Path) -> str:
    return _write(tmp_path / "silence.wav", np.zeros(int(0.2 * SR)))


class Captured:
    """A Context writing JSON lines into memory."""

    def __init__(self) -> None:
        self.buf = io.StringIO()
        self.ctx = Context("t1", Writer(self.buf))

    @property
    def messages(self) -> list[dict]:
        return [json.loads(line) for line in self.buf.getvalue().splitlines() if line]

    def events(self, kind: str) -> list[dict]:
        return [m["data"] for m in self.messages if m.get("event") == kind]


@pytest.fixture
def cap() -> Captured:
    return Captured()


def pytest_collection_modifyitems(config, items):
    if os.environ.get("TOOLBOX_SLOW") == "1":
        return
    skip = pytest.mark.skip(reason="slow: set TOOLBOX_SLOW=1")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)
