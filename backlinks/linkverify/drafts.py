"""Drafts for outreach emails and journalist answers. Nothing here ever sends anything.

A draft is built from an honest template per opportunity type, using only what is in
your [profile] section and what the finder saw on the page. Anything it cannot know is
left as a [PLACEHOLDER IN CAPITALS] for you to fill in or delete.

With an Anthropic API key ([drafting] anthropic_api_key), the template can be
personalised by Claude. The model is told to use only the facts given and to keep
placeholders where facts are missing, and the result is still only a draft.
"""

from __future__ import annotations

import json
import re
from urllib.parse import quote, urljoin, urlsplit

import httpx

from . import parse
from .config import Config
from .db import Registry
from .domains import site_of
from .fetcher import Fetcher

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2026-10-21"

PLACEHOLDER_RE = re.compile(r"\[[A-Z][A-Z0-9 ,.'/&:;()?!\-–—]{2,}\]")
EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
JUNK_EMAIL = re.compile(r"(example\.|sentry|wixpress|\.png$|\.jpe?g$|\.gif$|\.webp$|\.svg$|noreply|no-reply|donotreply|"
                        r"privacy@|abuse@|dmca@|legal@|unsubscribe)", re.I)
CONTACT_WORDS = ("contact", "about", "write-for", "write for", "team", "editor", "submit", "advertis", "get in touch")


# --------------------------------------------------------------------------- contacts

def _emails_in(html: str, text: str) -> list[str]:
    found: list[str] = []
    for m in re.finditer(r'href=["\']mailto:([^"\'?]+)', html or "", re.I):
        found.append(m.group(1).strip())
    found += EMAIL_RE.findall(text or "")
    out: list[str] = []
    for e in found:
        e = e.strip().strip(".").lower()
        if "@" in e and not JUNK_EMAIL.search(e) and e not in out:
            out.append(e)
    return out


def _author_of(html: str) -> str:
    soup = parse.soup_of(html)
    for sel in ({"name": "author"}, {"property": "article:author"}, {"name": "twitter:creator"}):
        tag = soup.find("meta", attrs=sel)
        val = (tag.get("content") or "").strip() if tag else ""
        if val and not val.startswith("http"):
            return val[:80]
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(script.string or "")
        except (ValueError, TypeError):
            continue
        for node in data if isinstance(data, list) else data.get("@graph", [data]) if isinstance(data, dict) else []:
            if not isinstance(node, dict):
                continue
            a = node.get("author")
            a = a[0] if isinstance(a, list) and a else a
            if isinstance(a, dict) and a.get("name"):
                return str(a["name"])[:80]
            if isinstance(a, str) and a.strip():
                return a.strip()[:80]
    tag = soup.find(attrs={"rel": "author"}) or soup.find(class_=re.compile(r"\b(author-name|byline|author)\b"))
    if tag:
        name = " ".join(tag.get_text(" ", strip=True).split())
        name = re.sub(r"^(by|written by)\s+", "", name, flags=re.I)
        if 2 < len(name) <= 60:
            return name
    return ""


def _contact_pages(html: str, page_url: str) -> list[str]:
    soup = parse.soup_of(html)
    site = site_of(page_url)
    out: list[str] = []
    for a in soup.find_all("a", href=True):
        href = urljoin(page_url, a["href"])
        if urlsplit(href).scheme not in ("http", "https") or site_of(href) != site:
            continue
        label = (a.get_text(" ", strip=True) + " " + urlsplit(href).path).lower()
        if any(w in label for w in CONTACT_WORDS) and href not in out and href.split("#")[0] != page_url.split("#")[0]:
            out.append(href.split("#")[0])
    # contact first, then about
    out.sort(key=lambda u: (0 if "contact" in u.lower() else 1 if "about" in u.lower() else 2))
    return out[:5]


def find_contacts(cfg: Config, url: str, fetcher: Fetcher | None = None, max_pages: int = 2) -> dict:
    """Public contact details for the site behind `url`: emails, author name, contact pages.

    Reads at most 1 + max_pages public pages. Never submits forms.
    """
    out = {"emails": [], "author": "", "contact_pages": [], "checked": []}
    if not url.startswith(("http://", "https://")):
        return out
    fetcher = fetcher or Fetcher(cfg)
    page = fetcher.get(url)
    out["checked"].append(url)
    if not page.ok:
        return out
    final = page.final_url or url
    out["author"] = _author_of(page.text)
    out["emails"] = _emails_in(page.text, " ".join(parse.soup_of(page.text).get_text(" ").split()))
    pages = _contact_pages(page.text, final)
    if not pages:
        root = f"{urlsplit(final).scheme}://{urlsplit(final).netloc}"
        pages = [root + "/contact", root + "/about"]
    out["contact_pages"] = pages
    for p in pages[:max_pages]:
        if len(out["emails"]) >= 3:
            break
        r = fetcher.get(p)
        out["checked"].append(p)
        if r.ok:
            for e in _emails_in(r.text, " ".join(parse.soup_of(r.text).get_text(" ").split())):
                if e not in out["emails"]:
                    out["emails"].append(e)
        elif p in out["contact_pages"] and r.status in (404, 410):
            out["contact_pages"].remove(p)
    # emails on the site's own domain first
    host = site_of(final)
    out["emails"].sort(key=lambda e: 0 if site_of(e.split("@", 1)[1]) == host else 1)
    out["emails"] = out["emails"][:5]
    return out


# --------------------------------------------------------------------------- templates

def _signature(cfg: Config) -> str:
    lines = [cfg.profile_name or "[YOUR NAME]"]
    role = ", ".join(x for x in (cfg.profile_title, cfg.profile_company) if x)
    if role:
        lines.append(role)
    if cfg.my_site:
        lines.append(f"https://{cfg.my_site}")
    return "\n".join(lines)


def _my_page(cfg: Config, data: dict) -> str:
    return data.get("suggested_page") or (cfg.my_pages[0] if cfg.my_pages else (f"https://{cfg.my_site}/" if cfg.my_site else "[YOUR PAGE URL]"))


def _greeting(author: str) -> str:
    first = author.split()[0] if author else ""
    return f"Hi {first}," if first and first.isalpha() else "Hi there,"


def _short(text: str, n: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1].rsplit(" ", 1)[0] + "…"


def template_draft(cfg: Config, opp: dict, contacts: dict | None = None) -> dict:
    """{subject, body, tips} for one opportunity (opp as returned by the dashboard: data is a dict)."""
    contacts = contacts or {}
    kind, data = opp["kind"], opp.get("data") or {}
    title = _short(opp.get("title") or opp.get("site") or "your page", 90)
    hi = _greeting(contacts.get("author", ""))
    sig = _signature(cfg)
    brand = data.get("brand") or (cfg.brand_names[0] if cfg.brand_names else "[YOUR BRAND]")
    mine = _my_page(cfg, data)
    tips: list[str] = []

    if kind == "unlinked_mention":
        subject = f"Thanks for mentioning {brand}"
        body = (f"{hi}\n\nI came across \"{title}\" and saw that you mentioned {brand}. Thank you for including us.\n\n"
                f"Would you be open to linking that mention to {mine}? It would let your readers go straight to us "
                f"if they want to learn more.\n\nEither way, thanks again.\n\n{sig}")
        tips.append("Keep it short and thankful. Don't ask for anything else in the first email.")
    elif kind in ("broken_backlink", "broken_link"):
        dead = data.get("dead_url", "[DEAD LINK URL]")
        status = data.get("dead_status") or "an error"
        anchor = data.get("anchor")
        where = f"the link \"{_short(anchor, 60)}\"" if anchor else "one of the links"
        subject = f"Broken link on \"{_short(title, 60)}\""
        body = (f"{hi}\n\nI was reading \"{title}\" and noticed that {where} goes to {dead}, "
                f"which now returns {status}.\n\n"
                f"If you'd like a replacement, we have a page on the same subject: {mine}. "
                f"[ONE SENTENCE: WHAT YOUR PAGE COVERS THAT THE DEAD ONE DID]\n\n"
                f"Either way, you may want to update or remove that link.\n\n{sig}")
        if data.get("wayback"):
            tips.append(f"See what the dead page used to say before you write the sentence: {data['wayback']}")
        tips.append("Only offer your page if it really covers what the dead page did.")
    elif kind == "resource_page":
        subject = f"A suggestion for \"{_short(title, 60)}\""
        body = (f"{hi}\n\nI found your page \"{title}\" while looking for resources on "
                f"{cfg.topics[0] if cfg.topics else '[TOPIC]'}. It's a useful list.\n\n"
                f"I'd like to suggest {mine} as a possible addition. [ONE SENTENCE: WHAT IT GIVES READERS THAT "
                f"THE PAGES ALREADY LISTED DON'T]\n\nNo problem at all if it isn't a fit.\n\n{sig}")
        if data.get("broken_links"):
            tips.append(f"This page has {data['broken_links']} dead link(s); see the separate broken-link opportunities "
                        f"for it and mention one of them, which makes the email useful to the owner.")
    elif kind == "gap":
        comps = data.get("competitors") or []
        subject = "A resource your readers might find useful"
        body = (f"{hi}\n\nI saw your page [PAGE ON {opp.get('site', 'THEIR SITE').upper()} THAT LINKS TO "
                f"{', '.join(comps[:2]).upper() or 'SIMILAR SITES'}], which points readers to resources on "
                f"{cfg.topics[0] if cfg.topics else '[TOPIC]'}.\n\n"
                f"We published {mine}, which [ONE SENTENCE: WHAT IS NEWER, MORE COMPLETE OR MORE USEFUL ABOUT IT]. "
                f"If you think it fits, it could be a useful addition for your readers.\n\nThanks for reading.\n\n{sig}")
        tips.append("First find the page on this site that links to your competitors "
                    f"(search Google for: site:{opp.get('site', '')} {comps[0] if comps else ''}).")
        tips.append("Don't mention the competitors by name in the email.")
    elif kind == "journalist":
        req = data.get("request") or opp.get("title") or ""
        outlet = data.get("outlet")
        subject = "Re: " + _short(data.get("subject") or opp.get("title") or "your request", 80)
        about = ", ".join(x for x in (cfg.profile_title, cfg.profile_company) if x)
        body = (f"{hi}\n\nResponding to your request{(' for ' + outlet) if outlet else ''}: "
                f"\"{_short(req.splitlines()[0] if req else '', 160)}\"\n\n"
                f"[YOUR ANSWER: 2-4 SHORT PARAGRAPHS FROM YOUR OWN FIRST-HAND EXPERIENCE. ANSWER EXACTLY WHAT WAS ASKED.]\n\n"
                f"About me: {cfg.profile_name or '[YOUR NAME]'}{(', ' + about) if about else ''}. "
                f"{cfg.profile_bio or '[ONE-LINE BIO]'}\n"
                f"Website: {('https://' + cfg.my_site) if cfg.my_site else '[YOUR SITE]'}\n\n{sig}")
        if data.get("deadline"):
            tips.append(f"Deadline: {data['deadline']}. Answer well before it.")
        tips.append("Answer only if you have real expertise on this. Journalists check, and a weak answer costs future pitches.")
        if cfg.profile_facts:
            tips.append("Facts from your profile you could use: " + "; ".join(cfg.profile_facts))
    else:
        subject = f"About \"{_short(title, 60)}\""
        body = f"{hi}\n\n[YOUR MESSAGE]\n\n{sig}"
    return {"subject": subject, "body": body, "tips": tips}


# --------------------------------------------------------------------------- AI

AI_RULES = """You improve outreach emails for a small website owner. Rules you must follow:
1. Use ONLY facts given in this message. Never invent statistics, credentials, experience, quotes, clients, results or anything about the recipient.
2. Where a needed fact is missing, keep or add a placeholder in square brackets and capitals, like [YOUR ANSWER] or [ONE SENTENCE: WHY YOUR PAGE FITS].
3. Be brief, plain and polite. No flattery beyond one genuine, specific line about their page. No marketing language.
4. Under 150 words for outreach emails. Under 250 words for answers to journalists.
5. Keep any URL exactly as given.
Reply with only a JSON object: {"subject": "...", "body": "..."}"""


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON object in the reply")
    out = json.loads(m.group(0))
    if not isinstance(out.get("subject"), str) or not isinstance(out.get("body"), str):
        raise ValueError("reply is missing subject or body")
    return out


def ai_draft(cfg: Config, opp: dict, base: dict, contacts: dict, page_excerpt: str = "") -> dict:
    """Ask Claude to personalise the template. Raises RuntimeError on any problem."""
    if not cfg.anthropic_api_key:
        raise RuntimeError("No Anthropic API key (Settings, Optional extras).")
    data = opp.get("data") or {}
    facts = {
        "opportunity_type": opp["kind"],
        "their_page": {"url": opp.get("url"), "title": opp.get("title"), "author": contacts.get("author") or None,
                       "excerpt": _short(page_excerpt or data.get("context") or data.get("request") or "", 1500)},
        "details_found": {k: v for k, v in data.items() if k in (
            "brand", "context", "dead_url", "dead_status", "anchor", "competitors", "request", "outlet", "deadline")},
        "me": {"name": cfg.profile_name or None, "title": cfg.profile_title or None, "company": cfg.profile_company or None,
               "site": cfg.my_site or None, "bio": cfg.profile_bio or None, "true_facts": cfg.profile_facts,
               "page_to_offer": _my_page(cfg, data)},
        "draft_to_improve": {"subject": base["subject"], "body": base["body"]},
    }
    try:
        resp = httpx.post(ANTHROPIC_URL, timeout=60, headers={
            "x-api-key": cfg.anthropic_api_key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json"},
            json={"model": cfg.anthropic_model, "max_tokens": 1200, "system": AI_RULES,
                  "messages": [{"role": "user", "content": json.dumps(facts, ensure_ascii=False, indent=1)}]})
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not reach the Anthropic API: {exc}") from exc
    if resp.status_code != 200:
        raise RuntimeError(f"Anthropic API returned {resp.status_code}: {resp.text[:200]}")
    text = "".join(b.get("text", "") for b in resp.json().get("content", []) if b.get("type") == "text")
    try:
        out = _extract_json(text)
    except (ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read the AI reply: {exc}") from exc
    return {"subject": out["subject"].strip(), "body": out["body"].strip()}


# --------------------------------------------------------------------------- main entry

def mailto(to: str, subject: str, body: str) -> str:
    return f"mailto:{quote(to or '', safe='@,')}?subject={quote(subject)}&body={quote(body)}"


def placeholders(text: str) -> list[str]:
    return list(dict.fromkeys(PLACEHOLDER_RE.findall(text or "")))


def make_draft(cfg: Config, reg: Registry, opp_id: int, use_ai: bool = False, fetcher: Fetcher | None = None,
               lookup_contacts: bool = True, current: dict | None = None) -> dict:
    """Build, save and return a draft for opportunity `opp_id`. Never sends anything.

    `current` ({subject, body}) is the user's own version: with AI on, that is what gets improved."""
    row = reg.opportunity(opp_id)
    if row is None:
        raise KeyError(f"No opportunity {opp_id}")
    opp = dict(row)
    opp["data"] = json.loads(opp.pop("data_json", "{}") or "{}")
    data = opp["data"]
    contacts: dict = {"emails": [], "author": "", "contact_pages": [], "checked": []}
    excerpt = ""
    if opp["kind"] == "journalist":
        contacts["emails"] = list(data.get("contacts") or [])
        if opp["url"].startswith("http"):
            contacts["contact_pages"] = [opp["url"]]
    elif lookup_contacts:
        own = fetcher is None
        fetcher = fetcher or Fetcher(cfg)
        try:
            contacts = find_contacts(cfg, opp["url"], fetcher)
            if use_ai:
                page = fetcher.get(opp["url"])  # cached by the fetcher
                if page.ok:
                    excerpt = " ".join(parse.soup_of(page.text).get_text(" ").split())[:3000]
        finally:
            if own:
                fetcher.close()
    base = template_draft(cfg, opp, contacts)
    if use_ai and current and current.get("body", "").strip():
        base = {**base, "subject": current.get("subject") or base["subject"], "body": current["body"]}
    source, notes = "template", []
    draft = {"subject": base["subject"], "body": base["body"]}
    if use_ai:
        try:
            draft = ai_draft(cfg, opp, base, contacts, excerpt)
            source = "ai"
        except RuntimeError as exc:
            notes.append(f"AI draft not used: {exc}")
    to = contacts["emails"][0] if contacts.get("emails") else ""
    stored = dict(contacts, tips=base["tips"], notes=notes)
    draft_id = reg.save_draft(opp_id, source, draft["subject"], draft["body"], stored)
    return {
        "id": draft_id, "opp_id": opp_id, "source": source, "subject": draft["subject"], "body": draft["body"],
        "created_at": (reg.latest_draft(opp_id) or {}).get("created_at"),
        "to": to, "contacts": contacts, "tips": base["tips"], "notes": notes,
        "placeholders": placeholders(draft["subject"] + "\n" + draft["body"]),
        "mailto": mailto(to, draft["subject"], draft["body"]),
    }


def stored_draft(reg: Registry, opp_id: int) -> dict | None:
    d = reg.latest_draft(opp_id)
    if not d:
        return None
    c = d.get("contacts") or {}
    to = (c.get("emails") or [""])[0]
    return {"id": d["id"], "opp_id": opp_id, "source": d["source"], "subject": d["subject"], "body": d["body"],
            "to": to, "contacts": {k: c.get(k) for k in ("emails", "author", "contact_pages", "checked")},
            "tips": c.get("tips", []), "notes": c.get("notes", []), "created_at": d["created_at"],
            "placeholders": placeholders(d["subject"] + "\n" + d["body"]), "mailto": mailto(to, d["subject"], d["body"])}
