import io
import json
import threading

import pytest

from toolbox_sidecar.protocol import MAX_LINE_BYTES, ProtocolError, Writer, parse_request


def test_parse_ok():
    r = parse_request('{"id":"a","method":"x.y","params":{"k":1}}')
    assert (r.id, r.method, r.params) == ("a", "x.y", {"k": 1})


def test_parse_defaults_params():
    assert parse_request('{"id":"a","method":"m"}').params == {}


@pytest.mark.parametrize(
    "line",
    ["nope", "[]", '{"id":1,"method":"m"}', '{"id":"a"}', '{"id":"a","method":""}',
     '{"id":"a","method":"m","params":[1]}'],
)
def test_parse_errors(line):
    with pytest.raises(ProtocolError):
        parse_request(line)


def test_size_limit():
    with pytest.raises(ProtocolError):
        parse_request(" " * (MAX_LINE_BYTES + 1))


def test_writer_shapes():
    out = io.StringIO()
    w = Writer(out)
    w.ready({"v": 1})
    w.event("i", "progress", {"pct": 0.5})
    w.result("i", {"a": "é"})
    w.error("i", "internal", "m", "h")
    w.error("i", "internal", "m")
    msgs = [json.loads(x) for x in out.getvalue().splitlines()]
    assert msgs[0] == {"id": "", "event": "ready", "data": {"v": 1}}
    assert msgs[2] == {"id": "i", "result": {"a": "é"}}
    assert msgs[3]["error"] == {"code": "internal", "message": "m", "hint": "h"}
    assert "hint" not in msgs[4]["error"]


def test_writer_thread_safety():
    out = io.StringIO()
    w = Writer(out)

    def work(n):
        for i in range(200):
            w.result(f"{n}-{i}", {"pad": "x" * 100})

    ts = [threading.Thread(target=work, args=(n,)) for n in range(16)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    lines = out.getvalue().splitlines()
    assert len(lines) == 16 * 200
    assert all(json.loads(x)["result"]["pad"] == "x" * 100 for x in lines)
