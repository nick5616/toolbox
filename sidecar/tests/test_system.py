import io

from toolbox_sidecar import handlers  # noqa: F401
from toolbox_sidecar.protocol import Writer
from toolbox_sidecar.registry import HANDLERS, Context

KEYS = {"toolbox-sidecar", "torch", "audio_separator", "librosa", "onnxruntime", "basic_pitch", "faster_whisper", "ctranslate2"}


def ctx():
    return Context("t", Writer(io.StringIO()))


def test_ping():
    assert HANDLERS["system.ping"](ctx(), {}) == {}


def test_info():
    r = HANDLERS["system.info"](ctx(), {})
    assert r["python"].startswith("3.12")
    assert set(r["packages"]) == KEYS
    assert all(v and v != "unknown" for v in r["packages"].values())
    assert r["device"] in {"cpu", "mps", "coreml"}


def test_warmup():
    assert HANDLERS["system.warmup"](ctx(), {}) == {}
