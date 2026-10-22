"""The daily monitor run, as a Windows scheduled task.

The task runs `linkverify.bat monitor` once a day. Each run checks only the
links that are due, so a daily run gives weekly re-checks for new links and
monthly re-checks for older ones. If the PC is off at the set time, Windows
runs the task the next time it can (StartWhenAvailable).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

TASK = "BacklinkVerifier Monitor"
PROJECT = Path(__file__).resolve().parent.parent

XML = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Re-checks your backlinks and sends alerts (Backlink Verifier).</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T{time}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>monitor</Arguments>
      <WorkingDirectory>{workdir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def install(time: str) -> int:
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", time):
        print("Use a 24-hour time like 09:30.")
        return 2
    bat = PROJECT / "linkverify.bat"
    if sys.platform != "win32":
        print("Scheduled tasks are set up on Windows. On Mac or Linux, add this line with `crontab -e`:")
        h, m = time.split(":")
        print(f"{int(m)} {int(h)} * * * cd '{PROJECT}' && '{sys.executable}' -m linkverify monitor")
        return 0
    xml = XML.format(time=time, command=_esc(str(bat)), workdir=_esc(str(PROJECT)))
    fd, path = tempfile.mkstemp(suffix=".xml")
    os.close(fd)
    Path(path).write_text(xml, encoding="utf-16")
    try:
        out = subprocess.run(["schtasks", "/Create", "/TN", TASK, "/XML", path, "/F"],
                             capture_output=True, text=True)
    finally:
        os.unlink(path)
    if out.returncode != 0:
        print("Could not create the scheduled task:", (out.stderr or out.stdout).strip())
        return 1
    print(f"Scheduled: '{TASK}' runs every day at {time}.")
    print("It re-checks only links that are due, then sends alerts. Logs go to data\\logs.")
    print("If the PC is off at that time, Windows runs it the next time it can.")
    return 0


def remove() -> int:
    if sys.platform != "win32":
        print("Remove the line from your crontab with `crontab -e`.")
        return 0
    out = subprocess.run(["schtasks", "/Delete", "/TN", TASK, "/F"], capture_output=True, text=True)
    print("Scheduled task removed." if out.returncode == 0 else (out.stderr or out.stdout).strip())
    return out.returncode


def status() -> int:
    if sys.platform != "win32":
        print("On Mac or Linux, check `crontab -l`.")
        return 0
    out = subprocess.run(["schtasks", "/Query", "/TN", TASK, "/V", "/FO", "LIST"], capture_output=True, text=True)
    if out.returncode != 0:
        print("No scheduled task yet. Run: linkverify schedule install --time 10:00")
        return 1
    keep = ("TaskName", "Next Run Time", "Last Run Time", "Last Result", "Status")
    for line in out.stdout.splitlines():
        if line.split(":", 1)[0].strip() in keep:
            print(line.strip())
    return 0


def _run(args: list[str]) -> subprocess.CompletedProcess:
    # schtasks prints in the console's code page; decode it that way and never fail on odd characters
    enc = "oem" if sys.platform == "win32" else "utf-8"
    return subprocess.run(args, capture_output=True, text=True, encoding=enc, errors="replace")


def query() -> dict:
    """The daily run's state, for the app: {supported, installed, time, next_run, last_run, last_result}.

    Works on any Windows language: the run time comes from the task's XML (always 24-hour),
    the other fields by position in schtasks' CSV output (column names are translated)."""
    if sys.platform != "win32":
        return {"supported": False, "installed": False}
    out = _run(["schtasks", "/Query", "/TN", TASK, "/XML"])
    if out.returncode != 0:
        return {"supported": True, "installed": False}
    m = re.search(r"<StartBoundary>[^<]*T(\d\d:\d\d)", out.stdout)
    info = {"supported": True, "installed": True, "time": m.group(1) if m else ""}
    csv_out = _run(["schtasks", "/Query", "/TN", TASK, "/FO", "CSV", "/V", "/NH"])
    try:
        import csv
        row = next(csv.reader(csv_out.stdout.strip().splitlines()))
        info.update(next_run=row[2], status=row[3], last_run=row[5], last_result=row[6])
    except (StopIteration, IndexError):
        pass
    return info


def install_quiet(time: str) -> tuple[bool, str]:
    """install() for the app: returns (ok, message) instead of printing."""
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = install(time)
    return code == 0, buf.getvalue().strip()


def remove_quiet() -> tuple[bool, str]:
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = remove()
    return code == 0, buf.getvalue().strip()
