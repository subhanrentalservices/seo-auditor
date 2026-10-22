"""Free desktop notifications: a Windows pop-up from the daily run. No email, no account.

Uses Windows PowerShell (built into Windows 10 and 11) to show a standard toast.
The text is passed through environment variables, never pasted into the script,
so nothing in a page title can run as a command.
"""

from __future__ import annotations

import os
import subprocess
import sys

APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [Security.SecurityElement]::Escape($env:LV_TITLE)
$b = [Security.SecurityElement]::Escape($env:LV_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:LV_APP).Show($toast)
"""


def available() -> bool:
    return sys.platform == "win32"


def show(title: str, body: str) -> tuple[bool, str]:
    """Show a desktop notification. Returns (shown, message). Never raises."""
    if not available():
        return False, "desktop notifications work on Windows only"
    env = {**os.environ, "LV_TITLE": title[:120], "LV_BODY": body[:400], "LV_APP": APP_ID}
    try:
        out = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                              "-Command", SCRIPT], env=env, capture_output=True, text=True, timeout=30,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"desktop notification failed: {exc}"
    if out.returncode != 0:
        return False, "desktop notification failed: " + (out.stderr or out.stdout).strip()[-300:]
    return True, "desktop notification shown"


def digest(pending: list, opps: list) -> tuple[str, str]:
    """A short title and body for the pop-up."""
    bad = [e for e in pending if e["severity"] == "bad"]
    good = [e for e in pending if e["severity"] != "bad"]
    parts = []
    if bad:
        parts.append(f"{len(bad)} link problem{'s' if len(bad) != 1 else ''}")
    if good:
        parts.append(f"{len(good)} link{'s' if len(good) != 1 else ''} fixed or new")
    if opps:
        parts.append(f"{len(opps)} new opportunit{'ies' if len(opps) != 1 else 'y'}")
    title = "Backlink Verifier: " + ", ".join(parts)
    lines = []
    for e in bad[:2]:
        lines.append(f"{e['source_url'].split('://', 1)[-1][:60]}: {e['detail'][:80]}")
    for o in opps[:2]:
        lines.append(f"{o['title'][:80]} (score {o['score']})")
    lines.append("Open Backlink Verifier to see everything.")
    return title, "\n".join(lines)
