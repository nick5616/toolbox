"""tqdm shim forwarding progress to the current request. STUB (foundation) — WP-S2."""

from __future__ import annotations


def install() -> None:
    """Replaces tqdm.tqdm / tqdm.auto.tqdm / tqdm.std.tqdm with the shim.

    Must run before audio_separator is imported.
    """
    raise NotImplementedError("progress.install")
