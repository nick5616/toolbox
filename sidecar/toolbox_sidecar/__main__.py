"""Entry point: python -m toolbox_sidecar [--selftest]"""

from .server import main

if __name__ == "__main__":
    raise SystemExit(main())
