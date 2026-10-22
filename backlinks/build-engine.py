"""Build the link engine as a standalone program for the desktop app (no Python needed on the user's computer).

Run on each operating system you ship for (PyInstaller cannot cross-compile):
    .venv/Scripts/python build-engine.py      (Windows)
    .venv/bin/python build-engine.py          (macOS)
Output: backlinks/dist/linkverify/ (linkverify.exe on Windows, linkverify on macOS) — electron-builder copies it
into the app as resources/engine.
"""
import os
import subprocess
import sys

sep = ";" if os.name == "nt" else ":"
here = os.path.dirname(os.path.abspath(__file__))
args = [
    sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "linkverify",
    "--add-data", f"linkverify/static{sep}linkverify/static",
    "--add-data", f"config.example.toml{sep}.",
    "--collect-submodules", "linkverify",
    "--collect-all", "playwright",
    "engine_entry.py",
]
sys.exit(subprocess.call(args, cwd=here))
