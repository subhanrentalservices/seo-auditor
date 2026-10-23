"""The daily run's scheduled task: what it runs in a developer setup and in the desktop app."""

import sys
from pathlib import Path

from linkverify import schedule


def test_developer_setup_runs_the_bat(tmp_path):
    cfg = tmp_path / "config.toml"
    command, arguments, workdir = schedule._action(cfg)
    assert command.endswith("linkverify.bat") and workdir == str(schedule.PROJECT)
    assert arguments == f'--config "{cfg.resolve()}" monitor'
    assert schedule._action(None)[1] == "monitor"


def test_desktop_app_runs_the_packaged_engine(tmp_path, monkeypatch):
    exe = tmp_path / "engine" / "linkverify.exe"
    ws = tmp_path / "SEO Auditor" / "link-engine"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    command, arguments, workdir = schedule._action(ws / "config.toml")
    assert command == str(exe) and workdir == str(ws.resolve())
    assert arguments == f'--config "{(ws / "config.toml").resolve()}" monitor'


def test_task_xml_carries_the_action(tmp_path, monkeypatch):
    if sys.platform != "win32":
        return
    seen = {}

    def fake_run(args, **kw):
        seen["xml"] = Path(args[args.index("/XML") + 1]).read_text(encoding="utf-16")
        return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
    monkeypatch.setattr(schedule.subprocess, "run", fake_run)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "A&B" / "linkverify.exe"))
    assert schedule.install("09:30", tmp_path / "ws" / "config.toml") == 0
    xml = seen["xml"]
    assert "<Command>" + str(tmp_path / "A&amp;B" / "linkverify.exe") + "</Command>" in xml
    assert "--config" in xml and "monitor</Arguments>" in xml and "T09:30:00" in xml
    assert schedule.install("9am") == 2
