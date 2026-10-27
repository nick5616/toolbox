import pretty_midi
import pytest

from toolbox_sidecar.handlers.midi import midi_transcribe
from toolbox_sidecar.registry import HandlerError


def test_triad(cap, c_triad, tmp_path):
    out = str(tmp_path / "sub" / "triad.mid")
    r = midi_transcribe(cap.ctx, {"input": c_triad, "outputPath": out})
    assert r["outputPath"] == out
    assert r["notes"] >= 3
    pm = pretty_midi.PrettyMIDI(out)
    pitches = {n.pitch for i in pm.instruments for n in i.notes}
    assert {60, 64, 67} <= pitches
    assert r["pitchRange"][0] <= 60 and r["pitchRange"][1] >= 67
    assert 3.5 < r["durationSec"] < 4.5
    assert cap.events("output") == [{"path": out}]


def test_output_exists(cap, c_triad, tmp_path):
    out = tmp_path / "x.mid"
    out.write_bytes(b"x")
    with pytest.raises(HandlerError) as ei:
        midi_transcribe(cap.ctx, {"input": c_triad, "outputPath": str(out)})
    assert ei.value.code == "validation" and ei.value.message == "Output exists"
    assert out.read_bytes() == b"x"


@pytest.mark.parametrize(
    "extra",
    [{"onsetThreshold": 0.01}, {"onsetThreshold": 0.99}, {"frameThreshold": 2},
     {"minNoteMs": 5}, {"minNoteMs": 5000}, {"onsetThreshold": "a"},
     {"minHz": 500, "maxHz": 100}, {"melodiaTrick": "yes"}],
)
def test_bad_params(cap, c_triad, tmp_path, extra):
    with pytest.raises(HandlerError) as ei:
        midi_transcribe(cap.ctx, {"input": c_triad, "outputPath": str(tmp_path / "o.mid"), **extra})
    assert ei.value.code == "validation"


def test_missing_input(cap, tmp_path):
    with pytest.raises(HandlerError) as ei:
        midi_transcribe(cap.ctx, {"input": str(tmp_path / "no.wav"), "outputPath": str(tmp_path / "o.mid")})
    assert ei.value.message == "Input file not found"
