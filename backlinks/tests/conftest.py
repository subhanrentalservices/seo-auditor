"""A local web server with one page per pass/fail case.

Pages are served from 127.0.0.1; "your site" is localhost (same server, a
different host name), so links to http://localhost:PORT/... are links to the
target and links to 127.0.0.1 are internal links of the linking site.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from linkverify.config import Config


def pages(port: int) -> dict[str, tuple[int, dict, str]]:
    me = f"http://localhost:{port}"
    good = f'<a href="{me}/page">great tool</a>'
    wrap = lambda body, head="": f"<!doctype html><html><head><title>t</title>{head}</head><body><p>Some text before. {body} Some text after.</p></body></html>"
    many = "".join(f'<a href="https://site{i}.org/">s{i}</a>' for i in range(120))
    return {
        "/robots.txt": (200, {"Content-Type": "text/plain"}, "User-agent: *\nDisallow: /blocked/\nAllow: /blocked/open$\n\nUser-agent: Googlebot-Image\nDisallow: /\n"),
        "/good.html": (200, {}, wrap(good)),
        "/base.html": (200, {}, wrap('<a href="page">relative</a>', head=f'<base href="{me}/">')),
        "/nofollow.html": (200, {}, wrap(f'<a href="{me}/page" rel="nofollow">x</a>')),
        "/ugc.html": (200, {}, wrap(f'<a href="{me}/page" rel="ugc nofollow">x</a>')),
        "/sponsored.html": (200, {}, wrap(f'<a href="{me}/page" rel="sponsored">x</a>')),
        "/mixed.html": (200, {}, wrap(f'<a href="{me}/page" rel="nofollow">a</a> and {good}')),
        "/missing.html": (200, {}, wrap("We love localhost tools but give no link.")),
        "/jsvoid.html": (200, {}, wrap(f'<a href="javascript:void(0)" onclick="location=\'{me}/page\'">go</a>')),
        "/datahref.html": (200, {}, wrap(f'<span data-href="{me}/page">go</span>')),
        "/injected.html": (200, {}, wrap(f'<span id="x"></span><script>var a=document.createElement("a");a.href="{me}/page";a.textContent="js link";document.getElementById("x").appendChild(a);</script>')),
        "/meta_noindex.html": (200, {}, wrap(good, head='<meta name="robots" content="noindex, follow">')),
        "/meta_nofollow.html": (200, {}, wrap(good, head='<meta name="googlebot" content="nofollow">')),
        "/meta_none.html": (200, {}, wrap(good, head='<meta name="robots" content="none">')),
        "/header_noindex.html": (200, {"X-Robots-Tag": "noindex"}, wrap(good)),
        "/header_otherbot.html": (200, {"X-Robots-Tag": "bingbot: noindex"}, wrap(good)),
        "/blocked/page.html": (200, {}, wrap(good)),
        "/blocked/open": (200, {}, wrap(good)),
        "/canon_other.html": (200, {}, wrap(good, head=f'<link rel="canonical" href="http://127.0.0.1:{port}/canon_target_nolink.html">')),
        "/canon_target_nolink.html": (200, {}, wrap("no link here")),
        "/canon_ok.html": (200, {}, wrap(good, head=f'<link rel="canonical" href="http://127.0.0.1:{port}/good.html">')),
        "/hidden.html": (200, {}, wrap(f'<div style="display:none">{good}</div>')),
        "/hidden_css.html": (200, {}, wrap(f'<span class="h">{good}</span>', head="<style>.h{display:none}</style>")),
        "/target404.html": (200, {}, wrap(f'<a href="{me}/missing-page">x</a>')),
        "/target_noindex.html": (200, {}, wrap(f'<a href="{me}/noindex-page">x</a>')),
        "/target_redirect.html": (200, {}, wrap(f'<a href="{me}/old-page">x</a>')),
        "/many.html": (200, {}, wrap(good + many)),
        "/gone.html": (404, {}, "not found"),
        "/old.html": (301, {"Location": "/good.html"}, ""),
        "/offsite.html": (302, {"Location": f"{me}/page"}, ""),
        "/image.html": (200, {}, wrap(f'<a href="{me}/page"><img src="x.png" alt="Our logo"></a>')),
        # Phase 3 finder pages
        "/mention_nolink.html": (200, {}, wrap("We rented from Acme Rentals for our car rental road trip. Great service.")),
        "/mention_link.html": (200, {}, wrap(f'Acme Rentals is great: <a href="{me}/">Acme Rentals</a>')),
        "/no_mention.html": (200, {}, wrap("Nothing about the brand here.")),
        "/alerts.xml": (200, {"Content-Type": "application/atom+xml"},
                        '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Google Alert - Acme</title>'
                        f'<entry><title type="html">&lt;b&gt;Acme&lt;/b&gt; Rentals review</title><link href="https://www.google.com/url?rct=j&amp;sa=t&amp;url=http://127.0.0.1:{port}/mention_nolink.html&amp;ct=ga"/><published>2026-10-20T08:00:00Z</published></entry>'
                        f'<entry><title type="html">Linked</title><link href="https://www.google.com/url?rct=j&amp;url=http://127.0.0.1:{port}/mention_link.html&amp;ct=ga"/><published>2026-10-20T08:00:00Z</published></entry>'
                        f'<entry><title type="html">None</title><link href="https://www.google.com/url?url=http://127.0.0.1:{port}/no_mention.html"/></entry>'
                        "</feed>"),
        "/resources.html": (200, {}, "<html><head><title>Car rental resources</title></head><body><ul>"
                            f'<li><a href="{me}/page">live tool</a></li><li><a href="{me}/dead-guide">car rental checklist</a></li>'
                            '<li><a href="http://no-such-host-for-tests.invalid/">old road trip planner</a></li></ul></body></html>'),
        "/links_to_comp_dead.html": (200, {}, wrap('See <a href="http://127.0.0.2:9/old-guide">rental guide</a>.')),
        "/profile.html": (200, {}, wrap('<a href="https://usersite.com/" rel="nofollow ugc">My site</a> '
                                        '<a href="https://platform-blog.com/">Blog</a>')),
        # links through click-tracking redirects (like l.facebook.com/l.php?u=...)
        "/wrapped.html": (200, {}, wrap(f'<a href="http://127.0.0.1:{port}/out?u=http%3A%2F%2Flocalhost%3A{port}%2Fpage&h=x">site</a>')),
        "/wrapped_blocked.html": (200, {}, wrap(f'<a href="/blocked/l.php?u=http%3A%2F%2Flocalhost%3A{port}%2Fpage">site</a>')),
        # Phase 4: contacts and campaign pickups
        "/article_author.html": (200, {}, wrap('Acme Rentals is a nice company. <a href="mailto:jane@newsdesk.org">Email Jane</a> '
                                               '<a href="/contact.html">Contact us</a> <img src="logo@2x.png">',
                                               head='<meta name="author" content="Jane Writer">')),
        "/contact.html": (200, {}, wrap("Send tips to tips@newsdesk.org or noreply@newsdesk.org.")),
        "/study_link.html": (200, {}, wrap(f'A new study says car rental prices rose 18% this year (<a href="{me}/study">source</a>).')),
        "/study_mention.html": (200, {}, wrap("Reports show car rental prices rose 18% this year, says Acme Rentals.")),
        "/study_stale.html": (200, {}, wrap("This page no longer talks about it.")),
        "/study_home_link.html": (200, {}, wrap(f'Car rental prices rose 18%, according to <a href="{me}/">Acme</a>.')),
        # your site's pages
        "/page": (200, {}, wrap("your page")),
        "/study": (200, {}, wrap("Our 2026 car rental price study.")),
        "/noindex-page": (200, {}, wrap("x", head='<meta name="robots" content="noindex">')),
        "/old-page": (301, {"Location": "/page"}, ""),
    }


class _Handler(BaseHTTPRequestHandler):
    routes: dict = {}

    def log_message(self, *a):  # keep test output quiet
        pass

    def do_GET(self):
        status, headers, body = self.routes.get(self.path, (404, {}, "not found"))
        data = body.encode()
        self.send_response(status)
        if "Content-Type" not in headers:
            self.send_header("Content-Type", "text/html; charset=utf-8")
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(scope="session")
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    port = srv.server_address[1]
    _Handler.routes = pages(port)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}", f"localhost:{port}"
    srv.shutdown()


@pytest.fixture
def cfg(tmp_path):
    return Config(data_dir=tmp_path / "data", delay_seconds=0, render=False, timeout_seconds=5, use_tranco=False)
