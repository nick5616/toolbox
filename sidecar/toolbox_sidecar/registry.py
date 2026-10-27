"""Handler registry and the per-request Context handlers receive.

Handlers are plain functions ``fn(ctx: Context, params: dict) -> dict``
registered with ``@handler("namespace.name")``. They must:
  * validate params and raise ``HandlerError("validation", ...)``;
  * never print to stdout (print() is redirected to stderr by the server);
  * call ``ctx.check_cancelled()`` between expensive stages;
  * return a JSON-serialisable dict (the server adds ``rssBytes``).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from .protocol import Writer

Handler = Callable[["Context", dict[str, Any]], dict[str, Any]]

#: method name → handler function
HANDLERS: dict[str, Handler] = {}

#: Minimum seconds between progress events for one request.
PROGRESS_INTERVAL = 0.1


class HandlerError(Exception):
    """An error reported to Go as {"error": {code, message, hint}}.

    code is one of: "validation", "tool_failed", "cancelled", "internal".
    """

    def __init__(self, code: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


class Cancelled(HandlerError):
    def __init__(self) -> None:
        super().__init__("cancelled", "Cancelled")


def handler(method: str) -> Callable[[Handler], Handler]:
    """Registers fn as the handler for method."""

    def deco(fn: Handler) -> Handler:
        if method in HANDLERS:
            raise RuntimeError(f"duplicate handler {method}")
        HANDLERS[method] = fn
        return fn

    return deco


_current = threading.local()


def current() -> "Context | None":
    """The Context of the request running on this thread (used by the tqdm shim)."""
    return getattr(_current, "ctx", None)


class Context:
    """Per-request handle for reporting progress, logs and outputs."""

    def __init__(self, rid: str, writer: Writer) -> None:
        self.id = rid
        self._writer = writer
        self._cancel = threading.Event()
        self._last_progress = 0.0
        self._stage = ""

    # -- lifecycle (used by the server) -------------------------------------
    def bind(self) -> None:
        _current.ctx = self

    def unbind(self) -> None:
        _current.ctx = None

    def request_cancel(self) -> None:
        self._cancel.set()

    # -- handler API ----------------------------------------------------------
    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise Cancelled()

    def stage(self, msg: str) -> None:
        """Sets the message used by tqdm-driven progress and reports it (indeterminate)."""
        self._stage = msg
        self.progress(-1, msg, force=True)

    def progress(self, pct: float, msg: str = "", *, force: bool = False) -> None:
        """Reports pct in [0, 1] or -1 (indeterminate). Throttled to PROGRESS_INTERVAL."""
        now = time.monotonic()
        if not force and now - self._last_progress < PROGRESS_INTERVAL:
            return
        self._last_progress = now
        if pct >= 0:
            pct = min(max(pct, 0.0), 1.0)
        self._writer.event(self.id, "progress", {"pct": pct, "msg": msg or self._stage})

    def log(self, line: str, level: str = "info") -> None:
        self._writer.event(self.id, "log", {"line": line, "level": level})

    def output(self, path: str) -> None:
        self._writer.event(self.id, "output", {"path": path})
