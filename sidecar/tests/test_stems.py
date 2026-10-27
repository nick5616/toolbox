import os

import pytest

from toolbox_sidecar.handlers import stems
from toolbox_sidecar.registry import HandlerError


@pytest.fixture
def models_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("TOOLBOX_MODELS_DIR", str(tmp_path / "models"))
    monkeypatch.setitem(stems._state, "key", None)
    monkeypatch.setitem(stems._state, "sep", None)
    return tmp_path / "models"


@pytest.mark.parametrize(
    "extra",
    [{"input": ""}, {"input": "/no/such.wav"}, {"outputDir": ""}, {"model": ""},
     {"outputFormat": "ogg"}, {"baseName": 5}],
)
def test_validation(cap, cmaj_120, tmp_path, models_dir, extra):
    p = {"input": cmaj_120, "outputDir": str(tmp_path / "o"), "model": "htdemucs.yaml",
         "outputFormat": "wav", "baseName": "Song", **extra}
    with pytest.raises(HandlerError) as ei:
        stems.stems_separate(cap.ctx, p)
    assert ei.value.code == "validation"


def test_unknown_model_fails_cleanly(cap, cmaj_120, tmp_path, models_dir, monkeypatch):
    class FakeSep:
        def load_model(self, model_filename):
            raise ValueError(f"Model file {model_filename} not found in supported model list")

    monkeypatch.setattr(stems, "_new_separator", lambda fmt, out: FakeSep())
    with pytest.raises(HandlerError) as ei:
        stems.stems_separate(cap.ctx, {"input": cmaj_120, "outputDir": str(tmp_path / "o"), "model": "nope.onnx"})
    assert ei.value.code == "tool_failed"
    assert "nope.onnx" in ei.value.message


def test_download_error_hint(cap, cmaj_120, tmp_path, models_dir, monkeypatch):
    class FakeSep:
        def load_model(self, model_filename):
            raise ConnectionError("Failed to download")

    monkeypatch.setattr(stems, "_new_separator", lambda fmt, out: FakeSep())
    with pytest.raises(HandlerError) as ei:
        stems.stems_separate(cap.ctx, {"input": cmaj_120, "outputDir": str(tmp_path / "o"), "model": "m.onnx"})
    assert ei.value.code == "tool_failed"
    assert ei.value.hint == "Check your connection"


def test_maps_names(cap, cmaj_120, tmp_path, models_dir, monkeypatch):
    out = tmp_path / "o"

    class FakeSep:
        def load_model(self, model_filename):
            pass

        def separate(self, path, custom_output_names=None):
            names = []
            for stem in ("Vocals", "Instrumental"):
                n = custom_output_names[stem.lower()] + ".wav"
                (out / n).write_bytes(b"x")
                names.append(n)
            return names

    monkeypatch.setattr(stems, "_new_separator", lambda fmt, o: FakeSep())
    r = stems.stems_separate(cap.ctx, {"input": cmaj_120, "outputDir": str(out), "model": "m.onnx", "baseName": "Song"})
    assert [s["name"] for s in r["stems"]] == ["Vocals", "Instrumental"]
    assert r["stems"][0]["path"] == str(out / "Song - Vocals.wav")
    assert len(cap.events("output")) == 2


@pytest.mark.slow
@pytest.mark.parametrize(
    "model,names",
    [("htdemucs.yaml", ["Vocals", "Drums", "Bass", "Other"]),
     ("UVR-MDX-NET-Inst_HQ_3.onnx", ["Vocals", "Instrumental"])],
)
def test_real_separation(cap, cmaj_120, tmp_path, model, names):
    out = tmp_path / "out"
    r = stems.stems_separate(
        cap.ctx,
        {"input": cmaj_120, "outputDir": str(out), "model": model, "outputFormat": "wav", "baseName": "Song"},
    )
    assert r["model"] == model
    assert sorted(s["name"] for s in r["stems"]) == sorted(names)
    for n in names:
        assert os.path.isfile(out / f"Song - {n}.wav")
    assert sorted(os.listdir(out)) == sorted(f"Song - {n}.wav" for n in names)
    stages = [e["msg"] for e in cap.events("progress")]
    assert "Separating" in stages
