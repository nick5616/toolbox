"""transcribe.run: writers, naming, validation, cancellation (fake model), slow real model."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from toolbox_sidecar.handlers import transcribe as tr
from toolbox_sidecar.registry import HandlerError

SEGS = [
    {"start": 0.0, "end": 1.5, "text": " Hello world. "},
    {"start": 3725.0006, "end": 3726.9996, "text": "Second\n\nline é"},
]


@pytest.mark.parametrize(
    "sec,sep,want",
    [
        (0, ",", "00:00:00,000"),
        (1.5, ".", "00:00:01.500"),
        (59.9996, ",", "00:01:00,000"),
        (3725.0006, ",", "01:02:05,001"),
        (360000, ".", "100:00:00.000"),
        (-1, ",", "00:00:00,000"),
    ],
)
def test_format_timestamp(sec, sep, want):
    assert tr.format_timestamp(sec, sep) == want


@pytest.mark.parametrize("sec,want", [(0, "0:00"), (83, "1:23"), (250.9, "4:10"), (3600, "1:00:00"), (3725, "1:02:05")])
def test_format_clock(sec, want):
    assert tr.format_clock(sec) == want


def test_srt():
    assert tr.to_srt(SEGS) == (
        "1\n00:00:00,000 --> 00:00:01,500\nHello world.\n\n"
        "2\n01:02:05,001 --> 01:02:07,000\nSecond\nline é\n"
    )
    assert tr.to_srt([]) == ""


def test_vtt():
    assert tr.to_vtt(SEGS).startswith("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello world.\n\n01:02:05.001 --> ")
    assert tr.to_vtt([]) == "WEBVTT\n\n"


def test_txt():
    assert tr.to_txt(SEGS) == "Hello world.\nSecond\n\nline é\n"
    assert tr.to_txt([]) == ""


def test_json():
    segs = [{"start": 0, "end": 1, "text": "é", "words": [{"start": 0, "end": 1, "word": "é"}]}]
    doc = json.loads(tr.to_json("en", 1.0, segs))
    assert doc == {"language": "en", "duration": 1.0, "segments": segs}
    assert "é" in tr.to_json("en", 1.0, segs)
    assert json.loads(tr.to_json("en", 0, [])) == {"language": "en", "duration": 0, "segments": []}


def test_unique_path(tmp_path: Path):
    d = str(tmp_path)
    assert tr.unique_path(d, "a", "txt") == os.path.join(d, "a.txt")
    (tmp_path / "a.txt").write_text("x")
    assert tr.unique_path(d, "a", "txt") == os.path.join(d, "a (1).txt")
    (tmp_path / "a (1).txt").write_text("x")
    assert tr.unique_path(d, "a", "txt") == os.path.join(d, "a (2).txt")


def test_write_new_never_overwrites(tmp_path: Path):
    (tmp_path / "a.txt").write_text("old")
    p = tr._write_new(str(tmp_path), "a", "txt", "new")
    assert p.endswith("a (1).txt")
    assert (tmp_path / "a.txt").read_text() == "old"
    assert sorted(os.listdir(tmp_path)) == ["a (1).txt", "a.txt"]  # no temp left


class FakeModel:
    def __init__(self, segs, duration=10.0, on_seg=None):
        self.segs, self.duration, self.on_seg = segs, duration, on_seg
        self.kwargs: dict = {}

    def transcribe(self, path, **kw):
        self.kwargs = kw

        def gen():
            for s in self.segs:
                if self.on_seg:
                    self.on_seg(s)
                yield s

        return gen(), NS(language="en", language_probability=0.97, duration=self.duration)


def seg(a, b, t, words=()):
    return NS(start=a, end=b, text=t, words=[NS(start=a, end=b, word=w) for w in words])


@pytest.fixture
def audio(tmp_path: Path) -> str:
    p = tmp_path / "in.wav"
    p.write_bytes(b"x")
    return str(p)


def params(audio: str, tmp_path: Path, **over):
    p = {
        "input": audio, "outputDir": str(tmp_path / "out"), "baseName": "in",
        "model": "Systran/faster-whisper-base", "modelDir": str(tmp_path / "m"),
        "language": None, "task": "transcribe", "formats": ["txt", "srt"], "vad": True,
    }
    p.update(over)
    return p


@pytest.fixture
def fake(monkeypatch):
    def install(model):
        monkeypatch.setattr(tr, "_has_model", lambda d: True)
        monkeypatch.setattr(tr, "_load_model", lambda d: model)

    return install


@pytest.mark.parametrize(
    "over,msg",
    [
        ({"input": ""}, "input"),
        ({"input": "/nonexistent/x.wav"}, "not found"),
        ({"outputDir": ""}, "outputDir"),
        ({"model": ""}, "model"),
        ({"modelDir": None}, "modelDir"),
        ({"task": "x"}, "task"),
        ({"formats": []}, "formats"),
        ({"formats": ["pdf"]}, "formats"),
        ({"formats": ["txt", "txt"]}, "duplicates"),
        ({"language": 5}, "language"),
        ({"vad": "yes"}, "vad"),
    ],
)
def test_validation(audio, tmp_path, cap, over, msg):
    with pytest.raises(HandlerError) as ei:
        tr.run(cap.ctx, params(audio, tmp_path, **over))
    assert ei.value.code == "validation"
    assert msg in ei.value.message


def test_run_writes_outputs(audio, tmp_path, cap, fake, monkeypatch):
    monkeypatch.setattr("toolbox_sidecar.registry.PROGRESS_INTERVAL", 0)
    m = FakeModel([seg(0, 2, " Hi there", ["Hi", " there"]), seg(2, 5, "Bye")])
    fake(m)
    res = tr.run(cap.ctx, params(audio, tmp_path, formats=["txt", "srt", "vtt", "json"], language="en", vad=False))
    assert m.kwargs == {"language": "en", "task": "transcribe", "vad_filter": False, "word_timestamps": True}
    assert res["language"] == "en" and res["segments"] == 2 and res["words"] == 2 and res["durationSec"] == 10.0
    assert [os.path.basename(p) for p in res["outputs"]] == ["in.txt", "in.srt", "in.vtt", "in.json"]
    assert [e["path"] for e in cap.events("output")] == res["outputs"]
    assert Path(res["outputs"][0]).read_text(encoding="utf-8") == "Hi there\nBye\n"
    doc = json.loads(Path(res["outputs"][3]).read_text(encoding="utf-8"))
    assert doc["segments"][0]["words"][0]["word"] == " Hi".strip()
    msgs = [e["msg"] for e in cap.events("progress")]
    assert any(re.fullmatch(r"Transcribing · 0:0\d / 0:10", x) for x in msgs)


def test_run_silence_and_no_word_timestamps(audio, tmp_path, cap, fake):
    m = FakeModel([])
    fake(m)
    res = tr.run(cap.ctx, params(audio, tmp_path, formats=["txt", "srt", "vtt"]))
    assert m.kwargs["word_timestamps"] is False and m.kwargs["language"] is None
    assert res["segments"] == 0
    assert Path(res["outputs"][0]).read_text() == ""
    assert Path(res["outputs"][2]).read_text() == "WEBVTT\n\n"


def test_run_existing_outputs_not_overwritten(audio, tmp_path, cap, fake):
    fake(FakeModel([seg(0, 1, "x")]))
    p = params(audio, tmp_path, formats=["txt"])
    tr.run(cap.ctx, p)
    res = tr.run(cap.ctx, p)
    assert os.path.basename(res["outputs"][0]) == "in (1).txt"


def test_cancel_between_segments(audio, tmp_path, cap, fake):
    seen = []

    def on_seg(s):
        seen.append(s)
        if len(seen) == 2:
            cap.ctx.request_cancel()

    fake(FakeModel([seg(0, 1, "a"), seg(1, 2, "b"), seg(2, 3, "c"), seg(3, 4, "d")], on_seg=on_seg))
    with pytest.raises(HandlerError) as ei:
        tr.run(cap.ctx, params(audio, tmp_path))
    assert ei.value.code == "cancelled"
    assert len(seen) == 2
    assert not list((tmp_path / "out").iterdir())


def test_model_error_is_tool_failed(audio, tmp_path, cap, monkeypatch):
    monkeypatch.setattr(tr, "_has_model", lambda d: True)

    def boom(d):
        raise RuntimeError("bad model")

    monkeypatch.setattr(tr, "_load_model", boom)
    with pytest.raises(HandlerError) as ei:
        tr.run(cap.ctx, params(audio, tmp_path))
    assert ei.value.code == "tool_failed"


MP3 = Path("C:/Users/nickb/repos/toolbox/.dev/library/Downloads/Me at the zoo [jNQXAC9IVRw].mp3")


@pytest.mark.slow
@pytest.mark.skipif(not MP3.exists(), reason="sample audio missing")
def test_real_base_model(tmp_path, cap):
    # Reuse a locally cached snapshot when HF_HUB_CACHE has one (offline dev boxes); else download.
    model_dir = str(tmp_path / "base")
    snaps = Path(os.environ.get("HF_HUB_CACHE", "")) / "models--Systran--faster-whisper-base" / "snapshots"
    if snaps.is_dir() and any(snaps.iterdir()):
        model_dir = str(next(snaps.iterdir()))
    t0 = time.time()
    res = tr.run(
        cap.ctx,
        {
            "input": str(MP3), "outputDir": str(tmp_path / "out"), "baseName": "zoo",
            "model": "Systran/faster-whisper-base", "modelDir": model_dir,
            "language": None, "task": "transcribe", "formats": ["txt", "srt", "json"], "vad": True,
        },
    )
    print(f"transcribe base: {time.time() - t0:.1f}s")
    assert res["language"] == "en" and res["segments"] > 0
    assert "elephant" in Path(res["outputs"][0]).read_text(encoding="utf-8").lower()
    srt = Path(res["outputs"][1]).read_text(encoding="utf-8")
    assert re.match(r"1\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n", srt)
