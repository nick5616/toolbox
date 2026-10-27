import pytest

from toolbox_sidecar.handlers.analysis import analysis_bpm_key, camelot
from toolbox_sidecar.registry import HandlerError


def test_cmajor_120(cap, cmaj_120):
    r = analysis_bpm_key(cap.ctx, {"input": cmaj_120})
    assert abs(r["bpm"] - 120) <= 3
    assert r["key"] == "C major"
    assert r["camelot"] == "8B"
    assert r["confidence"] > 0.8
    assert len(r["alternatives"]) == 3
    assert 120 in [round(c) for c in r["bpmCandidates"]] or any(abs(c - 120) <= 3 for c in r["bpmCandidates"])
    assert r["truncated"] is False
    assert 15 < r["durationSec"] < 18
    assert cap.events("progress")


def test_aminor_100(cap, amin_100):
    r = analysis_bpm_key(cap.ctx, {"input": amin_100})
    assert abs(r["bpm"] - 100) <= 3
    assert r["key"] == "A minor"
    assert r["camelot"] == "8A"


def test_silence(cap, silence):
    with pytest.raises(HandlerError) as ei:
        analysis_bpm_key(cap.ctx, {"input": silence})
    assert ei.value.code == "validation"
    assert "too short or silent" in ei.value.message


@pytest.mark.parametrize("params", [{}, {"input": ""}, {"input": 3}, {"input": "/no/such/file.wav"}])
def test_bad_params(cap, params):
    with pytest.raises(HandlerError) as ei:
        analysis_bpm_key(cap.ctx, params)
    assert ei.value.code == "validation"


def test_missing_file_message(cap, tmp_path):
    with pytest.raises(HandlerError) as ei:
        analysis_bpm_key(cap.ctx, {"input": str(tmp_path / "x.wav")})
    assert ei.value.message == "Input file not found"


@pytest.mark.parametrize(
    "pc,minor,want",
    [(0, False, "8B"), (9, True, "8A"), (7, False, "9B"), (4, True, "9A"),
     (2, False, "10B"), (11, False, "1B"), (6, False, "2B"), (5, False, "7B"),
     (6, True, "11A"), (0, True, "5A"), (2, True, "7A")],
)
def test_camelot(pc, minor, want):
    assert camelot(pc, minor) == want
