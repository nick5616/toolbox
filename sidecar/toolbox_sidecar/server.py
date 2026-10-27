"""Dispatch loop (SPEC.md §4.4–4.5).

Test hook: if env ``TOOLBOX_SIDECAR_EXTRA_HANDLERS`` names a module (comma
separated), it is imported after the real handlers so tests can register extras.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, wait

from . import __version__, progress
from .protocol import (
    CANCEL,
    MAX_LINE_BYTES,
    SHUTDOWN,
    ProtocolError,
    Request,
    Writer,
    parse_request,
)
from .registry import HANDLERS, Context, HandlerError


def _selftest(real_stdout) -> int:
    import platform
    import warnings

    progress.install()
    try:
        warnings.simplefilter("ignore")
        for name in ("tensorflow", "coremltools", "basic_pitch"):
            logging.getLogger(name).addFilter(lambda r: False)
        import audio_separator  # noqa: F401
        import basic_pitch  # noqa: F401
        import librosa  # noqa: F401
        import onnxruntime  # noqa: F401
        import torch  # noqa: F401
    except Exception as e:
        print(f"selftest failed: {e!r}", file=sys.stderr)
        return 1
    from .handlers.system import package_versions

    real_stdout.write(
        json.dumps({"python": platform.python_version(), "packages": package_versions()}) + "\n"
    )
    real_stdout.flush()
    return 0


class _Server:
    def __init__(self, writer: Writer) -> None:
        self.writer = writer
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="req")
        self.inflight: dict[str, Context] = {}
        self.futures: list = []
        self.lock = threading.Lock()

    def submit(self, req: Request) -> None:
        fn = HANDLERS.get(req.method)
        if fn is None:
            self.writer.error(req.id, "validation", f"Unknown method {req.method}")
            return
        ctx = Context(req.id, self.writer)
        with self.lock:
            if req.id in self.inflight:
                self.writer.error(req.id, "validation", f"Duplicate request id {req.id}")
                return
            self.inflight[req.id] = ctx
        self.futures.append(self.pool.submit(self._run, req, ctx, fn))

    def cancel(self, rid: str) -> None:
        with self.lock:
            ctx = self.inflight.get(rid)
        if ctx is not None:
            ctx.request_cancel()

    def _run(self, req: Request, ctx: Context, fn) -> None:
        try:
            if ctx.cancelled:
                self.writer.error(req.id, "cancelled", "Cancelled")
                return
            ctx.bind()
            try:
                result = fn(ctx, req.params)
            finally:
                ctx.unbind()
            result = dict(result or {})
            result["rssBytes"] = _rss()
            self.writer.result(req.id, result)
        except HandlerError as e:
            self.writer.error(req.id, e.code, e.message, e.hint)
        except BaseException as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            self.writer.error(req.id, "internal", str(e) or e.__class__.__name__)
        finally:
            with self.lock:
                self.inflight.pop(req.id, None)

    def shutdown(self) -> None:
        with self.lock:
            for ctx in self.inflight.values():
                ctx.request_cancel()
        wait([f for f in self.futures if not f.done()], timeout=2.0)
        self.pool.shutdown(wait=False, cancel_futures=True)


def _rss() -> int:
    try:
        import psutil

        return int(psutil.Process().memory_info().rss)
    except Exception:
        return 0


def _recover_id(line: str) -> str | None:
    try:
        obj = json.loads(line)
        if isinstance(obj, dict) and isinstance(obj.get("id"), str) and obj["id"]:
            return obj["id"]
    except Exception:
        pass
    return None


def main(argv: list[str] | None = None) -> int:
    """Runs the sidecar (or --selftest). Returns the process exit code."""
    argv = sys.argv[1:] if argv is None else argv
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if os.environ.get("TOOLBOX_SIDECAR_LOG", "").lower() == "debug" else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if "--selftest" in argv:
        return _selftest(real_stdout)

    writer = Writer(real_stdout)
    progress.install()
    from . import handlers  # noqa: F401  (registers handlers)

    for mod in filter(None, os.environ.get("TOOLBOX_SIDECAR_EXTRA_HANDLERS", "").split(",")):
        importlib.import_module(mod.strip())

    from .handlers.system import python_version

    writer.ready({"version": __version__, "python": python_version(), "pid": os.getpid()})
    server = _Server(writer)

    stdin = sys.stdin.buffer
    while True:
        raw = stdin.readline(MAX_LINE_BYTES + 2)
        if not raw:
            break  # EOF
        if len(raw) > MAX_LINE_BYTES and not raw.endswith(b"\n"):
            # oversize line: drain the rest, then drop
            while raw and not raw.endswith(b"\n"):
                raw = stdin.readline(MAX_LINE_BYTES)
            print("sidecar: dropped oversized request line", file=sys.stderr)
            continue
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        if len(raw) > MAX_LINE_BYTES + 1:
            rid = _recover_id(line)
            print("sidecar: request line too long", file=sys.stderr)
            if rid:
                writer.error(rid, "validation", "Request too large")
            continue
        try:
            req = parse_request(line)
        except ProtocolError as e:
            print(f"sidecar: bad request: {e}", file=sys.stderr)
            rid = _recover_id(line)
            if rid:
                writer.error(rid, "validation", str(e))
            continue
        if req.method == SHUTDOWN:
            break
        if req.method == CANCEL:
            server.cancel(req.id)
            continue
        server.submit(req)

    server.shutdown()
    return 0
