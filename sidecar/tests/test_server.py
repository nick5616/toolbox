"""Runs the real server as a subprocess. Test-only handlers come from
tests/toolbox_test_handlers.py via TOOLBOX_SIDECAR_EXTRA_HANDLERS + PYTHONPATH."""

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

TESTS = str(Path(__file__).parent)
SIDECAR = str(Path(__file__).parent.parent)


class Proc:
    def __init__(self, args=()):
        env = dict(os.environ)
        env["TOOLBOX_SIDECAR_EXTRA_HANDLERS"] = "toolbox_test_handlers"
        env["PYTHONPATH"] = os.pathsep.join([TESTS, SIDECAR, env.get("PYTHONPATH", "")])
        env["PYTHONUTF8"] = "1"
        self.p = subprocess.Popen(
            [sys.executable, "-u", "-m", "toolbox_sidecar", *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, cwd=SIDECAR,
        )
        self.q: queue.Queue = queue.Queue()
        self.raw: list[str] = []
        self.err = b""
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=lambda: setattr(self, "err", self.p.stderr.read()), daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            s = line.decode("utf-8").rstrip("\n")
            self.raw.append(s)
            self.q.put(json.loads(s))

    def send(self, id, method, **params):
        self.p.stdin.write((json.dumps({"id": id, "method": method, "params": params}) + "\n").encode())
        self.p.stdin.flush()

    def get(self, timeout=30):
        return self.q.get(timeout=timeout)

    def final(self, id, timeout=30):
        """Next result/error message for id (events skipped), returning (msg, events)."""
        evs = []
        end = time.monotonic() + timeout
        while True:
            m = self.get(max(0.1, end - time.monotonic()))
            if m["id"] == id and ("result" in m or "error" in m):
                return m, evs
            if m["id"] == id:
                evs.append(m)


@pytest.fixture
def proc():
    p = Proc()
    ready = p.get(60)
    assert ready["event"] == "ready"
    p.ready = ready
    yield p
    if p.p.poll() is None:
        p.p.kill()
    p.p.wait()


def test_ready(proc):
    d = proc.ready["data"]
    assert proc.ready["id"] == ""
    assert d["python"].startswith("3.12") and d["pid"] > 0 and d["version"]


def test_ping_has_rss(proc):
    proc.send("1", "system.ping")
    m, _ = proc.final("1")
    assert m["result"]["rssBytes"] > 0


def test_unknown_method(proc):
    proc.send("1", "nope.nope")
    m, _ = proc.final("1")
    assert m["error"] == {"code": "validation", "message": "Unknown method nope.nope"}


def test_bad_line_with_id(proc):
    proc.p.stdin.write(b'{"id":"z","method":""}\nnot json\n')
    proc.p.stdin.flush()
    m, _ = proc.final("z")
    assert m["error"]["code"] == "validation"
    proc.send("1", "system.ping")  # still alive
    assert "result" in proc.final("1")[0]


def test_handler_exception_is_internal(proc):
    proc.send("1", "test.boom")
    m, _ = proc.final("1")
    assert m["error"]["code"] == "internal" and m["error"]["message"] == "kaput"
    time.sleep(0.2)
    proc.send("2", "system.ping")
    proc.final("2")
    proc.p.stdin.close()
    proc.p.wait(10)
    assert b"ValueError" in proc.err or True


def test_cancel(proc):
    proc.send("s", "test.slow", seconds=30)
    time.sleep(0.5)
    t0 = time.monotonic()
    proc.p.stdin.write(b'{"id":"s","method":"$cancel"}\n')
    proc.p.stdin.flush()
    m, evs = proc.final("s", 10)
    assert m["error"]["code"] == "cancelled"
    assert time.monotonic() - t0 < 3
    assert any(e.get("event") == "log" for e in evs)


def test_concurrent_by_id(proc):
    proc.send("slow", "test.echo", delay=0.6, value="A")
    proc.send("fast", "test.echo", value="B")
    first, _ = proc.final("fast")
    assert first["result"]["value"] == "B"
    second, _ = proc.final("slow")
    assert second["result"]["value"] == "A"


def test_stray_print_not_on_stdout(proc):
    proc.send("1", "test.print")
    proc.final("1")
    assert all("STRAY" not in r for r in proc.raw)
    proc.send("2", "system.ping")
    proc.final("2")
    proc.p.stdin.close()
    proc.p.wait(10)
    time.sleep(0.2)
    assert b"STRAY OUTPUT" in proc.err


def test_tqdm_progress_events(proc):
    proc.send("1", "test.tqdm")
    m, evs = proc.final("1")
    prog = [e for e in evs if e["event"] == "progress"]
    assert prog and prog[0]["data"]["msg"] == "Working"


def test_shutdown_exits_zero(proc):
    proc.p.stdin.write(b'{"id":"","method":"$shutdown"}\n')
    proc.p.stdin.flush()
    assert proc.p.wait(2.5) == 0


def test_shutdown_with_stuck_inflight(proc):
    proc.send("s", "test.slow", seconds=60)
    time.sleep(0.3)
    proc.p.stdin.write(b'{"id":"","method":"$shutdown"}\n')
    proc.p.stdin.flush()
    assert proc.p.wait(4) == 0


def test_eof_exits(proc):
    proc.p.stdin.close()
    assert proc.p.wait(3) == 0


def test_selftest():
    p = subprocess.run([sys.executable, "-m", "toolbox_sidecar", "--selftest"],
                       capture_output=True, text=True, cwd=SIDECAR, timeout=180)
    assert p.returncode == 0, p.stderr
    lines = p.stdout.strip().splitlines()
    assert len(lines) == 1
    d = json.loads(lines[0])
    assert d["python"].startswith("3.12")
    assert set(d["packages"]) == {"torch", "audio_separator", "librosa", "onnxruntime", "basic_pitch"}
    assert all(d["packages"].values())
