import pytest

from linkverify.checks import COUNTS, NOT_COUNTED, PENDING, WEAK, Verifier
from linkverify.domains import TargetMatcher, site_of


def run(cfg, server, path, target=None):
    base, me = server
    v = Verifier(cfg)
    try:
        return v.verify(base + path, target or me.split(":")[0], None)
    finally:
        v.close()


def status(res, num):
    return next(c for c in res["checks"] if c["num"] == num)["status"]


@pytest.mark.parametrize("path,verdict,failing", [
    ("/good.html", COUNTS, None),
    ("/base.html", COUNTS, None),
    ("/image.html", COUNTS, None),
    ("/mixed.html", COUNTS, None),          # a followed copy of the link exists
    ("/canon_ok.html", COUNTS, None),
    ("/old.html", COUNTS, None),            # same-site redirect: warn only
    ("/header_otherbot.html", COUNTS, None),
    ("/blocked/open", COUNTS, None),        # Allow ... $ beats Disallow /blocked/
    ("/nofollow.html", WEAK, 6),
    ("/ugc.html", WEAK, 6),
    ("/sponsored.html", WEAK, 6),
    ("/meta_nofollow.html", WEAK, 7),
    ("/many.html", WEAK, 13),
    ("/wrapped.html", WEAK, 5),             # link through a click-tracking redirect
    ("/wrapped_blocked.html", NOT_COUNTED, 5),  # ...whose redirect is blocked by robots.txt
    ("/missing.html", NOT_COUNTED, 3),
    ("/jsvoid.html", NOT_COUNTED, 5),
    ("/datahref.html", NOT_COUNTED, 5),
    ("/meta_noindex.html", NOT_COUNTED, 7),
    ("/meta_none.html", NOT_COUNTED, 7),
    ("/header_noindex.html", NOT_COUNTED, 8),
    ("/blocked/page.html", NOT_COUNTED, 9),
    ("/canon_other.html", NOT_COUNTED, 10),
    ("/target404.html", NOT_COUNTED, 11),
    ("/target_noindex.html", NOT_COUNTED, 11),
    ("/hidden.html", NOT_COUNTED, 12),
    ("/gone.html", NOT_COUNTED, 1),
    ("/offsite.html", NOT_COUNTED, 2),
])
def test_verdicts(cfg, server, path, verdict, failing):
    res = run(cfg, server, path)
    assert res["verdict"] == verdict, res["reasons"]
    if failing:
        assert status(res, failing) in ("fail", "warn")
    assert len(res["checks"]) == 15


def test_redirecting_target_page_is_a_warning(cfg, server):
    res = run(cfg, server, "/target_redirect.html")
    assert res["verdict"] == COUNTS
    assert status(res, 11) == "warn"


def test_link_details_recorded(cfg, server):
    res = run(cfg, server, "/good.html")
    assert res["link"]["anchor_text"] == "great tool"
    assert "Some text before" in res["link"]["context"]
    assert res["outbound_sites"] == 1  # localhost is the only other site


def test_mention_without_link_is_reported(cfg, server):
    res = run(cfg, server, "/missing.html")
    assert "plain text" in next(c for c in res["checks"] if c["num"] == 3)["detail"]


def test_exact_url_target(cfg, server):
    base, me = server
    assert run(cfg, server, "/good.html", f"http://{me}/page")["verdict"] == COUNTS
    assert run(cfg, server, "/good.html", f"http://{me}/other")["verdict"] == NOT_COUNTED


def test_index_unchecked_note(cfg, server):
    res = run(cfg, server, "/good.html")
    assert status(res, 14) == "skip"
    assert any("Index status not checked" in n for n in res["notes"])


def test_pending_when_not_seen_in_google(cfg, server, monkeypatch):
    from linkverify import integrations
    monkeypatch.setattr(integrations, "dataforseo_seen_in_google", lambda c, u: (False, "not seen in Google results"))
    assert run(cfg, server, "/good.html")["verdict"] == PENDING
    # a weak link stays weak even when not indexed
    assert run(cfg, server, "/nofollow.html")["verdict"] == WEAK


def test_rendered_checks(cfg, server):
    pytest.importorskip("playwright")
    cfg.render = True
    res = run(cfg, server, "/injected.html")
    assert res["verdict"] == COUNTS, res["reasons"]
    assert status(res, 3) == "warn" and status(res, 4) == "warn"
    res = run(cfg, server, "/hidden_css.html")  # hidden by a stylesheet, only visible in a browser
    assert res["verdict"] == NOT_COUNTED and status(res, 12) == "fail"
    res = run(cfg, server, "/good.html")
    assert res["verdict"] == COUNTS and status(res, 4) == "pass" and status(res, 12) == "pass"


def test_platform_subdomains_are_separate_sites():
    assert site_of("https://you.blogspot.com/post") == "you.blogspot.com"
    assert site_of("https://me.github.io/") == "me.github.io"
    assert site_of("https://blog.example.co.uk/x") == "example.co.uk"
    m = TargetMatcher("you.blogspot.com")
    assert m.matches("https://you.blogspot.com/a")
    assert not m.matches("https://other.blogspot.com/a")


def test_unwrap():
    from linkverify.parse import unwrap
    assert unwrap("https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&h=AT0") == "https://example.com/a?b=1"
    assert unwrap("https://www.google.com/url?sa=t&url=https://example.com/") == "https://example.com/"
    assert unwrap("https://l.instagram.com/?u=https%3A%2F%2Fl.facebook.com%2Fl.php%3Fu%3Dhttps%253A%252F%252Fex.com") == "https://ex.com"
    assert unwrap("https://example.com/search?q=cars") is None
