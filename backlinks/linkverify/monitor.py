"""Re-checks on a schedule, change tracking and alerts.

`linkverify monitor` is meant to run once a day (the Windows scheduled task
does this). Each run checks only the links that are due:

* never checked, or
* checked more than `weekly_days` ago while the link is younger than
  `intensive_period_days`, or
* checked more than `monthly_days` ago after that.

Every check is compared with the previous one; changes are saved as events and
sent as one alert digest per run.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import alerts
from .changes import diff
from .checks import Verifier, evidence_path
from .config import Config
from .db import Registry, now_iso

SLACK = timedelta(hours=3)  # a daily run a little earlier than last time still counts


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    dt = datetime.fromisoformat(ts)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def interval_for(row, cfg: Config, now: datetime) -> timedelta:
    added = _parse(row["added_at"]) or now
    young = (now - added) < timedelta(days=cfg.intensive_period_days)
    return timedelta(days=cfg.weekly_days if young else cfg.monthly_days)


def is_due(row, cfg: Config, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    last = _parse(row["last_checked"])
    if last is None:
        return True
    return now - last >= interval_for(row, cfg, now) - SLACK


def next_due(row, cfg: Config, now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    last = _parse(row["last_checked"])
    if last is None:
        return now
    return last + interval_for(row, cfg, now)


def check_and_record(reg: Registry, verifier: Verifier, cfg: Config, row) -> tuple[dict, list]:
    """Run the 15 checks on one registry row, save the result and its changes."""
    prev = reg.latest(row["id"])
    ev = evidence_path(cfg, row["id"]) if cfg.save_evidence else None
    res = verifier.verify(row["source_url"], row["target"], ev)
    reg.record(row["id"], res, res.get("evidence_dir"))
    changes = diff(prev, res)
    for c in changes:
        reg.add_event(row["id"], c.kind, c.severity, c.detail, res["checked_at"])
    if prev is None:
        reg.add_event(row["id"], "first_check", "info", f"First check: {res['verdict']}.", res["checked_at"])
    return res, changes


@dataclass
class MonitorSummary:
    checked: int = 0
    due: int = 0
    total: int = 0
    errors: list[str] = field(default_factory=list)
    changes: int = 0
    alert_status: list[str] = field(default_factory=list)
    log_file: str = ""
    finder_new: int = 0


def send_pending_alerts(reg: Registry, cfg: Config, desktop: bool = False) -> list[str]:
    """Email/Telegram if you set them up; otherwise a free Windows pop-up from the daily run (desktop=True).
    Without either, everything simply waits in the app's Today screen."""
    severities = ("bad",) if cfg.alert_on == "bad" else ("bad", "good")
    pending = reg.unalerted(severities)
    opps = reg.opportunities_to_alert(cfg.alert_min_score)
    if not pending and not opps:
        return []
    if not alerts.channels(cfg):
        if desktop and cfg.desktop_notifications:
            from . import notify
            title, body = notify.digest(pending, opps)
            shown, msg = notify.show(title, body)
            if shown:
                reg.mark_alerted([e["id"] for e in pending])
                reg.mark_opportunities_alerted([o["id"] for o in opps])
                return [msg]
        parts = []
        if pending:
            parts.append(f"{len(pending)} change(s)")
        if opps:
            parts.append(f"{len(opps)} new opportunit{'ies' if len(opps) != 1 else 'y'}")
        return [f"{' and '.join(parts)} waiting for you in the app (Today)"]
    subject, text = alerts.format_full_digest(pending, opps)
    status = alerts.send(cfg, subject, text)
    if any("FAILED" not in s for s in status):
        reg.mark_alerted([e["id"] for e in pending])
        reg.mark_opportunities_alerted([o["id"] for o in opps])
    return status


def run_monitor(cfg: Config, reg: Registry, now: datetime | None = None, verifier: Verifier | None = None,
                printer=print, send_alerts: bool = True, run_finders_too: bool = True) -> MonitorSummary:
    now = now or datetime.now(timezone.utc)
    summary = MonitorSummary()
    rows = reg.all()
    summary.total = len(rows)
    due = [r for r in rows if is_due(r, cfg, now)]
    summary.due = len(due)

    cfg.log_dir.mkdir(parents=True, exist_ok=True)
    log_path = cfg.log_dir / f"monitor-{now.strftime('%Y-%m-%d')}.log"
    summary.log_file = str(log_path)

    def log(msg: str) -> None:
        printer(msg)
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {msg}\n")

    log(f"Monitor run: {len(due)} of {len(rows)} link(s) due.")
    own = verifier is None

    def check_rows(rows_to_check) -> None:
        nonlocal verifier
        if rows_to_check and verifier is None:
            verifier = Verifier(cfg)
        for i, row in enumerate(rows_to_check, 1):
            try:
                res, changes = check_and_record(reg, verifier, cfg, row)
                summary.checked += 1
                summary.changes += len(changes)
                tail = "; ".join(c.detail for c in changes)
                log(f"[{i}/{len(rows_to_check)}] #{row['id']} {res['verdict']}{' - ' + tail if tail else ''}  {row['source_url']}")
            except Exception as exc:  # one broken link must not stop the run
                msg = f"#{row['id']} check crashed: {type(exc).__name__}: {exc}"
                summary.errors.append(msg)
                log(msg)
                with log_path.open("a", encoding="utf-8") as fh:
                    fh.write(traceback.format_exc())
                reg.add_event(row["id"], "check_error", "bad", f"The check could not run: {exc}", now_iso())

    try:
        check_rows(due)
        if run_finders_too and cfg.has_project:
            _run_due_finders(reg, cfg, now, summary, log)
            # pages the finders just added to the registry get their first check now
            done = {r["id"] for r in due}
            fresh = [r for r in reg.all() if not r["last_checked"] and r["id"] not in done]
            if fresh:
                log(f"Checking {len(fresh)} link(s) the finders just added.")
                check_rows(fresh)
    finally:
        if own and verifier is not None:
            verifier.close()

    if send_alerts:
        summary.alert_status = send_pending_alerts(reg, cfg, desktop=True)
        for s in summary.alert_status:
            log(f"Alerts: {s}")
    log(f"Done: {summary.checked} checked, {summary.changes} change(s), {len(summary.errors)} error(s).")
    return summary


def _run_due_finders(reg: Registry, cfg: Config, now: datetime, summary: "MonitorSummary", log) -> None:
    from .finders import FINDERS, finder_due, run_finders

    due_finders = [n for n in FINDERS if finder_due(reg, cfg, n, now)]
    if not due_finders:
        return
    log(f"Finders due: {', '.join(due_finders)}")
    for r in run_finders(cfg, reg, due_finders):
        summary.finder_new += r.new
        log(f"Finder {r.name}: {r.found} found, {r.new} new" + (f", {r.registered} already linked (added)" if r.registered else ""))
        for e in r.errors:
            log(f"  {r.name}: {e}")
        for n in r.notes:
            log(f"  {r.name}: {n}")
