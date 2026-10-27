import io

import pytest

from toolbox_sidecar import progress, registry
from toolbox_sidecar.protocol import Writer
from toolbox_sidecar.registry import Context


@pytest.fixture(autouse=True)
def _installed():
    progress.install()
    yield
    registry.current() and registry.current().unbind()


def _events(buf):
    import json

    return [json.loads(x) for x in buf.getvalue().splitlines()]


def test_install_idempotent():
    import tqdm
    import tqdm.auto

    a = tqdm.tqdm
    progress.install()
    assert tqdm.tqdm is a is tqdm.std.tqdm is tqdm.auto.tqdm


def test_no_context_no_crash():
    from tqdm import tqdm

    assert list(tqdm(range(5))) == list(range(5))
    with tqdm(total=3) as b:
        b.update(1)


def test_real_loop_drives_events_and_throttles():
    import tqdm.auto
    from tqdm import tqdm

    buf = io.StringIO()
    ctx = Context("r1", Writer(buf))
    ctx.bind()
    ctx._last_progress = 0.0
    for _ in tqdm(range(1000), desc="Loading"):
        pass
    ctx.unbind()
    ev = _events(buf)
    assert 1 <= len(ev) < 50  # throttled (0.1 s interval)
    assert ev[0]["event"] == "progress"
    assert ev[0]["data"]["msg"] == "Loading"
    assert all(-1 <= e["data"]["pct"] <= 1 for e in ev)
    import tqdm.autonotebook
    import tqdm.std as std

    assert tqdm.auto.tqdm is tqdm.autonotebook.tqdm is std.tqdm


def test_unknown_total_is_indeterminate_and_stage_wins():
    from tqdm import tqdm

    buf = io.StringIO()
    ctx = Context("r2", Writer(buf))
    ctx.bind()
    ctx.stage("Separating")
    ctx._last_progress = 0.0
    b = tqdm(desc="bar")
    b.update(3)
    b.close()
    ctx.unbind()
    ev = _events(buf)
    last = ev[-1]["data"]
    assert last == {"pct": -1, "msg": "Separating"}


def test_trange_and_auto():
    import tqdm.auto

    buf = io.StringIO()
    ctx = Context("r3", Writer(buf))
    ctx.bind()
    assert list(tqdm.auto.trange(3)) == [0, 1, 2]
    assert list(tqdm.trange(2)) == [0, 1]
    ctx.unbind()
    assert _events(buf)
