"""Opportunity finders.

mentions     pages that name your brand but do not link to you
             (Google Alerts RSS feeds, free; plus a DataForSEO search, paid)
journalists  reporter requests that match your topics
             (journalist-request emails over IMAP, free; Bluesky #journorequest, free)
gap          sites that link to two or more competitors but not to you (DataForSEO)
broken       pages linking to competitors' dead pages: offer yours instead (DataForSEO)
resources    resource pages in your topics, plus dead outbound links on them
             (DataForSEO search to find them, free crawling to check them)

Every finder saves opportunities with a score (see score.py). Nothing is sent
or posted anywhere: the tool only reads public pages and your own inbox.
"""

from __future__ import annotations

import email
import hashlib
import html as _html
import imaplib
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from itertools import combinations
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx

from . import ahrefs, parse, tranco
from .config import Config
from .d4s import BudgetExceeded, Client, DataForSEOError
from .db import Registry, now_iso
from .domains import TargetMatcher, normalize_url, site_of
from .fetcher import Fetcher
from .score import score, topic_hits

FINDERS = ("mentions", "journalists", "listings", "partners", "gap", "broken", "resources", "campaigns")
PAID = {"gap", "broken", "resources"}  # need DataForSEO; skipped quietly without it


def available(cfg: Config) -> list[str]:
    """The finders that can run with what is set up. Paid ones only when DataForSEO is connected."""
    return [n for n in FINDERS if n not in PAID or cfg.has_dataforseo]
STOPWORDS = set("the and for with your you our from that this are was were has have how what why when best top guide "
                "into about more than www com http https html index page pages post posts blog".split())


@dataclass
class FinderResult:
    name: str
    found: int = 0
    new: int = 0
    registered: int = 0
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class Pending:
    kind: str
    key: str
    url: str
    title: str
    site: str
    text: str = ""
    data: dict = field(default_factory=dict)
    strength: float | None = None
    competitors_shared: int = 0
    published: str | None = None
    outbound_sites: int | None = None


class Context:
    def __init__(self, cfg: Config, reg: Registry, fetcher: Fetcher | None = None, client: Client | None = None,
                 progress=None):
        self.cfg = cfg
        self.progress = progress or (lambda *_: None)  # may raise to cancel (the app's Stop button)
        self.reg = reg
        self.fetcher = fetcher or Fetcher(cfg)
        self._own_fetcher = fetcher is None
        self.client = client
        if self.client is None and cfg.has_dataforseo:
            self.client = Client(cfg)
        self.serp_left = cfg.max_serp_queries_per_run
        self.pages_left = cfg.max_pages_fetched_per_run
        self._my_pages: list[tuple[str, set[str]]] | None = None

    def close(self) -> None:
        if self._own_fetcher:
            self.fetcher.close()

    # budgets ---------------------------------------------------------------
    def take_page(self) -> bool:
        self.progress(f"Opening pages ({self.cfg.max_pages_fetched_per_run - self.pages_left + 1})")
        if self.pages_left <= 0:
            return False
        self.pages_left -= 1
        return True

    def serp(self, query: str, depth: int = 20) -> list[dict]:
        if self.client is None:
            raise DataForSEOError("DataForSEO is not connected (Settings, Optional extras)")
        if self.serp_left <= 0:
            return []
        self.progress(f"Searching Google: {query[:60]}")
        self.serp_left -= 1
        return self.client.serp(query, depth)

    # helpers ------------------------------------------------------------------
    def skip_site(self, site: str) -> bool:
        mine = site_of(self.cfg.my_site)
        return not site or site == mine or site in {site_of(c) for c in self.cfg.competitors}

    def my_pages(self) -> list[tuple[str, set[str]]]:
        """Your pages with the words that describe them (title + URL slug), fetched once per run."""
        if self._my_pages is None:
            self._my_pages = []
            for url in self.cfg.my_pages[:30]:
                res = self.fetcher.get(url)
                title = ""
                if res.ok:
                    soup = parse.soup_of(res.text)
                    title = soup.title.get_text(" ", strip=True) if soup.title else ""
                self._my_pages.append((url, words(title + " " + urlsplit(url).path)))
        return self._my_pages

    def suggest_page(self, text: str) -> str:
        want = words(text)
        best, best_n = "", 0
        for url, ws in self.my_pages():
            n = len(want & ws)
            if n > best_n:
                best, best_n = url, n
        return best

    def save_all(self, items: list[Pending], result: FinderResult) -> None:
        """Look up site strength in bulk, score, and store."""
        if self.cfg.ahrefs_api_key:
            # Ahrefs is the source of truth when you have it: DR of the site + UR of the page
            ranked = [p for p in items if p.site and p.kind != "journalist"]
            page_kinds = {"unlinked_mention", "broken_backlink", "broken_link", "resource_page"}
            try:
                m = ahrefs.metrics(self.cfg, sites=[p.site for p in ranked],
                                   pages=[p.url for p in ranked if p.kind in page_kinds])
                for p in ranked:
                    dr = (m.get(f"site:{site_of(p.site)}") or {}).get("dr")
                    ur = (m.get(f"page:{p.url}") or {}).get("ur") if p.kind in page_kinds else None
                    if dr is not None or ur is not None:
                        p.strength = ahrefs.strength(dr, ur)
                        p.data["ahrefs_dr"], p.data["ahrefs_ur"] = dr, ur
            except RuntimeError as exc:
                result.notes.append(f"Ahrefs lookup failed, using other data: {exc}")
        unknown = sorted({p.site for p in items if p.strength is None and p.site and p.kind != "journalist"})
        strengths: dict[str, float] = {}
        if unknown and self.client is not None:
            try:
                for chunk in (unknown[i:i + 1000] for i in range(0, len(unknown), 1000)):
                    for r in self.client.post("backlinks/bulk_ranks/live", {"targets": chunk, "rank_scale": "one_hundred"}):
                        for item in r.get("items") or []:
                            if item.get("target") and item.get("rank") is not None:
                                strengths[site_of(item["target"])] = float(item["rank"])
            except DataForSEOError as exc:
                result.notes.append(f"Site strength not looked up: {exc}")
        world: dict[str, int] = {}
        if self.cfg.use_tranco:
            world = tranco.ranks(self.cfg, [p.site for p in items if p.strength is None and p.site and site_of(p.site) not in strengths])
        for p in items:
            src = None
            if p.strength is None and site_of(p.site or "") in strengths:
                p.strength, src = strengths[site_of(p.site)], "DataForSEO rank"
            if p.strength is None and world.get(site_of(p.site or "")):
                rank = world[site_of(p.site)]
                p.strength, src = tranco.score(rank), f"world rank {rank:,}, free Tranco list"
                p.data["world_rank"] = rank
            p.data["strength"] = p.strength
            if "ahrefs_dr" in p.data or "ahrefs_ur" in p.data:
                p.data["strength_source"] = "Ahrefs DR/UR"
            elif src:
                p.data["strength_source"] = src
            s, detail = score(p.kind, strength=p.strength, text=p.title + " " + p.text, topics=self.cfg.topics,
                              competitors_shared=p.competitors_shared, published=p.published,
                              outbound_sites=p.outbound_sites)
            _, created = self.reg.upsert_opportunity(p.key, p.kind, p.url, p.title[:300], p.site, s, detail, p.data)
            result.found += 1
            result.new += created


def words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]{4,}", (text or "").lower()) if w not in STOPWORDS}


def page_title(html: str) -> str:
    soup = parse.soup_of(html)
    if soup.title and soup.title.get_text(strip=True):
        return " ".join(soup.title.get_text(" ", strip=True).split())
    h1 = soup.find("h1")
    return " ".join(h1.get_text(" ", strip=True).split()) if h1 else ""


def visible_text(html: str) -> str:
    soup = parse.soup_of(html)
    for t in soup(["script", "style", "noscript", "template"]):
        t.decompose()
    return " ".join(soup.get_text(" ").split())


def snippet(text: str, needle: str, width: int = 200) -> str:
    i = text.lower().find(needle.lower())
    if i < 0:
        return text[: 2 * width]
    a, b = max(0, i - width), min(len(text), i + len(needle) + width)
    return ("…" if a else "") + text[a:b] + ("…" if b < len(text) else "")


def wayback(url: str, timeout: float = 15) -> str:
    try:
        r = httpx.get("https://archive.org/wayback/available", params={"url": url}, timeout=timeout)
        snap = (r.json().get("archived_snapshots") or {}).get("closest") or {}
        return snap.get("url", "") if snap.get("available") else ""
    except (httpx.HTTPError, ValueError):
        return ""


def _key(*parts: str) -> str:
    return "|".join(parts)


def _hash(*parts: str) -> str:
    return hashlib.sha1("\n".join(parts).encode("utf-8", "replace")).hexdigest()[:16]


# --------------------------------------------------------------------------
# mentions
# --------------------------------------------------------------------------
ATOM = "{http://www.w3.org/2005/Atom}"


def parse_alerts_feed(xml_text: str) -> list[dict]:
    """Entries of a Google Alerts RSS (Atom) feed: [{url, title, published}]."""
    out = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return out
    entries = root.findall(f"{ATOM}entry") or root.findall(".//item")
    for e in entries:
        link = e.find(f"{ATOM}link")
        href = link.get("href") if link is not None else (e.findtext("link") or "")
        q = parse_qs(urlsplit(href).query)
        if "google." in (urlsplit(href).hostname or "") and q.get("url"):
            href = q["url"][0]  # unwrap https://www.google.com/url?...&url=REAL
        title = e.findtext(f"{ATOM}title") or e.findtext("title") or ""
        title = re.sub(r"<[^>]+>", "", title)
        title = parse.soup_of(title).get_text() if "&" in title else title
        published = e.findtext(f"{ATOM}published") or e.findtext(f"{ATOM}updated") or e.findtext("pubDate") or ""
        if href.startswith(("http://", "https://")):
            out.append({"url": href, "title": title.strip(), "published": published.strip()})
    return out


def find_mentions(ctx: Context) -> FinderResult:
    cfg, reg = ctx.cfg, ctx.reg
    res = FinderResult("mentions")
    if not cfg.my_site or not cfg.brand_names:
        res.errors.append("Add your brand names in Settings, Your website.")
        return res
    candidates: dict[str, dict] = {}
    for feed in cfg.google_alerts_feeds:
        f = ctx.fetcher.get(feed, use_cache=False)
        if not f.ok:
            res.errors.append(f"Alerts feed could not be read (HTTP {f.status or f.error}): {feed[:80]}")
            continue
        for e in parse_alerts_feed(f.text):
            candidates.setdefault(normalize_url(e["url"]), {**e, "source": "Google Alerts"})
    if cfg.serp_mention_search and ctx.client is not None:
        for brand in cfg.brand_names:
            try:
                for item in ctx.serp(f'"{brand}" -site:{cfg.my_site}', depth=30):
                    candidates.setdefault(normalize_url(item["url"]),
                                          {"url": item["url"], "title": item["title"], "published": "", "source": "Google search"})
            except DataForSEOError as exc:
                res.errors.append(str(exc))
                break
    elif not cfg.google_alerts_feeds:
        res.errors.append("No mention source yet. Create a free Google Alert for your brand with 'Deliver to: RSS feed' "
                          "and paste the feed address in Settings, Free sources.")

    registered = {normalize_url(r["source_url"]) for r in reg.all()}
    matcher = TargetMatcher(cfg.my_site)
    pending: list[Pending] = []
    for norm, c in candidates.items():
        site = site_of(c["url"])
        if site == site_of(cfg.my_site) or norm in registered or reg.known_opportunity(_key("mention", norm)):
            continue
        if not ctx.take_page():
            res.notes.append("Page limit for this run reached; the rest will be checked next run.")
            break
        page = ctx.fetcher.get(c["url"])
        if not page.ok:
            continue
        text = visible_text(page.text)
        brand = next((b for b in cfg.brand_names if re.search(r"(?<!\w)" + re.escape(b) + r"(?!\w)", text, re.I)), None)
        if not brand:
            continue
        links = [h for h in parse.find_links(page.text, page.final_url, matcher) if h.kind == "a"]
        if links:
            if cfg.auto_register_linked_mentions:
                reg.add(page.final_url, cfg.my_site, "earned mention", f"found by the mention finder ({c['source']})")
                res.registered += 1
            continue
        pending.append(Pending(
            "unlinked_mention", _key("mention", norm), page.final_url, page_title(page.text) or c["title"], site,
            text=snippet(text, brand, 300), published=c.get("published") or None,
            outbound_sites=len(parse.outbound_sites(page.text, page.final_url)),
            data={"brand": brand, "context": snippet(text, brand), "source": c["source"], "published": c.get("published"),
                  "how": "This page names your brand without linking to you. Thank the author and ask them to link the mention to your site."},
        ))
    ctx.save_all(pending, res)
    if res.registered:
        res.notes.append(f"{res.registered} page(s) already link to you; added them to your link registry.")
    return res


# --------------------------------------------------------------------------
# journalist requests
# --------------------------------------------------------------------------
SEPARATOR = re.compile(r"^\s*(?:[-=_*~]{4,}|#{3,}|—{2,}|─{3,})\s*$")
HEADING = re.compile(r"^\s*(?:\d{1,3}[\.\)]\s+\S|(?:query|request|summary)\s*(?:#?\d+)?\s*:)", re.I)
DEADLINE = re.compile(r"(?:deadline|due|respond by|needed by)\s*[:\-]?\s*([^\n]{3,60})", re.I)
OUTLET = re.compile(r"(?:media outlet|outlet|publication|publishing on|for)\s*:\s*([^\n]{2,80})", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def split_requests(text: str) -> list[str]:
    lines = text.replace("\r\n", "\n").split("\n")
    seps = [i for i, l in enumerate(lines) if SEPARATOR.match(l)]
    chunks: list[str] = []
    if len(seps) >= 2:
        start = 0
        for i in seps + [len(lines)]:
            chunks.append("\n".join(lines[start:i]))
            start = i + 1
    else:
        heads = [i for i, l in enumerate(lines) if HEADING.match(l)]
        if len(heads) >= 2:
            bounds = heads + [len(lines)]
            chunks.append("\n".join(lines[: heads[0]]))
            for a, b in zip(bounds, bounds[1:]):
                chunks.append("\n".join(lines[a:b]))
        else:
            paras = re.split(r"\n\s*\n", text)
            buf = ""
            for p in paras:
                buf = (buf + "\n\n" + p).strip() if buf else p.strip()
                if len(buf) >= 120:
                    chunks.append(buf)
                    buf = ""
            if buf:
                chunks.append(buf)
    return [c.strip() for c in chunks if 40 <= len(c.strip()) <= 6000]


def _decode(s: str | None) -> str:
    if not s:
        return ""
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return s


def _message_text(msg: email.message.Message) -> str:
    plain, html = "", ""
    for part in msg.walk() if msg.is_multipart() else [msg]:
        ctype = part.get_content_type()
        if part.get_content_maintype() == "multipart" or part.get("Content-Disposition", "").startswith("attachment"):
            continue
        try:
            payload = part.get_payload(decode=True) or b""
            text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except Exception:
            continue
        if ctype == "text/plain" and not plain:
            plain = text
        elif ctype == "text/html" and not html:
            html = text
    if plain.strip():
        return plain
    if html:
        soup = parse.soup_of(html)
        for br in soup.find_all(["br", "p", "div", "tr", "li", "h1", "h2", "h3", "hr"]):
            br.insert_after("\n")
        return soup.get_text()
    return ""


def requests_from_email(raw: bytes, cfg: Config) -> list[Pending]:
    msg = email.message_from_bytes(raw)
    sender = _decode(msg.get("From")).lower()
    if not any(s in sender for s in cfg.journalist_senders):
        return []
    subject = _decode(msg.get("Subject"))
    mid = (msg.get("Message-ID") or _hash(subject, msg.get("Date") or "")).strip()
    try:
        published = parsedate_to_datetime(msg.get("Date")).astimezone(timezone.utc).isoformat()
    except Exception:
        published = None
    out = []
    for chunk in split_requests(_message_text(msg)):
        hits = topic_hits(chunk, cfg.topics)
        if not hits:
            continue
        lines = [l.strip() for l in chunk.split("\n") if l.strip()]
        title = re.sub(r"^\s*(?:\d{1,3}[\.\)]|(?:query|request|summary)\s*(?:#?\d+)?\s*:)\s*", "", lines[0], flags=re.I)[:160]
        deadline = DEADLINE.search(chunk)
        outlet = OUTLET.search(chunk)
        contacts = sorted(set(EMAIL_RE.findall(chunk)))[:3]
        out.append(Pending(
            "journalist", _key("journo", _hash(mid, title)), f"email:{mid}", title or subject, "",
            text=chunk[:2000], published=published,
            data={"source": sender[:120], "subject": subject, "request": chunk[:4000], "topics": hits,
                  "deadline": deadline.group(1).strip() if deadline else "",
                  "outlet": outlet.group(1).strip() if outlet else "", "contacts": contacts, "received": published},
        ))
    return out


def _imap_requests(cfg: Config, res: FinderResult) -> list[Pending]:
    since = (datetime.now(timezone.utc) - timedelta(days=cfg.journalist_days_back)).strftime("%d-%b-%Y")
    out: list[Pending] = []
    try:
        box = imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port, timeout=60)
    except (OSError, imaplib.IMAP4.error) as exc:
        res.errors.append(f"Could not connect to {cfg.imap_host}: {exc}")
        return out
    try:
        box.login(cfg.imap_username, cfg.imap_password)
        typ, _ = box.select(cfg.imap_folder, readonly=True)
        if typ != "OK":
            res.errors.append(f"Mail folder '{cfg.imap_folder}' not found.")
            return out
        typ, data = box.search(None, f"(SINCE {since})")
        ids = (data[0] or b"").split()[-400:]
        for mid in ids:
            typ, hdr = box.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (FROM)])")
            if typ != "OK" or not hdr or not isinstance(hdr[0], tuple):
                continue
            sender = _decode(email.message_from_bytes(hdr[0][1]).get("From")).lower()
            if not any(s in sender for s in cfg.journalist_senders):
                continue
            typ, body = box.fetch(mid, "(BODY.PEEK[])")
            if typ == "OK" and body and isinstance(body[0], tuple):
                out.extend(requests_from_email(body[0][1], cfg))
    except imaplib.IMAP4.error as exc:
        res.errors.append(f"Mail login or read failed: {exc}. For Gmail use an App Password and turn on IMAP.")
    finally:
        try:
            box.logout()
        except Exception:
            pass
    return out


def _bluesky_requests(cfg: Config, res: FinderResult) -> list[Pending]:
    out: list[Pending] = []
    since = (datetime.now(timezone.utc) - timedelta(days=cfg.journalist_days_back)).strftime("%Y-%m-%dT%H:%M:%SZ")
    queries = [f"{tag} {topic}" for tag in cfg.bluesky_hashtags for topic in cfg.topics][:8]
    for q in queries:
        try:
            r = httpx.get("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts",
                          params={"q": q, "sort": "latest", "limit": 50, "since": since},
                          headers={"User-Agent": cfg.user_agent}, timeout=30)
            if r.status_code != 200:
                res.notes.append(f"Bluesky search returned HTTP {r.status_code} for '{q}'.")
                continue
            posts = r.json().get("posts") or []
        except (httpx.HTTPError, ValueError) as exc:
            res.notes.append(f"Bluesky search failed: {exc}")
            break
        for p in posts:
            uri = p.get("uri", "")
            handle = (p.get("author") or {}).get("handle", "")
            text = (p.get("record") or {}).get("text", "")
            created = (p.get("record") or {}).get("createdAt") or p.get("indexedAt")
            rkey = uri.rsplit("/", 1)[-1]
            hits = topic_hits(text, cfg.topics)
            if not uri or not hits:
                continue
            url = f"https://bsky.app/profile/{handle}/post/{rkey}"
            out.append(Pending(
                "journalist", _key("bsky", uri), url, text.split("\n")[0][:160], "bsky.app", text=text, published=created,
                data={"source": f"Bluesky @{handle}", "request": text, "topics": hits, "received": created,
                      "deadline": (DEADLINE.search(text).group(1).strip() if DEADLINE.search(text) else ""),
                      "outlet": "", "contacts": sorted(set(EMAIL_RE.findall(text)))[:3]},
            ))
    return out


TAG_HTML = re.compile(r"<[^>]+>")


def _mastodon_requests(cfg: Config, res: FinderResult) -> list[Pending]:
    """Public hashtag timelines (#journorequest) on journalist-friendly Mastodon servers. No account needed."""
    out: list[Pending] = []
    since = datetime.now(timezone.utc) - timedelta(days=cfg.journalist_days_back)
    tags = sorted({t.lstrip("#").lower() for t in cfg.bluesky_hashtags} | {"journorequest", "journorequests"})
    for inst in cfg.mastodon_instances[:4]:
        for tag in tags[:4]:
            try:
                r = httpx.get(f"https://{inst}/api/v1/timelines/tag/{tag}", params={"limit": 40},
                              headers={"User-Agent": cfg.user_agent, "Accept": "application/json"}, timeout=30)
            except httpx.HTTPError as exc:
                res.notes.append(f"Mastodon server {inst} could not be reached: {type(exc).__name__}.")
                break
            if r.status_code in (401, 403, 422):
                res.notes.append(f"Mastodon server {inst} does not share its hashtag feed publicly; skipped.")
                break
            if r.status_code != 200:
                res.notes.append(f"Mastodon server {inst} returned HTTP {r.status_code} for #{tag}.")
                continue
            try:
                posts = r.json()
            except ValueError:
                continue
            for p in posts if isinstance(posts, list) else []:
                created = p.get("created_at") or ""
                try:
                    if datetime.fromisoformat(created.replace("Z", "+00:00")) < since:
                        continue
                except ValueError:
                    pass
                html_text = (p.get("content") or "").replace("<br>", "\n").replace("<br />", "\n").replace("</p>", "\n")
                text = " ".join(TAG_HTML.sub(" ", html_text).split())
                text = _html.unescape(text)
                hits = topic_hits(text, cfg.topics)
                url = p.get("url") or p.get("uri") or ""
                if not url or not hits:
                    continue
                acct = (p.get("account") or {}).get("acct", "")
                out.append(Pending(
                    "journalist", _key("masto", url), url, text[:160], site_of(url) or inst, text=text, published=created,
                    data={"source": f"Mastodon @{acct}", "request": text, "topics": hits, "received": created,
                          "deadline": (DEADLINE.search(text).group(1).strip() if DEADLINE.search(text) else ""),
                          "outlet": "", "contacts": sorted(set(EMAIL_RE.findall(text)))[:3]},
                ))
    return out


def find_journalists(ctx: Context) -> FinderResult:
    cfg = ctx.cfg
    res = FinderResult("journalists")
    if not cfg.topics:
        res.errors.append("Add your topics in Settings, Your website; requests are matched against them.")
        return res
    items: list[Pending] = []
    if cfg.has_imap:
        items.extend(_imap_requests(cfg, res))
    if cfg.bluesky_search:
        items.extend(_bluesky_requests(cfg, res))
    if cfg.mastodon_search and cfg.mastodon_instances:
        items.extend(_mastodon_requests(cfg, res))
    if not cfg.has_imap and not cfg.bluesky_search and not cfg.mastodon_search:
        res.errors.append("No request sources: turn on Bluesky or Mastodon in Settings, Free sources.")
    seen = set()
    items = [p for p in items if not (p.key in seen or seen.add(p.key))]
    for p in items:
        p.strength = None  # outlets vary; scored on topic match and freshness
    ctx.save_all(items, res)
    return res


# --------------------------------------------------------------------------
# competitor link gap
# --------------------------------------------------------------------------
def find_gap(ctx: Context) -> FinderResult:
    cfg, reg = ctx.cfg, ctx.reg
    res = FinderResult("gap")
    comps = [site_of(c) for c in cfg.competitors if site_of(c)]
    if ctx.client is None:
        res.errors.append("Competitor gaps need the optional DataForSEO connection.")
        return res
    if len(comps) < 2 or not cfg.my_site:
        res.errors.append("Add at least 2 competitors in Settings, Your website.")
        return res
    agg: dict[str, dict] = {}
    for a, b in list(combinations(comps[:6], 2))[:10]:
        try:
            result = ctx.client.post("backlinks/domain_intersection/live", {
                "targets": {"1": a, "2": b}, "exclude_targets": [site_of(cfg.my_site)],
                "limit": cfg.gap_limit, "order_by": ["1.rank,desc"], "rank_scale": "one_hundred",
                "backlinks_filters": [["dofollow", "=", True]], "include_subdomains": True,
                "exclude_internal_backlinks": True,
            })
        except BudgetExceeded as exc:
            res.errors.append(str(exc))
            break
        except DataForSEOError as exc:
            res.errors.append(f"{a} + {b}: {exc}")
            continue
        for r in result:
            for item in r.get("items") or []:
                inter = item.get("domain_intersection") or {}
                first = inter.get("1") or {}
                domain = first.get("target")
                if not domain:
                    continue
                d = agg.setdefault(site_of(domain), {"competitors": set(), "rank": 0.0, "backlinks": {}})
                d["competitors"].update([a, b])
                d["rank"] = max(d["rank"], float(first.get("rank") or 0))
                d["backlinks"][a] = (inter.get("1") or {}).get("backlinks")
                d["backlinks"][b] = (inter.get("2") or {}).get("backlinks")
    linked = reg.linked_sites()
    pending = []
    for site, d in agg.items():
        if ctx.skip_site(site) or site in linked or len(d["competitors"]) < cfg.gap_min_competitors:
            continue
        pending.append(Pending(
            "gap", _key("gap", site), f"https://{site}/", site, site, strength=d["rank"],
            competitors_shared=len(d["competitors"]),
            data={"competitors": sorted(d["competitors"]), "rank": d["rank"], "backlinks": d["backlinks"],
                  "how": "This site links to these competitors with followed links. Find the page that links to them "
                         "and pitch a better or newer resource."},
        ))
    ctx.save_all(pending, res)
    return res


# --------------------------------------------------------------------------
# broken backlinks to competitors
# --------------------------------------------------------------------------
def _dead(ctx: Context, url: str) -> tuple[bool, str]:
    status, err = ctx.fetcher.status_of(url)
    if err:
        if any(x in err for x in ("ConnectError", "Name or service", "getaddrinfo", "nodename", "DNS")):
            return True, "site does not resolve or refuses connections"
        return False, err  # timeouts and the like are not proof of a dead page
    if status in (404, 410):
        return True, f"HTTP {status}"
    return False, f"HTTP {status}"


def find_broken(ctx: Context) -> FinderResult:
    cfg = ctx.cfg
    res = FinderResult("broken")
    comps = [site_of(c) for c in cfg.competitors if site_of(c)]
    if ctx.client is None:
        res.errors.append("Dead competitor links need the optional DataForSEO connection.")
        return res
    if not comps:
        res.errors.append("Add competitors in Settings, Your website.")
        return res
    pending = []
    for comp in comps[:5]:
        try:
            result = ctx.client.post("backlinks/backlinks/live", {
                "target": comp, "mode": "as_is", "limit": cfg.broken_limit, "rank_scale": "one_hundred",
                "filters": [["is_broken", "=", True], "and", ["dofollow", "=", True]],
                "order_by": ["domain_from_rank,desc"], "backlinks_status_type": "live",
            })
        except BudgetExceeded as exc:
            res.errors.append(str(exc))
            break
        except DataForSEOError as exc:
            res.errors.append(f"{comp}: {exc}")
            continue
        for r in result:
            for item in r.get("items") or []:
                url_from, url_to = item.get("url_from"), item.get("url_to")
                if not url_from or not url_to:
                    continue
                key = _key("bbl", normalize_url(url_from), normalize_url(url_to))
                site = site_of(url_from)
                if ctx.reg.known_opportunity(key) or ctx.skip_site(site):
                    continue
                if not ctx.take_page():
                    res.notes.append("Page limit for this run reached; the rest will be verified next run.")
                    ctx.save_all(pending, res)
                    return res
                page = ctx.fetcher.get(url_from)
                if not page.ok:
                    continue
                hits = [h for h in parse.find_links(page.text, page.final_url, TargetMatcher(url_to)) if h.kind == "a"]
                if not hits:
                    continue  # the page no longer links to the dead URL
                dead, why = _dead(ctx, url_to)
                if not dead:
                    continue
                anchor = hits[0].anchor_text or item.get("anchor") or ""
                suggestion = ctx.suggest_page(f"{anchor} {urlsplit(url_to).path} {hits[0].context}")
                pending.append(Pending(
                    "broken_backlink", key, page.final_url, item.get("page_from_title") or page_title(page.text), site,
                    text=hits[0].context, strength=item.get("domain_from_rank"),
                    outbound_sites=len(parse.outbound_sites(page.text, page.final_url)),
                    data={"dead_url": url_to, "dead_status": why, "anchor": anchor, "competitor": comp,
                          "context": hits[0].context, "wayback": wayback(url_to), "suggested_page": suggestion,
                          "how": "This page links to a competitor page that no longer exists. Tell the author, and "
                                 "offer your page as the replacement."},
                ))
    ctx.save_all(pending, res)
    return res


# --------------------------------------------------------------------------
# resource pages and broken links on them
# --------------------------------------------------------------------------
def find_resources(ctx: Context) -> FinderResult:
    cfg, reg = ctx.cfg, ctx.reg
    res = FinderResult("resources")
    if ctx.client is None:
        res.errors.append("Resource lists need the optional DataForSEO connection.")
        return res
    if not cfg.topics:
        res.errors.append("Add your topics in Settings, Your website.")
        return res
    queries = [f"{t} {fp}" for t in cfg.topics for fp in cfg.resource_footprints]
    pages: dict[str, dict] = {}
    for q in queries:
        try:
            for item in ctx.serp(q, depth=20):
                pages.setdefault(normalize_url(item["url"]), {**item, "query": q})
        except BudgetExceeded as exc:
            res.errors.append(str(exc))
            break
        except DataForSEOError as exc:
            res.errors.append(str(exc))
            break
        if ctx.serp_left <= 0:
            res.notes.append("Search limit for this run reached; more queries run next time.")
            break
    linked = reg.linked_sites()
    pending = []
    for norm, item in pages.items():
        site = site_of(item["url"])
        key = _key("res", norm)
        if ctx.skip_site(site) or site in linked or reg.known_opportunity(key):
            continue
        if not ctx.take_page():
            res.notes.append("Page limit for this run reached; the rest will be crawled next run.")
            break
        page = ctx.fetcher.get(item["url"])
        if not page.ok:
            continue
        text = visible_text(page.text)
        out_links = []
        soup = parse.soup_of(page.text)
        base = parse.base_url(soup, page.final_url)
        seen = set()
        for a in soup.find_all("a", href=True):
            u = urljoin(base, a["href"].strip())
            if u.startswith(("http://", "https://")) and site_of(u) != site and normalize_url(u) not in seen:
                seen.add(normalize_url(u))
                out_links.append((u, " ".join(a.get_text(" ", strip=True).split())[:120]))
        broken = []
        for u, anchor in out_links[: cfg.max_links_checked_per_page]:
            dead, why = _dead(ctx, u)
            if dead:
                broken.append({"url": u, "anchor": anchor, "status": why})
        title = page_title(page.text) or item["title"]
        pending.append(Pending(
            "resource_page", key, page.final_url, title, site, text=text[:3000],
            outbound_sites=len(parse.outbound_sites(page.text, page.final_url)),
            data={"query": item["query"], "broken_links": len(broken), "links_checked": min(len(out_links), cfg.max_links_checked_per_page),
                  "how": "A list of resources in your topic. Ask to be added if you have a genuinely useful page."},
        ))
        for b in broken:
            suggestion = ctx.suggest_page(f"{b['anchor']} {urlsplit(b['url']).path}")
            pending.append(Pending(
                "broken_link", _key("bl", normalize_url(page.final_url), normalize_url(b["url"])), page.final_url,
                title, site, text=text[:3000], outbound_sites=len(parse.outbound_sites(page.text, page.final_url)),
                data={"dead_url": b["url"], "dead_status": b["status"], "anchor": b["anchor"], "wayback": wayback(b["url"]),
                      "suggested_page": suggestion,
                      "how": "This resource page has a dead link. Tell the owner, and offer your page as the replacement."},
            ))
    ctx.save_all(pending, res)
    return res


RUNNERS = {
    "mentions": find_mentions,
    "journalists": find_journalists,
    "gap": find_gap,
    "broken": find_broken,
    "resources": find_resources,
    "campaigns": lambda ctx: _find_campaigns(ctx),
    "listings": lambda ctx: _free("find_listings", ctx),
    "partners": lambda ctx: _free("find_partners", ctx),
}


def _free(name: str, ctx: Context) -> FinderResult:
    from . import freefind  # imported here: freefind builds on this module
    return getattr(freefind, name)(ctx)


def _find_campaigns(ctx: Context) -> FinderResult:
    from .campaigns import find_campaigns  # imported here: campaigns builds on this module
    return find_campaigns(ctx)


def finder_due(reg: Registry, cfg: Config, name: str, now: datetime) -> bool:
    last = reg.get_meta(f"finder_last_run:{name}")
    if name in cfg.daily_finders:
        gap = timedelta(hours=20)
    elif name in cfg.weekly_finders:
        gap = timedelta(days=6, hours=20)
    else:
        return False
    if not last:
        return True
    dt = datetime.fromisoformat(last)
    dt = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return now - dt >= gap


def run_finders(cfg: Config, reg: Registry, names: list[str], fetcher: Fetcher | None = None,
                client: Client | None = None, progress=None) -> list[FinderResult]:
    ctx = Context(cfg, reg, fetcher, client, progress)
    out = []
    try:
        for name in names:
            if name in PAID and ctx.client is None:
                continue  # optional paid source not connected: not an error
            try:
                r = RUNNERS[name](ctx)
            except Exception as exc:  # a finder failing must not stop the others
                r = FinderResult(name, errors=[f"{type(exc).__name__}: {exc}"])
            reg.set_meta(f"finder_last_run:{name}", now_iso())
            out.append(r)
    finally:
        ctx.close()
    return out
