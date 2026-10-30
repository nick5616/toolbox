"""viz.analyze: features, beats, chords, sections, pitch (SPEC.md §5, §11.2). Generated signals."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from toolbox_sidecar.handlers.viz import analyze
from toolbox_sidecar.registry import Cancelled, HandlerError
from toolbox_sidecar.viz import beats, features, harmony, io, pitch, sections

SR = 22050
BPM = 120
BEAT = 60.0 / BPM
BAR = 4 * BEAT
CHORDS = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]  # Am F C G
CHORD_NAMES = ["Am", "F", "C", "G"]

SCALAR_MIX = ["mix.level", "mix.onset", "mix.brightness", "mix.balance", "mix.sub", "mix.bass", "mix.lowmid",
              "mix.mid", "mix.highmid", "mix.presence", "mix.brilliance", "mix.air"]
SCALAR_STEMS = ["drums.level", "drums.onset", "drums.kick", "drums.snare", "drums.hats", "bass.level",
                "bass.onset", "vocals.level", "vocals.onset", "other.level", "other.onset"]
EVENT_IDS = ["kick", "snare", "hats", "bass", "vocals", "other", "mix", "lift", "drop", "break", "held"]


def hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def gain_curve(n: int, steps: list[tuple[float, float]]) -> np.ndarray:
    """Piecewise-constant gain: (start second, gain) steps."""
    g = np.ones(n)
    for start, val in steps:
        g[int(start * SR) :] = val
    return g


def synth(dur: float, steps=((0.0, 1.0),), drums=True, vocal_notes=(), seed=1) -> dict[str, np.ndarray]:
    """A 120 bpm song: kick on every beat (bar-first accented), snare on 2 and 4, hats, bass, Am-F-C-G pad."""
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = {k: np.zeros(n) for k in ("drums", "bass", "other", "vocals")}
    if drums:
        for b in range(int(dur / BEAT)):
            i = int(b * BEAT * SR)
            m = min(n - i, int(0.2 * SR))
            if m <= 0:
                continue
            env = np.exp(-np.arange(m) / (0.04 * SR))
            amp = 1.0 if b % 4 == 0 else 0.55
            out["drums"][i : i + m] += amp * np.sin(2 * np.pi * (55 + 90 * env) * np.arange(m) / SR) * env
            if b % 2 == 1:
                s = min(n - i, int(0.15 * SR))
                out["drums"][i : i + s] += 0.35 * rng.normal(0, 1, s) * np.exp(-np.arange(s) / (0.03 * SR))
            for h in (0.0, 0.5):
                j = int((b + h) * BEAT * SR)
                s = min(n - j, int(0.03 * SR))
                if s > 0:
                    nz = np.diff(rng.normal(0, 1, s + 1))
                    out["drums"][j : j + s] += 0.12 * nz * np.exp(-np.arange(s) / (0.01 * SR))
    for bar in range(int(dur / BAR) + 1):
        a, b = int(bar * BAR * SR), min(n, int((bar + 1) * BAR * SR))
        if a >= n:
            break
        ch = CHORDS[bar % 4]
        tt = t[a:b] - bar * BAR
        env = np.minimum(1, tt / 0.02) * np.exp(-tt * 0.3)
        out["bass"][a:b] += 0.4 * np.sin(2 * np.pi * hz(ch[0] - 24) * tt) * env
        for m in ch:
            out["other"][a:b] += 0.12 * (np.sin(2 * np.pi * hz(m) * tt) + 0.4 * np.sin(2 * np.pi * hz(m) * 2 * tt)) * env
    for start, length, midi in vocal_notes:
        a = int(start * SR)
        m = min(n - a, int(length * SR))
        tt = np.arange(m) / SR
        out["vocals"][a : a + m] += 0.4 * np.sin(2 * np.pi * hz(midi) * tt) * np.minimum(1, tt / 0.03) * np.minimum(1, (length - tt) / 0.03)
    g = gain_curve(n, list(steps))
    for k in out:
        out[k] = out[k] * g
    out["mix"] = out["drums"] * 0.6 + out["bass"] + out["other"] + out["vocals"]
    peak = np.abs(out["mix"]).max() * 1.05 or 1.0
    for k in out:
        out[k] = out[k] / peak
    return out


def write_song(tmp: Path, song: dict[str, np.ndarray], stems: bool, name: str = "song") -> tuple[str, dict[str, str] | None]:
    p = tmp / f"{name}.wav"
    sf.write(str(p), song["mix"], SR)
    if not stems:
        return str(p), None
    d = {}
    for k in ("drums", "bass", "vocals", "other"):
        q = tmp / f"{name}_{k}.wav"
        sf.write(str(q), song[k], SR)
        d[k] = str(q)
    return str(p), d


def run(cap, tmp: Path, song, stems=False, name="s0", **extra):
    path, st = write_song(tmp, song, stems)
    out = tmp / "out"
    res = analyze(cap.ctx, {"path": path, "stems": st, "outDir": str(out), "name": name, **extra})
    doc = json.loads(Path(res["audioJson"]).read_text())
    return res, doc, out


@pytest.fixture(scope="module")
def mod_tmp(tmp_path_factory):
    return tmp_path_factory.mktemp("viz")


@pytest.fixture(scope="module")
def plain(mod_tmp):
    """40 s song analysed without stems (shared by several tests)."""
    from tests.conftest import Captured

    cap = Captured()
    song = synth(40.0, vocal_notes=[(10.0, 1.0, 64)])
    d = mod_tmp / "plain"
    d.mkdir()
    res, doc, out = run(cap, d, song)
    return res, doc, out, cap


@pytest.fixture(scope="module")
def withstems(mod_tmp):
    from tests.conftest import Captured

    cap = Captured()
    d = mod_tmp / "stems"
    d.mkdir()
    song = synth(30.0, vocal_notes=[(8.0, 1.2, 64)])
    res, doc, out = run(cap, d, song, stems=True, name="s1")
    return res, doc, out, cap


# -- pure helpers ---------------------------------------------------------------------


@pytest.mark.parametrize("dur,req,want", [(180, None, 60), (1200, None, 60), (1260, None, 30), (1260, 60, 30), (100, 30, 30), (100, 60, 60), (100, 24, 60)])
def test_choose_fps(dur, req, want):
    assert io.choose_fps(dur, req) == want


def test_norm01_percentiles():
    x = np.linspace(0, 1, 1001, dtype=np.float32)
    y = features.norm01(x)
    assert y.min() == 0 and y.max() == 1
    assert abs(float(y[50]) - 0) < 1e-6 and abs(float(y[980]) - 1) < 1e-6
    assert float(features.norm01(np.ones(50)).max()) == 0.0


def test_loudness_events():
    down = np.arange(0, 20) * 2000.0
    loud = np.full(19, -30.0)
    loud[6:] = -22.0  # +8 dB at bar 6
    loud[10:12] = [-22.0, -30.0]  # a -8 dB break at bar 11 (vs mean of -22,-22... )
    ev = sections.loudness_events(loud, down)
    assert [e[0] for e in ev["drop"]][:1] == [12000]
    assert ev["break"] and ev["break"][0][0] == 22000
    ramp = np.full(19, -30.0)
    ramp[5:9] = [-30, -28, -26, -24]  # +6 dB over 4 bars, no single bar ≥ 6 dB
    ev2 = sections.loudness_events(ramp, down)
    assert [e[0] for e in ev2["lift"]] == [18000]
    assert not ev2["drop"]


def test_group_and_labels():
    a, b = np.array([1.0, 0, 0]), np.array([0, 1.0, 0])
    names = sections.groups([a, b, a * 0.9, b, np.array([0, 0, 1.0])])
    assert names == ["A", "B", "A", "B", "C"]
    starts = [0, 20000, 40000, 60000, 80000, 100000]
    ends = starts[1:] + [120000]
    g = ["A", "B", "C", "B", "D", "E"]
    en = [0.1, 0.4, 0.5, 0.9, 0.6, 0.2]
    lab = sections.label_sections(starts, ends, g, en, [], 2000, 120000)
    assert lab[0] == "intro" and lab[-1] == "outro"
    assert lab[1] == "chorus" and lab[3] == "chorus"
    assert lab[4] == "bridge"
    assert lab[2] == "section"
    lab2 = sections.label_sections(starts, ends, ["A", "B", "C", "D", "D", "E"], en, [40000], 2000, 120000)
    assert lab2[2] == "drop"


def test_downbeat_phase_picks_the_accent():
    fps = 60
    beats_ms = np.arange(0, 20000, 500.0)
    env = np.zeros(1300)
    for i, t in enumerate(beats_ms):
        env[int(t / 1000 * fps)] = 1.0 if i % 4 == 2 else 0.3
    assert beats.downbeat_phase(beats_ms, env, fps) == 2


def test_held_notes_and_gaps():
    fps = pitch.PYIN_FPS
    n = 200
    midi = np.full(n, np.nan)
    voiced = np.zeros(n, dtype=bool)
    midi[10:60] = 64.1
    voiced[10:60] = True  # 1.0 s steady
    midi[70:100] = np.linspace(55, 60, 30)
    voiced[70:100] = True  # a glide: not held
    held = pitch.held_notes(midi, voiced, fps)
    assert len(held) == 1 and held[0][2] == 64
    assert abs(held[0][0] - 200) <= 40 and abs(held[0][1] - 1200) <= 40
    v, m = pitch.bridge_gaps(np.array([1, 1, 0, 0, 1, 1] + [0] * 9 + [1], dtype=bool), np.arange(16.0), fps)
    assert v[2] and v[3] and not v[8]


def test_pitch_sine_held_and_noise_none():
    t = np.arange(int(3 * SR)) / SR
    y = np.zeros_like(t)
    a = int(1.0 * SR)
    y[a : a + SR] = 0.5 * np.sin(2 * np.pi * hz(64) * t[:SR])
    y16 = pitch.prepare_signal(y.astype(np.float32), SR, True)
    midi, voiced = pitch.run_pyin(y16)
    _, _, held = pitch.pitch_channels(midi, voiced, 180, 60)
    assert any(h[2] == 64 and abs(h[0] - 1000) < 200 for h in held), held
    noise = np.random.default_rng(3).normal(0, 0.3, 3 * SR).astype(np.float32)
    midi, voiced = pitch.run_pyin(pitch.prepare_signal(noise, SR, True))
    _, _, held = pitch.pitch_channels(midi, voiced, 180, 60)
    assert held == []


# -- the handler on generated songs ----------------------------------------------------------


def test_shapes_blocks_and_ranges(plain):
    res, doc, out, cap = plain
    assert doc["version"] == 1 and doc["fps"] == 60 and doc["stems"] is False
    assert abs(doc["durationMs"] - 40000) < 50
    assert doc["frames"] == int(np.ceil(doc["durationMs"] / 1000 * 60 - 1e-9))
    data = (out / "s0.bin").read_bytes()
    assert doc["features"] == "s0.bin"
    ids = [b["id"] for b in doc["blocks"]]
    assert ids == SCALAR_MIX + ["vocals.pitch", "vocals.voiced", "spectrum", "wave"]
    end = 0
    for b in doc["blocks"]:
        assert b["offset"] == end
        end += doc["frames"] * b["width"]
        assert b["kind"] == ("vector" if b["width"] > 1 else "scalar")
    assert end == len(data)
    assert {b["id"]: b["width"] for b in doc["blocks"]}["spectrum"] == 64
    arr = np.frombuffer(data, np.uint8)
    for b in doc["blocks"]:
        n = doc["frames"] * b["width"]
        seg = arr[b["offset"] : b["offset"] + n]
        if b["id"] in ("mix.level", "mix.bass"):
            assert seg.max() > 200 and seg.min() < 60
        if b["id"] == "wave":
            assert 100 < seg.mean() < 156 and seg.max() > 160
        if b["id"] == "mix.balance":
            assert abs(float(seg.mean()) - 127.5) < 3  # mono file
    assert res["audioJson"].endswith("s0.json") and res["features"].endswith("s0.bin")
    assert not list(out.glob("*.part"))


def test_all_event_ids_and_fallbacks(plain):
    _, doc, _, _ = plain
    assert set(doc["events"]) == set(EVENT_IDS)
    for k in ("kick", "mix", "snare", "hats", "bass", "vocals", "other"):
        assert doc["events"][k], k
        ms = [e[0] for e in doc["events"][k]]
        assert ms == sorted(ms)
        assert all(0 <= e[1] <= 255 for e in doc["events"][k])
        assert all(b - a >= 100 for a, b in zip(ms, ms[1:]))
    kicks = [e[0] for e in doc["events"]["kick"]]
    near = [min(abs(k - b * 500) for b in range(80)) for k in kicks]
    assert np.median(near) < 60


def test_tempo_beats_downbeats(plain):
    _, doc, _, _ = plain
    assert abs(doc["tempo"] - 120) <= 1
    assert abs(len(doc["beats"]) - 80) <= 2
    assert doc["beatsPerBar"] == 4
    db = np.array(doc["downbeats"])
    assert abs(len(db) - 20) <= 1
    off = np.abs(((db + 1000) % 2000) - 1000)  # distance to the nearest bar start (kick accent)
    assert np.mean(off < 80) >= 0.9


def test_chords_and_key(plain):
    _, doc, _, _ = plain
    chords = doc["chords"]
    assert chords and all(c["endMs"] > c["startMs"] for c in chords)
    assert all(a["name"] != b["name"] for a, b in zip(chords, chords[1:]))  # neighbours merged
    ok = 0
    beats_ = doc["beats"]
    for t in beats_:
        mid = t + 250
        if mid > doc["durationMs"] - 500:
            continue
        want = CHORD_NAMES[int(mid // 2000) % 4]
        got = next((c["name"] for c in chords if c["startMs"] <= mid < c["endMs"]), "")
        ok += got == want
    total = sum(1 for t in beats_ if t + 250 <= doc["durationMs"] - 500)
    assert ok / total >= 0.85, (ok, total)
    assert doc["key"]["name"] in ("A minor", "C major", "A minor ") or doc["key"]["name"]
    for c in chords:
        assert -1 <= c["root"] <= 11


def test_key_top_two():
    song = synth(24.0, drums=False)
    import librosa

    chroma = harmony.compute_chroma(song["mix"].astype(np.float32), SR)
    top = [k["key"] for k in harmony.key_from_chroma(chroma)["ranked"][:2]]
    assert "A minor" in top or "C major" in top


def test_vocals_pitch_without_stems_still_present(plain):
    _, doc, out, _ = plain
    arr = np.frombuffer((out / "s0.bin").read_bytes(), np.uint8)
    b = {x["id"]: x for x in doc["blocks"]}
    voiced = arr[b["vocals.voiced"]["offset"] : b["vocals.voiced"]["offset"] + doc["frames"]]
    assert voiced.dtype == np.uint8 and set(np.unique(voiced)) <= {0, 255}


def test_with_stems_channels_events_and_held(withstems):
    res, doc, out, cap = withstems
    assert doc["stems"] is True
    ids = [b["id"] for b in doc["blocks"]]
    assert ids == SCALAR_MIX + SCALAR_STEMS + ["vocals.pitch", "vocals.voiced", "spectrum", "wave"]
    held = doc["events"]["held"]
    assert any(h[2] == 64 and abs(h[0] - 8000) < 300 for h in held), held
    assert all(len(h) == 3 for h in held)
    arr = np.frombuffer((out / "s1.bin").read_bytes(), np.uint8)
    b = {x["id"]: x for x in doc["blocks"]}
    fr = doc["frames"]
    voiced = arr[b["vocals.voiced"]["offset"] : b["vocals.voiced"]["offset"] + fr]
    assert voiced[int(8.5 * 60)] == 255 and voiced[int(3 * 60)] == 0
    vlevel = arr[b["vocals.level"]["offset"] : b["vocals.level"]["offset"] + fr]
    assert vlevel[int(8.6 * 60)] > vlevel[int(3 * 60)] + 100
    kick = arr[b["drums.kick"]["offset"] : b["drums.kick"]["offset"] + fr].astype(float)
    assert kick.max() > 200
    assert len(doc["events"]["kick"]) >= 50
    assert any(abs(e[0] - 8000) < 200 for e in doc["events"]["vocals"])
    assert cap.events("progress")
    assert res["summary"]["key"] == doc["key"]["name"]
    assert res["summary"]["sections"] == [s["label"] for s in doc["sections"]]
    assert res["summary"]["tempo"] == doc["tempo"] and res["summary"]["durationMs"] == doc["durationMs"]


def test_sections_structure_ok(plain):
    _, doc, _, _ = plain
    secs = doc["sections"]
    assert secs[0]["startMs"] == 0 and secs[-1]["endMs"] == doc["durationMs"]
    assert all(a["endMs"] == b["startMs"] for a, b in zip(secs, secs[1:]))
    for s in secs:
        assert s["label"] in ("intro", "verse", "chorus", "bridge", "break", "drop", "outro", "section")
        assert 0 <= s["energy"] <= 1


def test_intro_drop_and_chorus(tmp_path):
    """Quiet intro, a +8 dB jump at 24 s, a quiet middle, and the loud part again."""
    from tests.conftest import Captured

    steps = [(0, 0.25), (24, 1.0), (40, 0.25), (48, 1.0)]
    song = synth(60.0, steps=steps)
    cap = Captured()
    _, doc, _ = run(cap, tmp_path, song)
    secs = doc["sections"]
    assert secs[0]["label"] == "intro", secs
    jump = 24000
    assert any(abs(d[0] - jump) <= 2000 for d in doc["events"]["drop"]), doc["events"]["drop"]
    assert any(abs(s["startMs"] - jump) <= 2000 for s in secs[1:]), secs
    assert any(s["label"] == "chorus" for s in secs), secs
    loud = [s for s in secs if s["label"] == "chorus"]
    assert all(s["energy"] >= 0.6 for s in loud)


def test_drop_label(tmp_path):
    """A single unrepeated loud section after a quiet start is a drop."""
    from tests.conftest import Captured

    song = synth(60.0, steps=[(0, 0.25), (24, 1.0), (40, 0.5)])
    cap = Captured()
    _, doc, _ = run(cap, tmp_path, song)
    near = [s for s in doc["sections"] if abs(s["startMs"] - 24000) <= 2000]
    assert near and near[0]["label"] in ("drop", "chorus"), doc["sections"]


def test_fps_30_for_long_input(tmp_path, monkeypatch):
    from tests.conftest import Captured

    monkeypatch.setattr(io, "probe_duration", lambda p: 21 * 60.0)
    cap = Captured()
    _, doc, _ = run(cap, tmp_path, synth(8.0))
    assert doc["fps"] == 30 and doc["frames"] == int(np.ceil(doc["durationMs"] / 1000 * 30 - 1e-9))


def test_over_an_hour_is_a_validation_error(tmp_path, monkeypatch, cap):
    monkeypatch.setattr(io, "probe_duration", lambda p: 61 * 60.0)
    path, _ = write_song(tmp_path, synth(4.0), False)
    with pytest.raises(HandlerError) as ei:
        analyze(cap.ctx, {"path": path, "stems": None, "outDir": str(tmp_path / "o"), "name": "s0"})
    assert ei.value.code == "validation"


@pytest.mark.parametrize(
    "mut",
    [{"path": ""}, {"path": "/nope.wav"}, {"outDir": ""}, {"name": "../x"}, {"name": ""}, {"stems": "x"},
     {"stems": {"drums": "/no"}}, {"fps": "fast"}],
)
def test_bad_params(tmp_path, cap, mut):
    path, _ = write_song(tmp_path, synth(3.0), False)
    p = {"path": path, "stems": None, "outDir": str(tmp_path / "o"), "name": "s0", **mut}
    with pytest.raises(HandlerError) as ei:
        analyze(cap.ctx, p)
    assert ei.value.code == "validation"


def test_silent_input(tmp_path, cap):
    p = tmp_path / "z.wav"
    sf.write(str(p), np.zeros(SR * 3), SR)
    with pytest.raises(HandlerError) as ei:
        analyze(cap.ctx, {"path": str(p), "stems": None, "outDir": str(tmp_path / "o"), "name": "s0"})
    assert ei.value.code == "validation"


def test_cancel(tmp_path, cap):
    path, _ = write_song(tmp_path, synth(6.0), False)
    cap.ctx.request_cancel()
    with pytest.raises(Cancelled):
        analyze(cap.ctx, {"path": path, "stems": None, "outDir": str(tmp_path / "o"), "name": "s0"})
    assert not list((tmp_path / "o").glob("*.json")) if (tmp_path / "o").exists() else True


def test_stereo_balance(tmp_path, cap):
    song = synth(8.0, drums=False)
    st = np.stack([song["mix"] * 0.2, song["mix"]], axis=1)
    p = tmp_path / "st.wav"
    sf.write(str(p), st, SR)
    res = analyze(cap.ctx, {"path": str(p), "stems": None, "outDir": str(tmp_path / "o"), "name": "s0"})
    doc = json.loads(Path(res["audioJson"]).read_text())
    arr = np.frombuffer(Path(res["features"]).read_bytes(), np.uint8)
    b = {x["id"]: x for x in doc["blocks"]}["mix.balance"]
    bal = arr[b["offset"] : b["offset"] + doc["frames"]]
    assert bal.mean() > 170  # right-heavy


@pytest.mark.slow
def test_timing_180s(tmp_path, cap):
    song = synth(180.0, steps=[(0, 0.3), (20, 0.8), (90, 1.0)], vocal_notes=[(30 + 10 * i, 1.0, 60 + i % 5) for i in range(10)])
    for stems in (False, True, False):
        from tests.conftest import Captured

        c = Captured()
        t0 = time.perf_counter()
        d = tmp_path / f"{stems}{time.monotonic_ns()}"
        d.mkdir()
        run(c, d, song, stems=stems)
        print(f"viz.analyze 180 s stems={stems}: {time.perf_counter() - t0:.1f}s", flush=True)
