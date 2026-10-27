"""Test-only handlers, loaded in the subprocess via
TOOLBOX_SIDECAR_EXTRA_HANDLERS=toolbox_test_handlers and PYTHONPATH=tests/."""

import time

from toolbox_sidecar.registry import Context, handler


@handler("test.boom")
def boom(ctx: Context, params: dict) -> dict:
    raise ValueError("kaput")


@handler("test.slow")
def slow(ctx: Context, params: dict) -> dict:
    ctx.log("started")
    end = time.monotonic() + float(params.get("seconds", 10))
    while time.monotonic() < end:
        ctx.check_cancelled()
        time.sleep(0.01)
    return {"slept": True}


@handler("test.echo")
def echo(ctx: Context, params: dict) -> dict:
    time.sleep(float(params.get("delay", 0)))
    return {"value": params.get("value")}


@handler("test.print")
def noisy(ctx: Context, params: dict) -> dict:
    print("STRAY OUTPUT")
    return {"ok": True}


@handler("test.tqdm")
def tq(ctx: Context, params: dict) -> dict:
    from tqdm import tqdm

    for _ in tqdm(range(5), desc="Working"):
        time.sleep(0.15)
    return {}
