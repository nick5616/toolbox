"""tts.speak / tts.prefetch: markdown cleaning, chapters, sentences, chunks,
params validation, a fake-engine run (chapters, cancellation) and the slow
real-model test (TOOLBOX_SLOW=1 plus TOOLBOX_TTS_MODEL / TOOLBOX_TTS_VOICES)."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from toolbox_sidecar import tts
from toolbox_sidecar.handlers import tts as handler
from toolbox_sidecar.registry import HANDLERS, Cancelled, HandlerError


def test_registered():
    assert "tts.speak" in HANDLERS and "tts.prefetch" in HANDLERS


# ---- markdown -----------------------------------------------------------------


def test_clean_markdown_strips_markup():
    md = (
        "# Title\n\nSome **bold** and *italic* text with a [link](https://x.example/a) and `code`.\n\n"
        "![alt](pic.png)\n\n- item one\n- item two\n1. first\n\n> quoted\n\n```py\nprint(1)\n```\n\n"
        "Visit https://example.com now.\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    )
    out = tts.clean_markdown(md)
    assert out.startswith("# Title")
    assert "bold and italic text with a link and code." in out
    assert "item one" in out and "first" in out and "quoted" in out
    for gone in ("**", "https://", "print(1)", "pic.png", "|---", "```"):
        assert gone not in out
    assert "1, 2" in out


def test_clean_markdown_setext_and_comments():
    out = tts.clean_markdown("Chapter One\n===========\n\nText.\n\n<!-- hidden -->\n\nSub\n---\n\nMore.")
    assert out.splitlines()[0] == "# Chapter One"
    assert "## Sub" in out and "hidden" not in out


def test_clean_markdown_handles_crlf_and_bom():
    assert tts.clean_markdown("﻿Hello\r\nworld") == "Hello\nworld"


# ---- chapters -----------------------------------------------------------------


DOC = "Preface text.\n\n# One\n\nAlpha.\n\n## Detail\n\nBeta.\n\n# Two\n\nGamma.\n"


def test_split_none_is_one_chapter_with_headings_spoken():
    chapters = tts.split_chapters(DOC, "none")
    assert len(chapters) == 1 and chapters[0].title == ""
    assert "#" not in chapters[0].text and "One" in chapters[0].text and "Detail" in chapters[0].text


def test_split_headings_uses_the_top_level_and_keeps_intro():
    chapters = tts.split_chapters(DOC, "headings")
    assert [c.title for c in chapters] == ["Introduction", "One", "Two"]
    assert chapters[1].text.startswith("One") and "Detail" in chapters[1].text and "Beta." in chapters[1].text
    assert "Gamma." not in chapters[1].text


def test_split_headings_merges_empty_heading_into_next():
    chapters = tts.split_chapters("# Part\n\n# Chapter\n\nBody text.\n", "headings")
    assert len(chapters) == 1
    assert chapters[0].title == "Chapter" and "Part" in chapters[0].text


def test_split_headings_without_headings_is_one_chapter():
    chapters = tts.split_chapters("Just text.", "headings")
    assert len(chapters) == 1 and chapters[0].title == ""


def test_split_headings_starts_at_the_shallowest_level():
    chapters = tts.split_chapters("## A\n\nx\n\n### B\n\ny\n\n## C\n\nz\n", "headings")
    assert [c.title for c in chapters] == ["A", "C"]


@pytest.mark.parametrize(
    "title,expected",
    [("A: B/C?", "A B C"), ("  .dots. ", "dots"), ("x" * 100, "x" * 60), ("", "")],
)
def test_safe_name(title, expected):
    assert tts.safe_name(title) == expected


def test_chapter_file_names():
    assert handler.chapter_file_names("Book", [""], False) == ["Book.wav"]
    names = handler.chapter_file_names("Book", ["Intro", "The: Sea"], True)
    assert names == ["Book - 01 Intro.wav", "Book - 02 The Sea.wav"]


# ---- sentences and chunks ------------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("One. Two! Three?", ["One.", "Two!", "Three?"]),
        ("Dr. Smith went home. He slept.", ["Dr. Smith went home.", "He slept."]),
        ("Meet J. Smith today. Fine.", ["Meet J. Smith today.", "Fine."]),
        ('She said "Stop." Then left.', ['She said "Stop."', "Then left."]),
        ("No terminal punctuation", ["No terminal punctuation"]),
        ("", []),
    ],
)
def test_split_sentences(text, expected):
    assert tts.split_sentences(text) == expected


def test_long_sentence_is_broken_at_clauses():
    text = ", ".join(["word " * 20 + "end"] * 8) + "."
    parts = tts.split_sentences(text)
    assert len(parts) > 1 and all(len(p) <= tts.MAX_SENTENCE for p in parts)
    assert " ".join(parts).split() == text.split()


def test_make_chunks_packs_and_pauses():
    text = "# Heading\n\n" + " ".join(f"Sentence number {i}." for i in range(40)) + "\n\nSecond paragraph."
    chunks = tts.make_chunks(text, limit=100)
    assert chunks[0].text == "Heading." and chunks[0].pause == tts.PAUSE_HEADING
    assert all(c.chars <= 100 for c in chunks[1:-1])
    assert chunks[-1].text == "Second paragraph." and chunks[-1].pause == 0
    assert any(c.pause == tts.PAUSE_PARAGRAPH for c in chunks)
    assert any(c.pause == tts.PAUSE_CHUNK for c in chunks)
    # Nothing lost or duplicated.
    spoken = " ".join(c.text for c in chunks)
    assert spoken.count("Sentence number") == 40


def test_make_chunks_joins_hard_wrapped_lines():
    chunks = tts.make_chunks("This is one\nwrapped sentence.")
    assert [c.text for c in chunks] == ["This is one wrapped sentence."]


def test_make_chunks_empty():
    assert tts.make_chunks("\n\n  \n") == []


# ---- params ---------------------------------------------------------------------


@pytest.fixture
def files(tmp_path: Path) -> dict[str, str]:
    (tmp_path / "in.md").write_text(DOC, encoding="utf-8")
    (tmp_path / "m.onnx").write_bytes(b"x")
    (tmp_path / "v.bin").write_bytes(b"x")
    return {
        "input": str(tmp_path / "in.md"),
        "outputDir": str(tmp_path / "out"),
        "baseName": "Doc",
        "voice": "af_heart",
        "speed": 1.0,
        "lang": "en-us",
        "split": "none",
        "modelPath": str(tmp_path / "m.onnx"),
        "voicesPath": str(tmp_path / "v.bin"),
    }


@pytest.mark.parametrize(
    "patch",
    [
        {"speed": 0.2},
        {"speed": 3},
        {"speed": "fast"},
        {"split": "paragraphs"},
        {"lang": "xx"},
        {"voice": ""},
        {"input": "/nope/none.txt"},
        {"modelPath": "/nope/m.onnx"},
        {"voicesPath": "/nope/v.bin"},
        {"outputDir": ""},
    ],
)
def test_params_validation(cap, files, patch):
    with pytest.raises(HandlerError) as e:
        handler.speak(cap.ctx, {**files, **patch})
    assert e.value.code == "validation"


def test_empty_text_is_rejected(cap, files, tmp_path):
    (tmp_path / "e.md").write_text("```\ncode only\n```\n", encoding="utf-8")
    with pytest.raises(HandlerError) as e:
        handler.speak(cap.ctx, {**files, "input": str(tmp_path / "e.md")})
    assert e.value.code == "validation"


# ---- a fake engine ---------------------------------------------------------------


class FakeKokoro:
    def __init__(self, on_create=None):
        self.calls: list[tuple[str, str, float, str]] = []
        self.on_create = on_create

    def get_voices(self):
        return ["af_heart", "bm_george"]

    def create(self, text, voice, speed=1.0, lang="en-us", trim=True, **_):
        self.calls.append((text, voice, speed, lang))
        if self.on_create:
            self.on_create(len(self.calls))
        if text.strip(".") == "":
            raise ValueError("nothing speakable")
        return np.full(2400, 0.1, dtype=np.float32), 24000  # 0.1 s


@pytest.fixture
def fake(monkeypatch):
    eng = FakeKokoro()
    monkeypatch.setattr(handler, "_load_engine", lambda *_: eng)
    return eng


def test_speak_writes_one_wav(cap, files, fake):
    res = handler.speak(cap.ctx, files)
    assert len(res["files"]) == 1 and res["sampleRate"] == 24000
    f = res["files"][0]
    assert os.path.basename(f["path"]) == "Doc.wav" and f["chapter"] is False
    data, sr = sf.read(f["path"])
    assert sr == 24000 and data.ndim == 1 and len(data) / sr == pytest.approx(res["seconds"], abs=0.01)
    assert all(c[1:] == ("af_heart", 1.0, "en-us") for c in fake.calls)
    progress = [e["pct"] for e in cap.events("progress") if e["pct"] >= 0]
    assert progress[-1] == 1.0 and progress == sorted(progress)


def test_speak_splits_chapters(cap, files, fake):
    res = handler.speak(cap.ctx, {**files, "split": "headings"})
    assert [os.path.basename(f["path"]) for f in res["files"]] == [
        "Doc - 01 Introduction.wav",
        "Doc - 02 One.wav",
        "Doc - 03 Two.wav",
    ]
    assert all(f["chapter"] for f in res["files"])
    assert all(os.path.isfile(f["path"]) for f in res["files"])


def test_speak_unknown_voice(cap, files, fake):
    with pytest.raises(HandlerError) as e:
        handler.speak(cap.ctx, {**files, "voice": "zz_nobody"})
    assert e.value.code == "validation"


def test_speak_skips_unspeakable_passages(cap, files, fake, tmp_path):
    (tmp_path / "s.md").write_text("Hello there.\n\n...\n\nBye now.", encoding="utf-8")
    res = handler.speak(cap.ctx, {**files, "input": str(tmp_path / "s.md")})
    assert res["seconds"] > 0
    assert any(m["level"] == "warning" for m in cap.events("log"))


def test_speak_cancel_removes_partial_file(cap, files, monkeypatch):
    eng = FakeKokoro(on_create=lambda n: cap.ctx.request_cancel() if n == 2 else None)
    monkeypatch.setattr(handler, "_load_engine", lambda *_: eng)
    long = "\n\n".join(f"Paragraph {i} is here." for i in range(10))
    Path(files["input"]).write_text(long, encoding="utf-8")
    with pytest.raises(Cancelled):
        handler.speak(cap.ctx, files)
    assert len(eng.calls) == 2
    assert not list(Path(files["outputDir"]).glob("*.wav"))


def test_speaking_rate_shortens_pauses(cap, files, fake):
    Path(files["input"]).write_text("One.\n\nTwo.", encoding="utf-8")
    slow = handler.speak(cap.ctx, {**files, "speed": 0.5})["seconds"]
    fast = handler.speak(cap.ctx, {**files, "speed": 2.0})["seconds"]
    assert slow > fast


# ---- real model (slow) -------------------------------------------------------------


@pytest.mark.slow
def test_real_kokoro(cap, files):
    model, voices = os.environ.get("TOOLBOX_TTS_MODEL"), os.environ.get("TOOLBOX_TTS_VOICES")
    if not model or not voices:
        pytest.skip("set TOOLBOX_TTS_MODEL and TOOLBOX_TTS_VOICES")
    Path(files["input"]).write_text("Hello there. This is a short test of the voice.", encoding="utf-8")
    res = handler.speak(cap.ctx, {**files, "modelPath": model, "voicesPath": voices})
    data, sr = sf.read(res["files"][0]["path"])
    assert sr == 24000 and 1.5 < len(data) / sr < 15 and np.abs(data).max() > 0.05
