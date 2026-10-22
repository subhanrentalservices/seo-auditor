"""Entry point for the packaged link engine (PyInstaller). Same as `python -m linkverify`."""
import sys

from linkverify.cli import main

if __name__ == "__main__":
    sys.exit(main())
