"""Only one matte model stays resident: loading one frees the other (SPEC 10.3)."""

from __future__ import annotations

import sys


def before_rvm() -> None:
    mod = sys.modules.get(__package__ + ".sam")
    if mod is not None:
        mod.drop_predictor()


def before_sam() -> None:
    mod = sys.modules.get(__package__ + ".rvm")
    if mod is not None:
        mod.drop_session()
