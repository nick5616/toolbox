"""tqdm shim forwarding progress to the current request's Context (SPEC §4.5)."""

from __future__ import annotations

import io
from typing import Any

from . import registry

_installed = False


def _make_shim() -> type:
    from tqdm.std import tqdm as base

    class ProgressTqdm(base):  # type: ignore[misc, valid-type]
        """Never draws; forwards n/total to the bound Context."""

        monitor_interval = 0  # no monitor thread

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["file"] = io.StringIO()
            kwargs["mininterval"] = 0
            kwargs["miniters"] = 1
            kwargs["disable"] = False
            kwargs.pop("position", None)
            super().__init__(*args, **kwargs)

        def display(self, msg: Any = None, pos: Any = None) -> None:  # noqa: ARG002
            try:
                ctx = registry.current()
                if ctx is None:
                    return
                total = self.total
                pct = (self.n / total) if total else -1
                ctx.progress(pct, getattr(ctx, "_stage", "") or (self.desc or "").rstrip(": "))
            except Exception:  # progress must never break a handler
                pass

    return ProgressTqdm


def install() -> None:
    """Replaces tqdm.tqdm / tqdm.std.tqdm / tqdm.auto.tqdm / tqdm.autonotebook.tqdm
    (and the trange helpers) with the shim. Idempotent. Must run before
    audio_separator is imported."""
    global _installed
    if _installed:
        return
    import tqdm
    import tqdm.auto
    import tqdm.autonotebook
    import tqdm.std

    shim = _make_shim()

    def trange(*args: Any, **kwargs: Any) -> Any:
        return shim(range(*args), **kwargs)

    tqdm.tqdm = shim
    tqdm.std.tqdm = shim
    tqdm.auto.tqdm = shim
    tqdm.autonotebook.tqdm = shim
    tqdm.trange = trange
    tqdm.std.trange = trange
    tqdm.auto.trange = trange
    _installed = True
