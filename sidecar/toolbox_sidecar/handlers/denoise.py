"""Denoise handlers: DeepFilterNet3 voice isolation (SPEC.md §6.2)."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import tarfile
from typing import Any

from .. import dfn3
from ..download import ensure_model, validate_model_spec
from ..registry import Context, HandlerError, handler

_SHA_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _str(params: dict[str, Any], key: str) -> str:
    v = params.get(key)
    if not isinstance(v, str) or not v.strip():
        raise HandlerError("validation", f"{key} is required")
    return v


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _files_spec(params: dict[str, Any]) -> dict[str, str]:
    files = params.get("files")
    if not isinstance(files, list) or not files:
        raise HandlerError("validation", "files is required")
    out: dict[str, str] = {}
    for f in files:
        name = f.get("name") if isinstance(f, dict) else None
        sha = f.get("sha256") if isinstance(f, dict) else None
        if not isinstance(name, str) or os.path.basename(name) != name or not name.endswith(".onnx"):
            raise HandlerError("validation", "files[].name must be a plain .onnx file name")
        if not isinstance(sha, str) or not _SHA_RE.match(sha):
            raise HandlerError("validation", "files[].sha256 must be 64 hex characters")
        out[name] = sha.lower()
    return out


@handler("denoise.dfn3")
def dfn3_run(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    src = _str(params, "path")
    dst = _str(params, "out")
    model_dir = _str(params, "modelDir")
    if not os.path.isfile(src):
        raise HandlerError("validation", "The input audio doesn't exist")
    missing = [k for k in dfn3.MODEL_FILES if not os.path.isfile(os.path.join(model_dir, f"{k}.onnx"))]
    if missing:
        raise HandlerError("validation", "The voice isolation model isn't downloaded", "Install it from Tool packs")
    ctx.stage("Isolating voice")
    try:
        info = dfn3.enhance_file(src, dst, model_dir, progress=ctx.progress, check_cancelled=ctx.check_cancelled)
    except HandlerError:
        raise
    except ValueError as e:
        raise HandlerError("validation", str(e)) from e
    except Exception as e:
        raise HandlerError("tool_failed", f"Voice isolation failed: {e}") from e
    return {"out": dst, **info}


@handler("denoise.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    """Downloads the DeepFilterNet3 tarball (sha-verified) and keeps only the three .onnx files."""
    model_dir = _str(params, "modelDir")
    spec = validate_model_spec(params.get("model"))
    wanted = _files_spec(params)

    def complete() -> bool:
        return all(
            os.path.isfile(os.path.join(model_dir, n)) and _sha256(os.path.join(model_dir, n)) == s
            for n, s in wanted.items()
        )

    if complete():
        return {"modelDir": model_dir, "files": sorted(wanted)}
    os.makedirs(model_dir, exist_ok=True)
    stage = os.path.join(model_dir, ".download")
    shutil.rmtree(stage, ignore_errors=True)
    try:
        tar_path = ensure_model(ctx, stage, spec["file"], spec["sha256"], spec["url"])
        ctx.stage("Unpacking model")
        extracted = os.path.join(stage, "x")
        os.makedirs(extracted)
        found: dict[str, str] = {}
        try:
            with tarfile.open(tar_path, "r:*") as tar:
                for member in tar.getmembers():
                    name = os.path.basename(member.name)
                    if member.isfile() and name in wanted and name not in found:
                        tar.extract(member, path=extracted, filter="data")
                        found[name] = os.path.join(extracted, member.name)
        except (tarfile.TarError, OSError) as e:
            raise HandlerError("tool_failed", f"Couldn't unpack the model: {e}") from e
        for name, sha in wanted.items():
            ctx.check_cancelled()
            path = found.get(name)
            if path is None or _sha256(path) != sha:
                raise HandlerError("tool_failed", f"The downloaded model is corrupted ({name}) — try again")
        for name in wanted:
            os.replace(found[name], os.path.join(model_dir, name))
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    ctx.progress(1.0, "Model ready", force=True)
    return {"modelDir": model_dir, "files": sorted(wanted)}
