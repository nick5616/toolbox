"""Wire protocol: one JSON object per line on stdin (requests) and stdout
(events, results, errors). See sidecar/README.md and SPEC.md §4.4.

stdout is reserved for protocol messages; everything else goes to stderr.
"""

from __future__ import annotations

import json
import sys
import threading
from dataclasses import dataclass
from typing import Any, TextIO

#: Lines longer than this are rejected (both directions).
MAX_LINE_BYTES = 16 * 1024 * 1024

CANCEL = "$cancel"
SHUTDOWN = "$shutdown"


@dataclass(frozen=True)
class Request:
    id: str
    method: str
    params: dict[str, Any]


class ProtocolError(Exception):
    """A malformed incoming line."""


def parse_request(line: str) -> Request:
    """Parses one stdin line into a Request. Raises ProtocolError."""
    if len(line.encode("utf-8", "replace")) > MAX_LINE_BYTES:
        raise ProtocolError("line too long")
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as e:
        raise ProtocolError(f"invalid JSON: {e}") from e
    if not isinstance(obj, dict):
        raise ProtocolError("message must be an object")
    rid = obj.get("id", "")
    method = obj.get("method")
    params = obj.get("params") or {}
    if not isinstance(rid, str) or not isinstance(method, str) or not method:
        raise ProtocolError("id must be a string and method a non-empty string")
    if not isinstance(params, dict):
        raise ProtocolError("params must be an object")
    return Request(id=rid, method=method, params=params)


class Writer:
    """Thread-safe JSON Lines writer for stdout."""

    def __init__(self, out: TextIO | None = None) -> None:
        self._out = out if out is not None else sys.stdout
        self._lock = threading.Lock()

    def _send(self, obj: dict[str, Any]) -> None:
        line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)
        with self._lock:
            self._out.write(line + "\n")
            self._out.flush()

    def ready(self, data: dict[str, Any]) -> None:
        self._send({"id": "", "event": "ready", "data": data})

    def event(self, rid: str, kind: str, data: dict[str, Any]) -> None:
        self._send({"id": rid, "event": kind, "data": data})

    def result(self, rid: str, result: dict[str, Any]) -> None:
        self._send({"id": rid, "result": result})

    def error(self, rid: str, code: str, message: str, hint: str = "") -> None:
        err: dict[str, Any] = {"code": code, "message": message}
        if hint:
            err["hint"] = hint
        self._send({"id": rid, "error": err})
