"""denoise.dfn3 / denoise.prefetch: chunking and crossfade maths, multichannel,
cancellation, prefetch extraction (stubbed model), and the slow real-model test."""

from __future__ import annotations

import hashlib
import io
import os
import tarfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from toolbox_sidecar import dfn3
from toolbox_sidecar.handlers import denoise
from toolbox_sidecar.registry import HANDLERS, Cancelled, HandlerError

SR = dfn3.SR


def _db(err: np.ndarray, ref: np.ndarray) -> float:
    return 10 * np.log10((np.sum(err**2) + 1e-20) / (np.sum(ref**2) + 1e-20))


def test_registered():
    assert "denoise.dfn3" in HANDLERS and "denoise.prefetch" in HANDLERS


@pytest.mark.parametrize(
    "length,chunk,fade",
    [(10, 100, 5), (100, 100, 5), (101, 100, 5), (250, 100, 10), (195, 100, 10), (192, 100, 10), (5000, 300, 20)],
)
def test_chunk_spans_cover_and_overlap(length, chunk, fade):
    spans = dfn3.chunk_spans(length, chunk, fade)
    assert spans[0][0] == 0 and spans[-1][1] == length
    for (a0, b0), (a1, b1) in zip(spans, spans[1:]):
        assert b0 - a1 == fade  # exact overlap
        assert b1 - a1 > fade
    assert all(b - a <= chunk + fade for a, b in spans)


@pytest.mark.parametrize("length", [1000, 4800, 150_000, 480_001])
def test_unity_model_reproduces_input(length):
    rng = np.random.default_rng(1)
    x = rng.standard_normal(length).astype(np.float32) * 0.3
    calls = []
    y = dfn3.process_channel(x, lambda c: (calls.append(len(c)), c)[1], chunk=48000, fade=4800)
    assert len(y) == length
    assert _db(y - x, x) < -60
    if length > 48000:
        assert len(calls) > 1


def test_process_channel_hooks_each_chunk():
    n = []
    dfn3.process_channel(np.zeros(10_000, np.float32), lambda c: c, chunk=3000, fade=500, on_chunk=lambda: n.append(1))
    assert len(n) == len(dfn3.chunk_spans(10_000, 3000, 500))


def _write_wav(path: Path, data: np.ndarray, sr: int = SR) -> str:
    sf.write(str(path), data, sr, subtype="FLOAT")
    return str(path)


def test_enhance_file_multichannel(tmp_path, monkeypatch):
    monkeypatch.setattr(dfn3, "enhance", lambda x, s: x * 0.5)
    monkeypatch.setattr(dfn3, "CHUNK_SECONDS", 2)
    rng = np.random.default_rng(2)
    x = (rng.standard_normal((SR * 5, 2)) * 0.2).astype(np.float32)
    src = _write_wav(tmp_path / "in.wav", x)
    dst = str(tmp_path / "out.wav")
    seen = []
    info = dfn3.enhance_file(src, dst, "unused", progress=lambda p, m: seen.append(p), sessions=object())
    y, sr = sf.read(dst, dtype="float32", always_2d=True)
    assert sr == SR and y.shape == x.shape
    assert _db(y - x * 0.5, x * 0.5) < -60
    assert info["channels"] == 2
    assert seen[0] == 0.0 and seen[-1] == 1.0 and seen == sorted(seen)


def test_enhance_file_rejects_wrong_rate(tmp_path):
    src = _write_wav(tmp_path / "in.wav", np.zeros((1000, 1), np.float32), 16000)
    with pytest.raises(ValueError):
        dfn3.enhance_file(src, str(tmp_path / "o.wav"), "x", sessions=object())


def test_enhance_file_cancels_between_chunks(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(dfn3, "enhance", lambda x, s: (calls.append(1), x)[1])
    monkeypatch.setattr(dfn3, "CHUNK_SECONDS", 1)
    src = _write_wav(tmp_path / "in.wav", np.zeros((SR * 4, 1), np.float32))
    dst = str(tmp_path / "out.wav")

    def check():
        if len(calls) >= 2:
            raise Cancelled()

    with pytest.raises(Cancelled):
        dfn3.enhance_file(src, dst, "x", check_cancelled=check, sessions=object())
    assert len(calls) == 2
    assert not os.path.exists(dst)


def test_dfn3_handler_validates(cap, tmp_path):
    with pytest.raises(HandlerError) as e:
        denoise.dfn3_run(cap.ctx, {"path": "", "out": "x", "modelDir": str(tmp_path)})
    assert e.value.code == "validation"
    src = _write_wav(tmp_path / "in.wav", np.zeros((100, 1), np.float32))
    with pytest.raises(HandlerError) as e:
        denoise.dfn3_run(cap.ctx, {"path": src, "out": str(tmp_path / "o.wav"), "modelDir": str(tmp_path)})
    assert e.value.code == "validation" and "model" in e.value.message


# -- prefetch ----------------------------------------------------------------


def _make_tar(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    contents = {n: (n * 40).encode() for n in ("enc.onnx", "erb_dec.onnx", "df_dec.onnx")}
    tar_path = tmp_path / "src" / "DeepFilterNet3_onnx.tar.gz"
    tar_path.parent.mkdir()
    with tarfile.open(tar_path, "w:gz") as tar:
        for n, data in contents.items():
            ti = tarfile.TarInfo(f"tmp/export/{n}")
            ti.size = len(data)
            tar.addfile(ti, io.BytesIO(data))
        extra = b"[df]"
        ti = tarfile.TarInfo("tmp/export/config.ini")
        ti.size = len(extra)
        tar.addfile(ti, io.BytesIO(extra))
        evil = tarfile.TarInfo("../evil.onnx")
        evil.size = 1
        tar.addfile(evil, io.BytesIO(b"x"))
    shas = {n: hashlib.sha256(d).hexdigest() for n, d in contents.items()}
    return tar_path, shas


def _params(tar_path: Path, shas: dict[str, str], model_dir: Path) -> dict:
    return {
        "model": {
            "file": tar_path.name,
            "url": "https://example.invalid/x.tar.gz",
            "sha256": hashlib.sha256(tar_path.read_bytes()).hexdigest(),
        },
        "files": [{"name": n, "sha256": s} for n, s in shas.items()],
        "modelDir": str(model_dir),
    }


def test_prefetch_extracts_only_the_onnx_files(cap, tmp_path, monkeypatch):
    tar_path, shas = _make_tar(tmp_path)
    downloads = []

    def fake_ensure(ctx, model_dir, file, sha, url):
        downloads.append(url)
        os.makedirs(model_dir, exist_ok=True)
        dst = os.path.join(model_dir, file)
        Path(dst).write_bytes(tar_path.read_bytes())
        return dst

    monkeypatch.setattr(denoise, "ensure_model", fake_ensure)
    model_dir = tmp_path / "models" / "denoise" / "dfn3"
    out = denoise.prefetch(cap.ctx, _params(tar_path, shas, model_dir))
    assert sorted(os.listdir(model_dir)) == ["df_dec.onnx", "enc.onnx", "erb_dec.onnx"]
    assert out["files"] == ["df_dec.onnx", "enc.onnx", "erb_dec.onnx"]
    assert not (tmp_path / "models" / "denoise" / "evil.onnx").exists()
    # second call: already complete, no download
    denoise.prefetch(cap.ctx, _params(tar_path, shas, model_dir))
    assert len(downloads) == 1


def test_prefetch_rejects_wrong_file_hash(cap, tmp_path, monkeypatch):
    tar_path, shas = _make_tar(tmp_path)
    shas["enc.onnx"] = "0" * 64
    monkeypatch.setattr(
        denoise, "ensure_model", lambda ctx, d, f, s, u: (os.makedirs(d, exist_ok=True), Path(d, f).write_bytes(tar_path.read_bytes()), os.path.join(d, f))[2]
    )
    model_dir = tmp_path / "m"
    with pytest.raises(HandlerError) as e:
        denoise.prefetch(cap.ctx, _params(tar_path, shas, model_dir))
    assert e.value.code == "tool_failed"
    assert not (model_dir / "enc.onnx").exists()
    assert not (model_dir / ".download").exists()


@pytest.mark.parametrize("mutate", [lambda p: p.pop("files"), lambda p: p.pop("modelDir"), lambda p: p["files"][0].update(name="../x.onnx")])
def test_prefetch_validates(cap, tmp_path, mutate):
    tar_path, shas = _make_tar(tmp_path)
    p = _params(tar_path, shas, tmp_path / "m")
    mutate(p)
    with pytest.raises(HandlerError) as e:
        denoise.prefetch(cap.ctx, p)
    assert e.value.code == "validation"


# -- slow: the real model ----------------------------------------------------

SAMPLE = Path(r"C:\Users\nickb\repos\toolbox\.dev\p6-research\samples\schumer_pd.ogg")
MODELS = Path(r"C:\Users\nickb\repos\toolbox\.dev\p6-research\dfn3\x\tmp\export")


def _si_sdr(ref: np.ndarray, est: np.ndarray) -> float:
    ref = ref - ref.mean()
    est = est - est.mean()
    alpha = np.dot(est, ref) / (np.dot(ref, ref) + 1e-12)
    target = alpha * ref
    return 10 * np.log10(np.sum(target**2) / (np.sum((est - target) ** 2) + 1e-12))


@pytest.mark.slow
@pytest.mark.skipif(not (SAMPLE.exists() and (MODELS / "enc.onnx").exists()), reason="research samples missing")
def test_real_model_improves_si_sdr(cap, tmp_path):
    import soundfile as sf2
    from scipy.signal import resample_poly  # numpy-only fallback below if absent

    speech, sr = sf2.read(str(SAMPLE), dtype="float32", always_2d=True)
    speech = speech.mean(axis=1)[: sr * 12]
    if sr != SR:
        speech = resample_poly(speech, SR, sr).astype(np.float32)
    rng = np.random.default_rng(3)
    white = rng.standard_normal(len(speech))
    spec = np.fft.rfft(white)
    spec /= np.sqrt(np.maximum(np.arange(len(spec)), 1))  # pink
    noise = np.fft.irfft(spec, n=len(speech))
    noise *= np.sqrt(np.mean(speech**2) / np.mean(noise**2)) / (10 ** (5 / 20))  # SNR 5 dB
    noisy = (speech + noise).astype(np.float32)
    src = _write_wav(tmp_path / "noisy.wav", noisy)
    dst = str(tmp_path / "clean.wav")
    res = denoise.dfn3_run(cap.ctx, {"path": src, "out": dst, "modelDir": str(MODELS)})
    clean, _ = sf.read(dst, dtype="float32")
    assert res["chunks"] >= 1
    assert _si_sdr(speech, clean) - _si_sdr(speech, noisy) >= 4
