from datetime import datetime, timedelta, timezone

import pytest

from linkverify import finders
from linkverify.d4s import BudgetExceeded, Client
from linkverify.db import Registry
from linkverify.finders import Context, parse_alerts_feed, requests_from_email, split_requests
from linkverify.score import score


class FakeClient:
    """Stands in for DataForSEO: canned answers, records calls."""

    def __init__(self, serp=None, post=None):
        self.serp_items = serp or {}
        self.post_items = post or {}
        self.calls = []

    def serp(self, query, depth=20):
        self.calls.append(("serp", query))
        return self.serp_items.get(query, [])

    def post(self, endpoint, task):
        self.calls.append((endpoint, task))
        fn = self.post_items.get(endpoint)
        return fn(task) if callable(fn) else (fn or [])


@pytest.fixture
def project(cfg, server):
    base, me = server
    cfg.my_site = "localhost"
    cfg.brand_names = ["Acme Rentals"]
    cfg.topics = ["car rental", "road trip"]
    cfg.competitors = ["127.0.0.2", "rival.example"]
    cfg.my_pages = [f"http://{me}/page"]
    return cfg


def test_alerts_feed_unwraps_google_links(server):
    base, _ = server
    import httpx
    entries = parse_alerts_feed(httpx.get(base + "/alerts.xml").text)
    assert entries[0]["url"] == base + "/mention_nolink.html"
    assert entries[0]["title"] == "Acme Rentals review"
    assert len(entries) == 3


def test_mentions_from_alerts(project, server):
    base, _ = server
    project.google_alerts_feeds = [base + "/alerts.xml"]
    project.serp_mention_search = False
    reg = Registry(project.db_path)
    ctx = Context(project, reg)
    r = finders.find_mentions(ctx)
    ctx.close()
    assert r.new == 1 and r.registered == 1, (r.errors, r.notes)
    opp = reg.opportunities()[0]
    assert opp["kind"] == "unlinked_mention" and opp["url"] == base + "/mention_nolink.html"
    assert "topics (car rental, road trip)" in opp["score_detail"]
    # the page that already links was added to the registry
    assert [row["source_url"] for row in reg.all()] == [base + "/mention_link.html"]
    # running again finds nothing new
    ctx = Context(project, reg)
    assert finders.find_mentions(ctx).new == 0
    ctx.close()


def test_mentions_from_search(project, server):
    base, _ = server
    q = '"Acme Rentals" -site:localhost'
    fake = FakeClient(serp={q: [{"url": base + "/mention_nolink.html", "title": "t", "description": "", "domain": "", "rank": 1}]},
                      post={"backlinks/bulk_ranks/live": [{"items": [{"target": "127.0.0.1", "rank": 64}]}]})
    reg = Registry(project.db_path)
    ctx = Context(project, reg, client=fake)
    r = finders.find_mentions(ctx)
    ctx.close()
    assert r.new == 1
    assert "strength 64" in reg.opportunities()[0]["score_detail"]


def test_resources_find_dead_links(project, server):
    base, me = server
    project.topics = ["car rental"]
    project.resource_footprints = ['"useful resources"']
    fake = FakeClient(serp={'car rental "useful resources"': [{"url": base + "/resources.html", "title": "Car rental resources",
                                                              "description": "", "domain": "", "rank": 3}]})
    reg = Registry(project.db_path)
    ctx = Context(project, reg, client=fake)
    r = finders.find_resources(ctx)
    ctx.close()
    kinds = sorted(o["kind"] for o in reg.opportunities())
    assert kinds == ["broken_link", "broken_link", "resource_page"], r.errors
    import json
    dead = sorted(json.loads(o["data_json"])["dead_url"] for o in reg.opportunities(kind="broken_link"))
    assert dead == sorted(["http://no-such-host-for-tests.invalid/", f"http://{me}/dead-guide"])


def test_broken_backlinks_are_verified(project, server):
    base, _ = server
    items = [
        {"url_from": base + "/links_to_comp_dead.html", "url_to": "http://127.0.0.2:9/old-guide", "anchor": "rental guide",
         "domain_from_rank": 55, "page_from_title": "Guides"},
        {"url_from": base + "/no_mention.html", "url_to": "http://127.0.0.2:9/old-guide", "anchor": "x",
         "domain_from_rank": 90, "page_from_title": "No longer links"},
    ]
    fake = FakeClient(post={"backlinks/backlinks/live": lambda t: [{"items": items}] if t["target"] == "127.0.0.2" else []})
    reg = Registry(project.db_path)
    ctx = Context(project, reg, client=fake)
    finders.find_broken(ctx)
    ctx.close()
    opps = reg.opportunities()
    assert len(opps) == 1 and opps[0]["url"] == base + "/links_to_comp_dead.html"  # the second no longer links
    import json
    d = json.loads(opps[0]["data_json"])
    assert d["dead_url"] == "http://127.0.0.2:9/old-guide" and d["competitor"] == "127.0.0.2"


def test_gap(project):
    def inter(task):
        a, b = task["targets"]["1"], task["targets"]["2"]
        assert task["exclude_targets"] == ["localhost"]
        return [{"items": [
            {"domain_intersection": {"1": {"target": "news-site.com", "rank": 71, "backlinks": 4},
                                     "2": {"target": "news-site.com", "rank": 71, "backlinks": 2}}},
            {"domain_intersection": {"1": {"target": "rival.example", "rank": 30}, "2": {"target": "rival.example"}}},
        ]}]
    fake = FakeClient(post={"backlinks/domain_intersection/live": inter})
    reg = Registry(project.db_path)
    ctx = Context(project, reg, client=fake)
    finders.find_gap(ctx)
    ctx.close()
    opps = reg.opportunities()
    assert [o["site"] for o in opps] == ["news-site.com"]  # competitors themselves are skipped
    assert "strength 71" in opps[0]["score_detail"]


def test_journalist_email_parsing(project):
    raw = (
        "From: Source of Sources <requests@sourceofsources.com>\r\nSubject: Today's requests\r\n"
        "Message-ID: <abc@sos>\r\nDate: Wed, 21 Oct 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
        "Header text for the digest\n-----\n"
        "1) Car rental tips for families\nOutlet: Travel Weekly\nDeadline: Oct 25\nEmail: jane@travelweekly.com\n"
        "Looking for car rental experts.\n-----\n"
        "2) Best knitting patterns\nOutlet: Craft Mag\nLooking for knitters.\n-----\n"
    ).encode()
    items = requests_from_email(raw, project)
    assert len(items) == 1
    p = items[0]
    assert p.title == "Car rental tips for families"
    assert p.data["outlet"] == "Travel Weekly" and p.data["deadline"] == "Oct 25"
    assert p.data["contacts"] == ["jane@travelweekly.com"]
    other = raw.replace(b"sourceofsources.com", b"newsletter.example")
    assert requests_from_email(other, project) == []


def test_split_requests_by_numbered_headings():
    text = "Intro line that is long enough to keep around here\n\n1. First request about car rental and more text here\nbody\n2. Second request about road trips and more text\nbody"
    chunks = split_requests(text)
    assert any(c.startswith("1. First") for c in chunks) and any(c.startswith("2. Second") for c in chunks)


def test_score_ranges():
    s, detail = score("unlinked_mention", strength=80, text="car rental", topics=["car rental"])
    assert s == 35 + 28 + 7 and "topics" in detail
    s, _ = score("journalist", strength=None, published=datetime.now(timezone.utc).isoformat())
    assert s == 30 + 10 + 10
    s, _ = score("resource_page", strength=10, outbound_sites=300)
    assert s == 10 + 4 - 10


def test_budget_cap(cfg):
    cfg.dataforseo_login, cfg.dataforseo_password = "x", "y"
    cfg.dataforseo_monthly_budget_usd = 1.0
    reg = Registry(cfg.db_path)
    reg.log_cost("dataforseo", "serp", 1.5)
    with pytest.raises(BudgetExceeded):
        Client(cfg).serp("anything")


def test_platform_tester(cfg, server):
    from linkverify.platform import test_platform
    base, _ = server
    s = test_platform(cfg, base + "/profile.html", "usersite.com")
    assert s["verdict"].startswith("Weak") and "nofollow ugc" in s["verdict"]
    assert s["rel_counts"] == {"nofollow ugc": 1, "followed": 1}
    s = test_platform(cfg, base + "/profile.html", None)
    assert "1 of 2 outbound links are followed" in s["verdict"]


def test_finders_run_on_schedule(project, server, monkeypatch):
    from linkverify.finders import finder_due
    reg = Registry(project.db_path)
    now = datetime.now(timezone.utc)
    assert finder_due(reg, project, "mentions", now)
    reg.set_meta("finder_last_run:mentions", (now - timedelta(hours=5)).isoformat())
    assert not finder_due(reg, project, "mentions", now)
    reg.set_meta("finder_last_run:gap", (now - timedelta(days=3)).isoformat())
    assert not finder_due(reg, project, "gap", now)
    assert finder_due(reg, project, "gap", now + timedelta(days=4))


def test_new_opportunities_are_alerted_once(project, server, monkeypatch):
    from linkverify import alerts, monitor
    base, _ = server
    project.google_alerts_feeds = [base + "/alerts.xml"]
    project.serp_mention_search = False
    project.daily_finders, project.weekly_finders = ["mentions"], []
    project.alert_min_score = 0
    project.email_smtp_host, project.email_to = "smtp.test", "me@test"
    sent = []
    monkeypatch.setattr(alerts, "send", lambda c, s, t: sent.append((s, t)) or ["email sent"])
    reg = Registry(project.db_path)
    monitor.run_monitor(project, reg, printer=lambda *_: None)
    assert len(sent) == 1 and "new opportunit" in sent[0][0]
    assert "Unlinked mention" in sent[0][1]
    monitor.run_monitor(project, reg, printer=lambda *_: None)
    assert len(sent) == 1  # nothing new, nothing re-sent
