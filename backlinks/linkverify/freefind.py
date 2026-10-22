"""Free ways to find links: no paid data, no accounts, no email.

listings   free business listings and profiles you can create yourself (directories,
           maps, your own social profiles). You sign up; the tool only verifies the link.
partners   sites your competitors link to from their own pages: associations, suppliers,
           sponsors, insurers. These often list members or partners with a link.
scan       "Check a page": paste any page and see whether it links to you, mentions you
           without a link, or has dead links you could offer to replace.

Read-only like everything else: public pages are read; nothing is posted or sent.
"""

from __future__ import annotations

import re
from collections import defaultdict
from urllib.parse import urljoin, urlsplit

from . import parse
from .domains import TargetMatcher, normalize_url, site_of
from .finders import (Context, FinderResult, Pending, _dead, _key, page_title, snippet, visible_text, wayback)
from .score import topic_hits

# --------------------------------------------------------------------------
# free listings
# --------------------------------------------------------------------------
# (name, site, where to start, note). Sites are checked against your links, so a
# listing you already have is not suggested again. verify=False: the listing lives
# inside an app or map and cannot be checked by reading a web page.
LISTINGS_ANY = [
    ("Google Business Profile", "google.com", "https://www.google.com/business/",
     "The most important free listing for a local business: it puts you on Google Maps. Add your website in the profile.", False),
    ("Bing Places", "bingplaces.com", "https://www.bingplaces.com/",
     "Bing and Microsoft maps. You can import your Google profile in a few clicks.", False),
    ("Apple Business Connect", "businessconnect.apple.com", "https://businessconnect.apple.com/",
     "Apple Maps and Siri. Free.", False),
    ("Brownbook", "brownbook.net", "https://www.brownbook.net/business/add/",
     "Free worldwide business directory with a website field.", True),
    ("Cylex", "cylex.net", "https://www.cylex.net/",
     "Free business directory in many countries. Pick your country's site.", True),
    ("Foursquare", "foursquare.com", "https://foursquare.com/",
     "Its place data feeds many apps and maps. Claim or add your business for free.", True),
]
LISTINGS_AU = [
    ("Yelp Australia", "yelp.com.au", "https://biz.yelp.com.au/",
     "Free business page. Do not buy ads; the free page is enough.", True),
    ("True Local", "truelocal.com.au", "https://www.truelocal.com.au/",
     "Australian directory with reviews. Free basic listing.", True),
    ("Yellow Pages Australia", "yellowpages.com.au", "https://www.yellowpages.com.au/",
     "Look for the free listing option; paid upgrades are not needed.", True),
    ("StartLocal", "startlocal.com.au", "https://www.startlocal.com.au/",
     "Australian directory with a free listing and website link.", True),
    ("Hotfrog Australia", "hotfrog.com.au", "https://www.hotfrog.com.au/",
     "Free business profile with a website link.", True),
    ("Word of Mouth", "wordofmouth.com.au", "https://www.wordofmouth.com.au/",
     "Australian review site. Free business page.", True),
    ("PureLocal", "purelocal.com.au", "https://www.purelocal.com.au/",
     "Australian directory with a free listing.", True),
    ("Localsearch", "localsearch.com.au", "https://www.localsearch.com.au/",
     "Australian directory. Use the free listing only.", True),
    ("Pink Pages", "pinkpages.com.au", "https://www.pinkpages.com.au/",
     "Australian directory with a free listing.", True),
    ("dLook", "dlook.com.au", "https://www.dlook.com.au/",
     "Australian directory with a free listing.", True),
    ("Cylex Australia", "cylex-australia.com", "https://www.cylex-australia.com/",
     "The Australian Cylex site.", True),
]
COUNTRY_LISTINGS = {"au": LISTINGS_AU}

SOCIAL = {"facebook.com": "Facebook", "instagram.com": "Instagram", "linkedin.com": "LinkedIn", "x.com": "X",
          "twitter.com": "X", "youtube.com": "YouTube", "tiktok.com": "TikTok", "pinterest.com": "Pinterest"}
SOCIAL_HOW = {
    "Instagram": "Open Instagram, Edit profile, Links, and add your website.",
    "Facebook": "Open your Facebook page, Edit details (About), and fill in Website.",
    "LinkedIn": "Edit your LinkedIn company page and fill in Website URL.",
    "X": "Edit profile on X and fill in Website.",
    "YouTube": "YouTube Studio, Customisation, Basic info, Links: add your website.",
    "TikTok": "Edit profile on TikTok and add your website (business accounts).",
    "Pinterest": "Pinterest settings, Claim your website, and add it to your profile.",
}


def country_of(cfg) -> str:
    """Two-letter country for listings, from the search country or the address."""
    by_code = {2036: "au", 2554: "nz", 2826: "uk", 2840: "us", 2124: "ca", 2586: "pk", 2356: "in", 2784: "ae"}
    if cfg.dataforseo_location_code in by_code and cfg.dataforseo_location_code != 2840:
        return by_code[cfg.dataforseo_location_code]
    tld = site_of(cfg.my_site or "").rsplit(".", 1)[-1]
    return {"uk": "uk"}.get(tld, tld if len(tld) == 2 else "us")


def _social_profiles(ctx: Context) -> dict[str, str]:
    """Social profiles your home page links to: {platform: url}."""
    if not ctx.cfg.my_site:
        return {}
    home = ctx.fetcher.get(f"https://{ctx.cfg.my_site}/")
    if not home.ok:
        return {}
    soup = parse.soup_of(home.text)
    out: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href.startswith("http"):
            continue
        s = site_of(href)
        for key, name in SOCIAL.items():
            if s == key and urlsplit(href).path.strip("/") and "/share" not in href and "sharer" not in href:
                out.setdefault(name, href.split("?")[0])
    return out


def find_listings(ctx: Context) -> FinderResult:
    cfg, reg = ctx.cfg, ctx.reg
    res = FinderResult("listings")
    if not cfg.my_site:
        res.errors.append("Add your website first.")
        return res
    have = {site_of(r["source_url"]) for r in reg.all()}
    country = country_of(cfg)
    pending: list[Pending] = []
    for name, site, start, note, verify in COUNTRY_LISTINGS.get(country, []) + LISTINGS_ANY:
        key = _key("listing", site)
        if site in have or any(h.endswith("." + site) for h in have):
            continue
        how = (f"Create a free listing on {name} yourself, with your website address in it. {note} "
               + ("When it is live, paste the listing's address under Got the link? and the tool checks the link for you."
                  if verify else "This listing lives inside a map app, so the tool cannot check it; mark it Won when done."))
        pending.append(Pending("listing", key, start, f"Free listing: {name}", site, text=" ".join(cfg.topics),
                               data={"how": how, "verify": verify, "listing": name,
                                     "note": "Most directory links are nofollow. They help local search (maps) and trust more than ranking power, and they take minutes."}))
    for platform, url in _social_profiles(ctx).items():
        site = site_of(url)
        key = _key("social", normalize_url(url))
        if normalize_url(url) in {normalize_url(r["source_url"]) for r in reg.all()}:
            continue
        pending.append(Pending("profile", key, url, f"Add your website to your {platform} profile", site,
                               data={"how": f"Your site links to your {platform} profile, but make sure the profile links back. "
                                            f"{SOCIAL_HOW.get(platform, '')} Then add the profile under Got the link? to keep an eye on it.",
                                     "platform": platform,
                                     "note": f"{platform} may block automatic checks; if the check can't read it, look at the profile yourself."}))
    for p in pending:
        p.strength = None
    ctx.save_all(pending, res)
    if not pending:
        res.notes.append("You already have every listing on the list.")
    return res


# --------------------------------------------------------------------------
# competitor partners
# --------------------------------------------------------------------------
NOT_PARTNERS = {
    "google.com", "goo.gl", "googleapis.com", "gstatic.com", "googletagmanager.com", "google-analytics.com", "g.page",
    "apple.com", "microsoft.com", "w3.org", "schema.org", "wordpress.org", "wordpress.com", "wix.com", "wixsite.com",
    "squarespace.com", "shopify.com", "weebly.com", "godaddy.com", "cloudflare.com", "jquery.com", "bootstrapcdn.com",
    "jsdelivr.net", "unpkg.com", "fontawesome.com", "gravatar.com", "bit.ly", "linktr.ee", "wa.me", "whatsapp.com",
    "paypal.com", "stripe.com", "afterpay.com", "zip.co", "openstreetmap.org", "elfsight.com", "trustindex.io",
    "hotjar.com", "facebook.net", "doubleclick.net", "youtu.be", "vimeo.com", "spotify.com", "calendly.com",
    "mailchimp.com", "list-manage.com", "recaptcha.net", "adobe.com", "creativecommons.org", "tawk.to",
} | set(SOCIAL)
CREDIT = re.compile(r"\b(web\s*site|web)\s*(design|by|developed|built)|\b(designed|developed|built|powered|made|seo)\s+by\b|digital agency|marketing by", re.I)
PARTNER_PAGES = re.compile(r"partner|sponsor|member|associat|accredit|affiliat|supplier|award|communit|friends|links|resource|about|insur", re.I)


def _outbound(html: str, url: str) -> list[tuple[str, str]]:
    """(href, anchor or nearby text) for links to other sites, skipping designer credits."""
    soup = parse.soup_of(html)
    base = parse.base_url(soup, url)
    me = site_of(url)
    out = []
    for a in soup.find_all("a", href=True):
        u = urljoin(base, a["href"].strip())
        if not u.startswith(("http://", "https://")) or site_of(u) == me:
            continue
        anchor = " ".join(a.get_text(" ", strip=True).split())[:120]
        if not anchor and a.find("img"):
            anchor = (a.find("img").get("alt") or "")[:120]
        around = " ".join((a.parent.get_text(" ", strip=True) if a.parent else "").split())[:200]
        if CREDIT.search(anchor or "") or CREDIT.search(around):
            continue
        out.append((u, anchor or ""))
    return out


def find_partners(ctx: Context) -> FinderResult:
    cfg, reg = ctx.cfg, ctx.reg
    res = FinderResult("partners")
    comps = [site_of(c) for c in cfg.competitors if site_of(c)][:8]
    if not comps:
        res.errors.append("Add a few competitors in Settings, Your website. The tool reads their sites to see who they partner with.")
        return res
    mine = site_of(cfg.my_site or "")
    linked = reg.linked_sites() | {site_of(r["source_url"]) for r in reg.all()}
    agg: dict[str, dict] = defaultdict(lambda: {"comps": set(), "where": [], "url": "", "anchor": ""})
    read = 0
    for comp in comps:
        ctx.progress(f"Reading {comp}")
        if not ctx.take_page():
            res.notes.append("Page limit for this run reached.")
            break
        home = ctx.fetcher.get(f"https://{comp}/")
        if not home.ok:
            res.notes.append(f"{comp} could not be read ({home.status or home.error}).")
            continue
        read += 1
        pages = [(home.final_url, home.text)]
        soup = parse.soup_of(home.text)
        base = parse.base_url(soup, home.final_url)
        extra = []
        for a in soup.find_all("a", href=True):
            u = urljoin(base, a["href"].strip()).split("#")[0]
            if site_of(u) == site_of(home.final_url) and PARTNER_PAGES.search(urlsplit(u).path + " " + a.get_text(" ", strip=True)) \
                    and u not in extra and normalize_url(u) != normalize_url(home.final_url):
                extra.append(u)
        for u in extra[:4]:
            if not ctx.take_page():
                break
            r = ctx.fetcher.get(u)
            if r.ok:
                pages.append((r.final_url, r.text))
        for page_url, text in pages:
            for u, anchor in _outbound(text, page_url):
                s = site_of(u)
                if not s or s in NOT_PARTNERS or s == mine or s in comps or s in linked or any(s.endswith("." + n) for n in NOT_PARTNERS):
                    continue
                a = agg[s]
                a["comps"].add(comp)
                if len(a["where"]) < 4 and page_url not in a["where"]:
                    a["where"].append(page_url)
                if not a["url"]:
                    a["url"], a["anchor"] = u, anchor
    if not read:
        res.errors.append("None of your competitors' sites could be read.")
        return res
    ranked = sorted(agg.items(), key=lambda kv: (-len(kv[1]["comps"]), kv[0]))
    pending: list[Pending] = []
    for site, a in ranked[:40]:
        key = _key("partner", site)
        if reg.known_opportunity(key):
            continue
        n = len(a["comps"])
        pending.append(Pending(
            "partner", key, a["url"], f"{site}: linked from {n} competitor{'s' if n > 1 else ''}", site,
            text=a["anchor"], competitors_shared=n,
            data={"competitors": sorted(a["comps"]), "where": a["where"], "anchor": a["anchor"],
                  "how": "Your competitors link to this site from their own pages. That usually means a membership, association, "
                         "supplier, insurer or sponsorship, and such sites often list their members or partners with a link. "
                         "Look at how they are connected, and whether you could join or work with them too."},
        ))
    ctx.save_all(pending, res)
    if not pending:
        res.notes.append("No new partner sites found on your competitors' pages.")
    return res


# --------------------------------------------------------------------------
# check a page
# --------------------------------------------------------------------------
def scan_page(ctx: Context, url: str) -> dict:
    """Look at one page for anything useful. Saves opportunities it finds; returns a summary."""
    cfg, reg = ctx.cfg, ctx.reg
    page = ctx.fetcher.get(url, use_cache=False)
    if not page.ok:
        raise ValueError(f"The page could not be read ({page.status or page.error}).")
    final = page.final_url
    site = site_of(final)
    if site == site_of(cfg.my_site or ""):
        raise ValueError("That is a page on your own site. Paste a page on another site.")
    title = page_title(page.text) or final
    text = visible_text(page.text)
    out = {"url": final, "title": title, "site": site, "links": [], "link_id": None, "mention": None,
           "dead": [], "outbound_sites": len(parse.outbound_sites(page.text, final)), "topics": topic_hits(text, cfg.topics),
           "opps": [], "summary": []}
    matcher = TargetMatcher(cfg.my_site)
    hits = [h for h in parse.find_links(page.text, final, matcher) if h.kind in ("a", "wrapped")]
    out["links"] = [{"href": h.href, "anchor": h.anchor_text, "rel": sorted(h.rel)} for h in hits[:10]]
    if hits:
        row = next((r for r in reg.all() if normalize_url(r["source_url"]) == normalize_url(final)), None)
        out["link_id"] = row["id"] if row else None
        out["summary"].append(f"This page already links to you ({len(hits)} link{'s' if len(hits) > 1 else ''})."
                              + ("" if row else " Add it to your links to keep an eye on it."))
    res = FinderResult("scan")
    pending: list[Pending] = []
    if not hits:
        brand = next((b for b in cfg.brand_names if re.search(r"(?<!\w)" + re.escape(b) + r"(?!\w)", text, re.I)), None)
        if brand:
            out["mention"] = {"brand": brand, "context": snippet(text, brand)}
            out["summary"].append(f"It mentions {brand} without a link: ask them to add one.")
            pending.append(Pending(
                "unlinked_mention", _key("mention", normalize_url(final)), final, title, site, text=snippet(text, brand, 300),
                outbound_sites=out["outbound_sites"],
                data={"brand": brand, "context": snippet(text, brand), "source": "Check a page",
                      "how": "This page names your brand without linking to you. Thank the author and ask them to link the mention to your site."}))
    links = []
    seen = set()
    for u, anchor in _outbound(page.text, final):
        n = normalize_url(u)
        if n not in seen and site_of(u) != site:
            seen.add(n)
            links.append((u, anchor))
    for i, (u, anchor) in enumerate(links[: cfg.max_links_checked_per_page]):
        ctx.progress(f"Testing links on the page ({i + 1})")
        dead, why = _dead(ctx, u)
        if dead:
            suggestion = ctx.suggest_page(f"{anchor} {urlsplit(u).path}")
            out["dead"].append({"url": u, "anchor": anchor, "status": why, "suggested_page": suggestion})
            pending.append(Pending(
                "broken_link", _key("bl", normalize_url(final), normalize_url(u)), final, title, site, text=text[:3000],
                outbound_sites=out["outbound_sites"],
                data={"dead_url": u, "dead_status": why, "anchor": anchor, "wayback": wayback(u), "suggested_page": suggestion,
                      "source": "Check a page",
                      "how": "This page has a dead link. Tell the owner, and offer your page as the replacement."}))
    if out["dead"]:
        out["summary"].append(f"{len(out['dead'])} dead link{'s' if len(out['dead']) > 1 else ''} on it: offer your page as a replacement.")
    if not hits and out["outbound_sites"] >= 8 and out["topics"]:
        out["summary"].append("It lists many other sites on your topics: ask to be added.")
        pending.append(Pending(
            "resource_page", _key("res", normalize_url(final)), final, title, site, text=text[:3000],
            outbound_sites=out["outbound_sites"],
            data={"source": "Check a page", "broken_links": len(out["dead"]), "links_checked": min(len(links), cfg.max_links_checked_per_page),
                  "how": "A list of resources in your topic. Ask to be added if you have a genuinely useful page."}))
    ctx.save_all(pending, res)
    out["opps"] = [i for i in (reg.opportunity_id(p.key) for p in pending) if i]
    if not out["summary"]:
        out["summary"].append("Nothing to act on here: no link to you, no mention of your brand, no dead links found.")
    return out
