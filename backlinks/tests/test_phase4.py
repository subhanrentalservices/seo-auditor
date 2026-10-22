"""Phase 4: Ahrefs DR/UR, drafts, campaign pickup tracking."""

import json
import threading
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest

from linkverify import ahrefs, cli, drafts, finders
from linkverify.campaigns import is_active, run_campaign
from linkverify.checks import Verifier
from linkverify.db import Registry
from linkverify.finders import Context, run_finders
from linkverify.monitor import run_monitor

from test_finders import FakeClient


@pytest.fixture
def project(cfg, server):
    base, me = server
    cfg.my_site = "localhost"
    cfg.brand_names = ["Acme Rentals"]
    cfg.topics = ["car rental", "road trip"]
    cfg.competitors = ["127.0.0.2", "rival.example"]
    cfg.my_pages = [f"http://{me}/page"]
    cfg.profile_name = "Alex Taylor"
    cfg.profile_company = "Acme Rentals"
    return cfg


class FakeAhrefs:
    """Replaces ahrefs._post: answers DR by site, UR by page, records batches."""

    def __init__(self, dr=None, ur=None):
        self.dr, self.ur, self.batches = dr or {}, ur or {}, []

    def __call__(self, cfg, targets):
        self.batches.append(targets)
        out = []
        for i, t in enumerate(targets):
            if t["mode"] == "domain":
                site = t["url"].removeprefix("https://")
                out.append({"index": i, "domain_rating": self.dr.get(site, 10), "url_rating": None})
            else:
                out.append({"index": i, "domain_rating": 50, "url_rating": self.ur.get(t["url"], 5)})
        return out


# ---------------------------------------------------------------- Ahrefs

def test_ahrefs_batches_and_caches(cfg, monkeypatch):
    cfg.ahrefs_api_key = "k"
    fake = FakeAhrefs(dr={"site7.org": 88})
    monkeypatch.setattr(ahrefs, "_post", fake)
    sites = [f"www.site{i}.org" for i in range(150)]
    m = ahrefs.metrics(cfg, sites=sites, pages=["https://site7.org/post"])
    assert [len(b) for b in fake.batches] == [100, 51]  # 150 sites + 1 page, 100 per call
    assert m["site:site7.org"]["dr"] == 88 and m["page:https://site7.org/post"]["ur"] == 5
    again = ahrefs.metrics(cfg, sites=sites[:3], pages=["https://site7.org/post"])
    assert len(fake.batches) == 2 and again["site:site0.org"]["dr"] == 10  # served from the cache
    cfg.ahrefs_cache_days = 0
    ahrefs.metrics(cfg, sites=sites[:1])
    assert len(fake.batches) == 3  # cache expired


def test_ahrefs_strength():
    assert ahrefs.strength(None, None) is None
    assert ahrefs.strength(90, None) == 90
    assert ahrefs.strength(None, 20) == 20
    assert ahrefs.strength(90, 20) == 69.0


def test_ahrefs_no_key_does_nothing(cfg, monkeypatch):
    monkeypatch.setattr(ahrefs, "_post", lambda *a: pytest.fail("called without a key"))
    assert ahrefs.metrics(cfg, sites=["a.com"]) == {}


def test_check13_shows_dr_and_ur(cfg, server, monkeypatch):
    base, me = server
    cfg.ahrefs_api_key = "k"
    monkeypatch.setattr(ahrefs, "_post", FakeAhrefs(dr={"127.0.0.1": 91}, ur={base + "/good.html": 34}))
    v = Verifier(cfg)
    res = v.verify(base + "/good.html", "localhost")
    v.close()
    assert res["verdict"] == "Counts"
    assert res["domain_rating"] == 91 and res["url_rating"] == 34
    c13 = res["checks"][12]
    assert "DR of 127.0.0.1: 91" in c13["detail"] and "UR of this page: 34" in c13["detail"]


def test_check13_ahrefs_error_is_a_note(cfg, server, monkeypatch):
    base, _ = server
    cfg.ahrefs_api_key = "k"

    def boom(cfg, targets):
        raise RuntimeError("Ahrefs API returned 401: bad key")
    monkeypatch.setattr(ahrefs, "_post", boom)
    v = Verifier(cfg)
    res = v.verify(base + "/good.html", "localhost")
    v.close()
    assert res["verdict"] == "Counts" and res["domain_rating"] is None
    assert any("401" in n for n in res["notes"])


def test_opportunity_scores_use_ahrefs(project, server, monkeypatch):
    base, _ = server
    project.ahrefs_api_key = "k"
    project.google_alerts_feeds = [base + "/alerts.xml"]
    project.serp_mention_search = False
    monkeypatch.setattr(ahrefs, "_post", FakeAhrefs(dr={"127.0.0.1": 80}, ur={base + "/mention_nolink.html": 30}))
    reg = Registry(project.db_path)
    ctx = Context(project, reg)
    finders.find_mentions(ctx)
    ctx.close()
    d = json.loads(reg.opportunities()[0]["data_json"])
    assert d["strength_source"] == "Ahrefs DR/UR" and d["ahrefs_dr"] == 80 and d["ahrefs_ur"] == 30
    assert d["strength"] == 65.0


# ---------------------------------------------------------------- drafts

def _opp(reg, base, kind="unlinked_mention", url=None, data=None):
    oid, _ = reg.upsert_opportunity(f"k-{kind}-{url}", kind, url or base + "/article_author.html", "Best rental companies",
                                    "127.0.0.1", 70, "", data or {"brand": "Acme Rentals", "context": "Acme Rentals is a nice company."})
    return oid


def test_contacts_from_page_and_contact_page(cfg, server):
    base, _ = server
    c = drafts.find_contacts(cfg, base + "/article_author.html")
    assert c["author"] == "Jane Writer"
    assert c["emails"] == ["jane@newsdesk.org", "tips@newsdesk.org"]  # noreply and image names are dropped
    assert c["contact_pages"][0] == base + "/contact.html"


def test_template_draft_is_saved_and_never_invents(project, server):
    base, _ = server
    reg = Registry(project.db_path)
    oid = _opp(reg, base)
    d = drafts.make_draft(project, reg, oid)
    assert d["source"] == "template" and d["to"] == "jane@newsdesk.org"
    assert d["body"].startswith("Hi Jane,") and "Acme Rentals" in d["body"] and "Alex Taylor" in d["body"]
    assert d["mailto"].startswith("mailto:jane@newsdesk.org?subject=Thanks%20for%20mentioning")
    assert drafts.stored_draft(reg, oid)["subject"] == d["subject"]
    # a broken-link draft keeps what it can't know as a placeholder
    bid = _opp(reg, base, "broken_link", base + "/resources.html",
               {"dead_url": "https://dead.example/x", "dead_status": "404", "anchor": "car rental checklist"})
    b = drafts.make_draft(project, reg, bid, lookup_contacts=False)
    assert "https://dead.example/x" in b["body"] and "404" in b["body"]
    assert b["placeholders"] == ["[ONE SENTENCE: WHAT YOUR PAGE COVERS THAT THE DEAD ONE DID]"]


def test_journalist_draft_uses_request_contacts(project, server):
    reg = Registry(project.db_path)
    oid, _ = reg.upsert_opportunity("j1", "journalist", "email:<m1>", "Car rental tips for summer", "", 60, "",
                                    {"request": "Looking for car rental owners to share summer tips.", "outlet": "Travel Weekly",
                                     "deadline": "Friday 5pm", "contacts": ["writer@travelweekly.com"], "subject": "Summer tips"})
    d = drafts.make_draft(project, reg, oid)
    assert d["to"] == "writer@travelweekly.com" and d["subject"] == "Re: Summer tips"
    assert "Travel Weekly" in d["body"] and any("YOUR ANSWER" in p for p in d["placeholders"])
    assert any("Friday 5pm" in t for t in d["tips"])


def test_ai_draft(project, server, monkeypatch):
    base, _ = server
    project.anthropic_api_key = "sk-test"
    seen = {}

    class Resp:
        status_code = 200
        text = ""

        def json(self):
            return {"content": [{"type": "text", "text": '```json\n{"subject": "Thanks, Jane", "body": "Hi Jane, thanks. [YOUR NAME]"}\n```'}]}

    def fake_post(url, headers=None, json=None, timeout=None):
        seen.update(url=url, headers=headers, payload=json)
        return Resp()
    monkeypatch.setattr(drafts.httpx, "post", fake_post)
    reg = Registry(project.db_path)
    oid = _opp(reg, base)
    d = drafts.make_draft(project, reg, oid, use_ai=True)
    assert d["source"] == "ai" and d["subject"] == "Thanks, Jane" and d["placeholders"] == ["[YOUR NAME]"]
    assert seen["url"] == "https://api.anthropic.com/v1/messages"
    assert seen["headers"]["anthropic-version"] == "2026-10-21" and seen["headers"]["x-api-key"] == "sk-test"
    p = seen["payload"]
    assert p["model"] == "claude-sonnet-5-5" and "temperature" not in p
    assert "ONLY facts" in p["system"]
    sent = json.loads(p["messages"][0]["content"])
    assert sent["me"]["name"] == "Alex Taylor" and sent["their_page"]["author"] == "Jane Writer"


def test_ai_failure_falls_back_to_template(project, server, monkeypatch):
    base, _ = server
    project.anthropic_api_key = "sk-test"

    class Bad:
        status_code = 529
        text = "overloaded"
    monkeypatch.setattr(drafts.httpx, "post", lambda *a, **k: Bad())
    reg = Registry(project.db_path)
    d = drafts.make_draft(project, reg, _opp(reg, base), use_ai=True)
    assert d["source"] == "template" and "529" in d["notes"][0]


# ---------------------------------------------------------------- campaigns

def _campaign_fake(base, me):
    def backlinks(task):
        assert task["target"] == f"http://{me}/study"
        assert task["filters"][0] == "first_seen" and task["filters"][1] == ">"
        return [{"items": [{"url_from": base + "/study_link.html", "page_from_title": "News", "is_lost": False},
                           {"url_from": base + "/gone.html", "is_lost": True}]}]
    serp = {'"car rental prices rose 18%" -site:localhost': [
        {"url": base + "/study_link.html", "title": "News"},
        {"url": base + "/study_mention.html", "title": "Mention"},
        {"url": base + "/study_stale.html", "title": "Stale"},
        {"url": base + "/study_home_link.html", "title": "Home link"},
    ]}
    return FakeClient(serp=serp, post={"backlinks/backlinks/live": backlinks})


def test_campaign_pickups(project, server):
    base, me = server
    reg = Registry(project.db_path)
    cid = reg.add_campaign("Price study", f"http://{me}/study", ["car rental prices rose 18%"], date.today().isoformat())
    fake = _campaign_fake(base, me)
    res, out = run_campaign(project, reg, cid, client=fake)
    assert not res.errors, res.errors
    pk = {p["url"].rsplit("/", 1)[1]: p for p in reg.pickups(cid)}
    assert set(pk) == {"study_link.html", "study_mention.html", "study_home_link.html"}  # lost and stale skipped
    assert pk["study_link.html"]["kind"] == "linked" and pk["study_home_link.html"]["kind"] == "linked"
    assert pk["study_mention.html"]["kind"] == "mention" and pk["study_mention.html"]["opp_id"]
    links = {r["source_url"]: r for r in reg.all()}
    assert links[base + "/study_link.html"]["target"] == f"http://{me}/study"
    assert links[base + "/study_home_link.html"]["target"] == "localhost"
    assert links[base + "/study_link.html"]["strategy"] == "digital PR: Price study"
    opp = reg.opportunity(pk["study_mention.html"]["opp_id"])
    d = json.loads(opp["data_json"])
    assert opp["kind"] == "unlinked_mention" and d["campaign"] == "Price study" and d["suggested_page"] == f"http://{me}/study"
    assert len(out["linked"]) == 2 and len(out["mentions"]) == 1
    # a second run adds nothing twice
    res2, out2 = run_campaign(project, reg, cid, client=fake)
    assert out2 == {"linked": [], "mentions": []} and len(reg.pickups(cid)) == 3
    st = reg.campaign_stats(cid)
    assert st["linked"] == 2 and st["mentions"] == 1 and st["sites"] == 1
    assert reg.campaign(cid)["last_checked"]


def test_campaign_finder_skips_ended_campaigns(project, server):
    base, me = server
    reg = Registry(project.db_path)
    old = (date.today() - timedelta(days=400)).isoformat()
    reg.add_campaign("Old study", f"http://{me}/study", ["car rental prices rose 18%"], old)
    assert not is_active(reg.campaigns()[0], project.campaign_active_days)
    fake = _campaign_fake(base, me)
    r = run_finders(project, reg, ["campaigns"], client=fake)[0]
    assert fake.calls == [] and "No active campaigns" in r.notes[0]


def test_monitor_checks_campaign_links_same_run(project, server, monkeypatch):
    base, me = server
    project.dataforseo_login, project.dataforseo_password = "u", "p"
    fake = _campaign_fake(base, me)
    monkeypatch.setattr(finders, "Client", lambda cfg: fake)
    project.daily_finders, project.weekly_finders = [], ["campaigns"]
    reg = Registry(project.db_path)
    reg.add_campaign("Price study", f"http://{me}/study", ["car rental prices rose 18%"], date.today().isoformat())
    lines = []
    s = run_monitor(project, reg, now=datetime.now(timezone.utc), printer=lines.append, send_alerts=False)
    assert s.checked == 2, lines  # both new linking pages were checked in the same run
    v = {r["source_url"].rsplit("/", 1)[1]: r["last_verdict"] for r in reg.all()}
    assert v["study_link.html"] == "Counts"
    assert v["study_home_link.html"] == "Not counted"  # links to your home page, which is a 404 on the test server


# ---------------------------------------------------------------- dashboard + CLI


def test_cli_campaign_and_draft(project, server, tmp_path, capsys, monkeypatch):
    base, me = server
    conf = tmp_path / "config.toml"
    conf.write_text(f'[general]\ndata_dir = "{project.data_dir.as_posix()}"\ndelay_seconds = 0\nrender = false\n'
                    f'[project]\nsite = "localhost"\nbrand_names = ["Acme Rentals"]\n[profile]\nname = "Alex Taylor"\n', encoding="utf-8")
    assert cli.main(["--config", str(conf), "campaign", "add", "--name", "Study", "--asset", f"http://{me}/study",
                     "--phrase", "car rental prices rose 18%", "--started", "2026-10-01"]) == 0
    assert cli.main(["--config", str(conf), "campaign", "list"]) == 0
    assert "Study" in capsys.readouterr().out
    assert cli.main(["--config", str(conf), "campaign", "add", "--name", "x", "--asset", "http://a.com", "--started", "bad"]) == 2
    reg = Registry(project.db_path)
    oid = _opp(reg, base)
    assert cli.main(["--config", str(conf), "draft", str(oid)]) == 0
    out = capsys.readouterr().out
    assert "Nothing has been sent" in out and "jane@newsdesk.org" in out and "Thanks for mentioning Acme Rentals" in out
    assert cli.main(["--config", str(conf), "draft", "999"]) == 2
