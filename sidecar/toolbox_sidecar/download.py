"""Pinned, sha256-verified model downloads shared by the image handlers."""

from __future__ import annotations

import hashlib
import os
import re
import urllib.request
from typing import Any

from .registry import Context, HandlerError

_SHA_RE = re.compile(r"^[0-9a-fA-F]{64}$")
CHUNK = 1 << 20


def validate_model_spec(model: Any, kinds: tuple[str, ...] | None = None) -> dict[str, str]:
    """Checks a {file, sha256, url[, kind]} table entry from Go."""
    if not isinstance(model, dict):
        raise HandlerError("validation", "model is required")
    out: dict[str, str] = {}
    for key in ("file", "sha256", "url"):
        v = model.get(key)
        if not isinstance(v, str) or not v.strip():
            raise HandlerError("validation", f"model.{key} is required")
        out[key] = v
    if os.path.basename(out["file"]) != out["file"] or out["file"] in (".", ".."):
        raise HandlerError("validation", "model.file must be a plain file name")
    if not _SHA_RE.match(out["sha256"]):
        raise HandlerError("validation", "model.sha256 must be 64 hex characters")
    if kinds is not None:
        kind = model.get("kind")
        if kind not in kinds:
            raise HandlerError("validation", f"model.kind must be one of {', '.join(kinds)}")
        out["kind"] = kind
    return out


def ensure_model(ctx: Context, model_dir: str, file: str, sha256: str, url: str) -> str:
    """Returns <model_dir>/<file>, downloading it first when missing.

    Streams to <file>.part reporting progress, verifies the pinned sha256
    (deleting the file and failing on mismatch), then renames into place.
    Cancellable between chunks.
    """
    final = os.path.join(model_dir, file)
    if os.path.isfile(final):
        return final
    os.makedirs(model_dir, exist_ok=True)
    part = final + ".part"
    ctx.stage("Downloading model")
    h = hashlib.sha256()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "toolbox-ai-engine"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while True:
                ctx.check_cancelled()
                chunk = resp.read(CHUNK)
                if not chunk:
                    break
                out.write(chunk)
                h.update(chunk)
                done += len(chunk)
                ctx.progress(done / total if total else -1, "Downloading model")
        ctx.check_cancelled()
        if h.hexdigest().lower() != sha256.lower():
            raise HandlerError("tool_failed", "Model download was corrupted — try again")
        os.replace(part, final)
    except HandlerError:
        _remove(part)
        raise
    except Exception as e:
        _remove(part)
        raise HandlerError("tool_failed", f"Model download failed: {e}", "Check your connection and try again") from e
    ctx.progress(1.0, "Downloading model", force=True)
    return final


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
