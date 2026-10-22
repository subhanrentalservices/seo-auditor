import json
import threading
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from linkverify import alerts, checks, monitor
from linkverify.changes import diff
from linkverify.checks import Verifier
from linkverify.db import Registry

T0 = datetime(2026, 1, 1, 10, 0, tzinfo=timezone.utc)


def row(added_days_ago, checked_days_ago, now=T0):
    iso = lambda d: None if d is None else (now - timedelta(days=d)).isoformat()
    return {"added_at": iso(added_days_ago), "last_checked": iso(checked_days_ago)}


@pytest.mark.parametrize("added,checked,due", [
    (0, None, True),     # never checked
    (10, 6, False),      # new link, checked 6 days ago
    (10, 7, True),       # new link, a week ago
    (100, 10, False),    # older than 90 days: monthly
    (100, 30, True),
    (89, 7, True),
])
def test_due_schedule(cfg, added, checked, due):
    assert monitor.is_due(row(added, checked), cfg, T0) is due


def test_daily_run_slightly_earlier_still_counts(cfg):
    r = row(10, 7)
    early = T0 - timedelta(hours=1)  # the task fired an hour earlier than last week
    assert monitor.is_due(r, cfg, early)


def base_result(**kw):
    res = {"verdict": "Counts", "links_found": 1, "status": 200, "final_url": "https://a.com/x",
           "link": {"rel": [], "anchor_text": "tool"},
           "checks": [{"num": n, "status": "pass"} for n in range(1, 16)]}
    res.update(kw)
    return res


def test_diff_detects_problems_and_recoveries():
    good = base_result()
    weak = base_result(verdict="Weak", link={"rel": ["nofollow"], "anchor_text": "tool"})
    kinds = {c.kind: c.severity for c in diff(good, weak)}
    assert kinds == {"verdict": "bad", "rel_changed": "bad"}

    gone = base_result(verdict="Not counted", links_found=0, link=None)
    kinds = {c.kind: c.severity for c in diff(good, gone)}
    assert kinds["link_removed"] == "bad" and kinds["verdict"] == "bad"

    noindex = base_result(verdict="Not counted",
                          checks=[{"num": n, "status": "fail" if n == 7 else "pass"} for n in range(1, 16)])
    assert "noindex" in {c.kind for c in diff(good, noindex)}

    kinds = {c.kind: c.severity for c in diff(weak, good)}
    assert kinds == {"verdict": "good", "rel_changed": "good"}
    assert diff(None, good) == [] and diff(good, good) == []


def test_digest_format():
    evs = [{"id": 1, "link_id": 3, "severity": "bad", "detail": "Your link is no longer on the page.",
            "source_url": "https://a.com/x", "target": "me.com"},
           {"id": 2, "link_id": 4, "severity": "good", "detail": "Verdict changed from Weak to Counts.",
            "source_url": "https://b.com/y", "target": "me.com"}]
    subject, text = alerts.format_digest(evs)
    assert subject == "Backlink alert: problems on 1 link, 1 link recovered"
    assert "#3 https://a.com/x" in text and "[PROBLEM]" in text and "[RECOVERED]" in text


def test_a_month_of_daily_runs(cfg, server, monkeypatch):
    """Phase 2 gate: daily runs for 5 weeks re-check new links weekly, alert once per change, no errors."""
    base, me = server
    reg = Registry(cfg.db_path)
    clock = {"now": T0}
    monkeypatch.setattr(checks, "now_iso", lambda: clock["now"].replace(microsecond=0).isoformat())
    sent = []
    cfg.email_smtp_host, cfg.email_to = "smtp.test", "me@test"
    monkeypatch.setattr(alerts, "send", lambda c, s, t: sent.append((s, t)) or ["email sent"])

    for path in ("/good.html", "/nofollow.html"):
        link_id, _ = reg.add(base + path, "localhost")
        reg.conn.execute("UPDATE links SET added_at = ? WHERE id = ?", (T0.isoformat(), link_id))
    reg.conn.commit()

    v = Verifier(cfg)
    checked_per_day = []
    try:
        for day in range(36):
            clock["now"] = T0 + timedelta(days=day, minutes=day % 3)  # the task time drifts a little
            if day == 15:  # the site marks link 1 as sponsored; simulate by pointing it at such a page
                reg.conn.execute("UPDATE links SET source_url = ? WHERE id = 1", (base + "/sponsored.html",))
                reg.conn.commit()
            s = monitor.run_monitor(cfg, reg, now=clock["now"], verifier=v, printer=lambda *_: None)
            assert not s.errors
            checked_per_day.append(s.checked)
    finally:
        v.close()

    # day 0, then every 7 days: 0, 7, 14, 21, 28, 35
    assert [d for d, n in enumerate(checked_per_day) if n] == [0, 7, 14, 21, 28, 35]
    assert all(n == 2 for n in checked_per_day if n)
    assert len(reg.history(1)) == 6
    # link 1 went from Counts to Weak on day 21: one digest, sent once
    assert len(sent) == 1 and "problems on 1 link" in sent[0][0]
    assert reg.unalerted(("bad", "good")) == []
    assert (cfg.log_dir / f"monitor-{T0.strftime('%Y-%m-%d')}.log").exists()
