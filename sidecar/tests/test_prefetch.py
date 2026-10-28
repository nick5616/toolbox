"""stems/transcribe/bgremove .prefetch: validation and the download paths (mocked)."""

from __future__ import annotations

import hashlib
import os
import sys
import types

import pytest

from toolbox_sidecar.handlers import bgremove as bg
from toolbox_sidecar.handlers import stems
from toolbox_sidecar.handlers import transcribe as tr
from toolbox_sidecar.registry import HANDLERS, HandlerError


def test_registered():
    for name in ("stems.prefetch", "transcribe.prefetch", "bgremove.prefetch"):
        assert name in HANDLERS


# -- stems -------------------------------------------------------------------


@pytest.fixture
def models_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("TOOLBOX_MODELS_DIR", str(tmp_path / "models"))
    return tmp_path / "models"


@pytest.mark.parametrize("model", [None, "", 5, "../x.onnx", "a/b.yaml"])
def test_stems_prefetch_validates(cap, models_dir, model):
    with pytest.raises(HandlerError) as e:
        stems.stems_prefetch(cap.ctx, {"model": model})
    assert e.value.code == "validation"


def test_stems_prefetch_loads_model(cap, models_dir, monkeypatch):
    loaded = []

    class FakeSep:
        def load_model(self, model_filename):
            loaded.append(model_filename)

    monkeypatch.setattr(stems, "_new_separator", lambda fmt, out: FakeSep())
    assert stems.stems_prefetch(cap.ctx, {"model": "htdemucs.yaml"}) == {"model": "htdemucs.yaml"}
    assert loaded == ["htdemucs.yaml"]


def test_stems_prefetch_download_error(cap, models_dir, monkeypatch):
    class FakeSep:
        def load_model(self, model_filename):
            raise OSError("Connection refused while downloading")

    monkeypatch.setattr(stems, "_new_separator", lambda fmt, out: FakeSep())
    with pytest.raises(HandlerError) as e:
        stems.stems_prefetch(cap.ctx, {"model": "htdemucs.yaml"})
    assert "download failed" in e.value.message


# -- transcribe --------------------------------------------------------------


@pytest.mark.parametrize("params", [{}, {"model": "r/x"}, {"modelDir": "/x"}, {"model": "", "modelDir": "/x"}])
def test_transcribe_prefetch_validates(cap, params):
    with pytest.raises(HandlerError) as e:
        tr.prefetch(cap.ctx, params)
    assert e.value.code == "validation"


def test_transcribe_prefetch_downloads_once(cap, tmp_path, monkeypatch):
    calls = []

    def fake_snapshot(repo, local_dir):
        calls.append((repo, local_dir))
        (tmp_path / "w").mkdir(exist_ok=True)
        (tmp_path / "w" / "model.bin").write_bytes(b"x")
        (tmp_path / "w" / "config.json").write_text("{}")

    hub = types.ModuleType("huggingface_hub")
    hub.snapshot_download = fake_snapshot
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    params = {"model": "Systran/faster-whisper-small", "modelDir": str(tmp_path / "w")}
    assert tr.prefetch(cap.ctx, params)["downloaded"] is True
    assert calls == [("Systran/faster-whisper-small", str(tmp_path / "w"))]
    assert tr.prefetch(cap.ctx, params)["downloaded"] is False  # already there
    assert len(calls) == 1


def test_transcribe_prefetch_incomplete(cap, tmp_path, monkeypatch):
    hub = types.ModuleType("huggingface_hub")
    hub.snapshot_download = lambda repo, local_dir: None
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    with pytest.raises(HandlerError):
        tr.prefetch(cap.ctx, {"model": "r/x", "modelDir": str(tmp_path / "w")})


# -- bgremove ----------------------------------------------------------------


def test_bgremove_prefetch_validates(cap, tmp_path):
    spec = {"file": "m.onnx", "sha256": "0" * 64, "url": "https://x/m", "kind": "isnet"}
    for params in ({}, {"modelDir": str(tmp_path)}, {"modelDir": str(tmp_path), "model": {**spec, "kind": "bad"}}):
        with pytest.raises(HandlerError) as e:
            bg.prefetch(cap.ctx, params)
        assert e.value.code == "validation"


def test_bgremove_prefetch_uses_verified_download(cap, tmp_path, monkeypatch):
    sha = hashlib.sha256(b"onnx-bytes").hexdigest()
    seen = []

    def fake_ensure(ctx, model_dir, file, sha256, url):
        seen.append((model_dir, file, sha256, url))
        return os.path.join(model_dir, file)

    monkeypatch.setattr(bg, "ensure_model", fake_ensure)
    spec = {"file": "m.onnx", "sha256": sha, "url": "https://x/m.onnx", "kind": "isnet"}
    out = bg.prefetch(cap.ctx, {"modelDir": str(tmp_path / "bg"), "model": spec})
    assert seen == [(str(tmp_path / "bg"), "m.onnx", sha, "https://x/m.onnx")]
    assert out["model"] == "m.onnx"
