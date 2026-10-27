"""Entry point: python -m toolbox_sidecar [--selftest]"""

import os
import sys

from .server import main

if __name__ == "__main__":
    code = main()
    # Don't let a stuck worker thread keep the process alive past shutdown.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
