"""The Today screen: what to do next, worked out from your data, most urgent first.

Each action has a plain title, a reason, and one thing to do (`go` opens a screen,
`run` starts a job). Nothing here changes data.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from ..config import Config
from ..db import Registry
from ..monitor import is_due
from ..sitegraph import load as load_graph

PRIORITY = {"urgent": 0, "today": 1, "soon": 2, "setup": 3}


def _ago(iso: str | None, now: datetime) -> timedelta | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    dt = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return now - dt


def summary(reg: Registry, cfg: Config, now: datetime) -> dict:
    rows = reg.all()
    counts = {"Counts": 0, "Weak": 0, "Pending": 0, "Not counted": 0, "unchecked": 0}
    for r in rows:
        counts[r["last_verdict"] if r["last_verdict"] in counts else "unchecked"] += 1
    opps = reg.opportunities(limit=5000)
    open_opps = [o for o in opps if o["status"] in ("new", "working", "pitched")]
    return {"links": len(rows), "verdicts": counts, "due": sum(1 for r in rows if is_due(r, cfg, now)),
            "opportunities_open": len(open_opps), "opportunities_new": sum(1 for o in opps if o["status"] == "new"),
            "won": sum(1 for o in opps if o["status"] == "won")}


def build(reg: Registry, cfg: Config, now: datetime, task_state: dict | None = None) -> list[dict]:
    acts: list[dict] = []

    def add(priority, kind, title, why, label, go=None, run=None, ref=None):
        acts.append({"priority": priority, "kind": kind, "title": title, "why": why,
                     "action": {"label": label, "go": go, "run": run}, "ref": ref})

    rows = reg.all()
    by_id = {r["id"]: r for r in rows}

    # links that broke since they last counted
    seen: set[int] = set()
    for e in reg.events(None, 300):
        age = _ago(e["at"], now)
        if e["severity"] != "bad" or e["link_id"] in seen or age is None or age > timedelta(days=14):
            continue
        row = by_id.get(e["link_id"])
        if row is None or row["last_verdict"] == "Counts":
            continue  # fixed itself since
        seen.add(e["link_id"])
        host = row["source_url"].split("//")[-1].split("/")[0].removeprefix("www.")
        add("urgent", "link_problem", f"Your link on {host} has a problem", e["detail"], "Open link",
            go=f"links/{row['id']}", ref=row["id"])

    unchecked = [r for r in rows if not r["last_checked"]]
    if unchecked:
        n = len(unchecked)
        add("today", "unchecked", f"Check {n} new link{'s' if n != 1 else ''}",
            "They were added but have not been verified yet.", "Check now", run={"op": "check", "which": "unchecked"})
    due = [r for r in rows if r["last_checked"] and is_due(r, cfg, now)]
    if due:
        n = len(due)
        add("soon", "due", f"Re-check {n} link{'s' if n != 1 else ''}",
            "It is time for their scheduled re-check. The daily run does this for you if it is set up.",
            "Re-check now", run={"op": "check", "which": "due"})

    # opportunities
    opps = reg.opportunities(limit=5000)
    for o in opps:
        if o["kind"] != "journalist" or o["status"] not in ("new", "working"):
            continue
        d = json.loads(o["data_json"] or "{}")
        age = _ago(o["found_at"], now)
        if age is not None and age > timedelta(days=5):
            continue
        deadline = f" Deadline: {d['deadline']}." if d.get("deadline") else ""
        add("today", "journalist", f"Answer a journalist: {o['title'][:90]}",
            f"From {d.get('source') or 'a request service'}.{deadline} Fast, specific answers win these.",
            "Write answer", go=f"opportunities/{o['id']}", ref=o["id"])
    best = [o for o in opps if o["status"] == "new" and o["kind"] != "journalist" and o["score"] >= cfg.alert_min_score][:3]
    for o in best:
        add("today", "opportunity", f"Pitch {o['site'] or 'this page'} (score {o['score']})", o["title"][:140],
            "Open", go=f"opportunities/{o['id']}", ref=o["id"])
    for o in opps:
        if o["status"] != "pitched":
            continue
        age = _ago(o["updated_at"], now)
        if age is not None and age > timedelta(days=7):
            add("soon", "follow_up", f"Follow up with {o['site'] or 'them'}",
                f"You pitched them {age.days} days ago and marked nothing since.", "Open",
                go=f"opportunities/{o['id']}", ref=o["id"])

    # site health
    graph = load_graph(cfg)
    if cfg.my_site:
        if graph is None:
            add("soon", "map_site", "Map your site's links",
                "Finds broken links, pages nobody links to, and address problems such as a missing www.",
                "Map my site", run={"op": "graph"})
        else:
            for i in graph.get("issues", []):
                if i["severity"] == "high":
                    add("urgent" if i["kind"] in ("host_variant", "broken_internal") else "today", "site_fault",
                        i["title"], i["fix"], "See details", go=f"health/{i['kind']}", ref=i["kind"])
            age = _ago(graph.get("crawled_at"), now)
            if age is not None and age > timedelta(days=30):
                add("soon", "map_site", "Map your site again", f"The last map is {age.days} days old.", "Map my site",
                    run={"op": "graph"})

    # setup that unlocks more
    if cfg.my_site:
        if not cfg.brand_names or not cfg.topics:
            add("setup", "setup_site", "Tell the tool about your business",
                "Brand names and topics are needed to find mentions and journalist requests.", "Open settings", go="settings/site")
        if not cfg.competitors:
            add("setup", "setup_competitors", "Add 2 to 6 competitors",
                "The best link opportunities are sites that already link to your competitors.", "Open settings", go="settings/site")
        if not reg.get_meta("finder_last_run:listings"):
            add("setup", "setup_listings", "Get your free listings",
                "Lists the free directories, maps and profiles where your business should be, with your website on each. "
                "You sign up yourself; the tool checks each link afterwards.", "Show me", run={"op": "find", "which": "listings"})
        if cfg.competitors and not reg.get_meta("finder_last_run:partners"):
            add("setup", "setup_partners", "See who your competitors partner with",
                "Reads your competitors' sites for the associations, suppliers and sponsors they link to. Many list their members.",
                "Look now", run={"op": "find", "which": "partners"})
        if not cfg.google_alerts_feeds and not cfg.has_dataforseo:
            add("setup", "setup_feeds", "Catch every mention of your business, free",
                "Create a Google Alert for your business name with 'Deliver to: RSS feed' and paste the feed address. "
                "Pages that name you without a link become opportunities.", "Set it up", go="settings/free")
        if not rows:
            add("setup", "first_link", "Log the links you already have",
                "Add each page that links to you, and the tool will prove whether it counts.", "Add a link", go="links/new")
    last = (task_state or {}).get("last")
    if last and not last.get("ok") and not last.get("cancelled") and last.get("op") and not (task_state or {}).get("running"):
        age = now.timestamp() - float(last.get("finished") or 0)
        if age < 86400:
            add("urgent", "task_failed", f"'{last.get('name', 'The last job')}' stopped with an error",
                last.get("error", ""), "Try again", run=last["op"])

    acts.sort(key=lambda a: PRIORITY[a["priority"]])
    for n, a in enumerate(acts):
        a["id"] = f"{a['kind']}-{a['ref'] if a['ref'] is not None else n}"
    return acts
