"""Workspaces: shared settings plus one folder per website.

    config.toml                     shared: API keys, alerts, inbox, crawl manners
    sites/ssautomotive.com.au/
        site.toml                   this site: domain, brand, topics, competitors, your profile
        data/                       this site's database, evidence, reports

The two files are merged (site wins) into one Config. An older single-site
config.toml that has [project] site = "..." keeps working as a "legacy" site
whose data stays in ./data.

SCHEMA describes every setting once: where it lives, its type, and the words the
Settings screen shows. Saving rewrites the files from SCHEMA, so they stay tidy.
"""

from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

import threading

from .config import Config, _apply

_LOCK = threading.RLock()  # one settings write at a time (the app serves requests in parallel)

SITES_DIR = "sites"
SITE_FILE = "site.toml"


@dataclass(frozen=True)
class Field:
    section: str
    key: str
    attr: str
    kind: str  # str | int | float | bool | list | path
    scope: str  # shared | site
    label: str
    help: str = ""
    secret: bool = False
    advanced: bool = False
    group: str = ""  # Settings screen group


F = Field
SCHEMA: tuple[Field, ...] = (
    # ---- this site
    F("project", "site", "my_site", "str", "site", "Website address", "Your domain, like ssautomotive.com.au", group="site"),
    F("project", "brand_names", "brand_names", "list", "site", "Brand names", "How people write your business name, one per line", group="site"),
    F("project", "topics", "topics", "list", "site", "Topics", "3 to 8 things you can talk about with authority, one per line", group="site"),
    F("project", "competitors", "competitors", "list", "site", "Competitors", "2 to 6 competitor websites, one per line", group="site"),
    F("project", "pages", "my_pages", "list", "site", "Pages to promote", "Your best pages to offer in outreach, one per line", group="site"),
    F("profile", "name", "profile_name", "str", "site", "Your name", "Used to sign emails", group="profile"),
    F("profile", "title", "profile_title", "str", "site", "Your role", "For example Owner or Workshop manager", group="profile"),
    F("profile", "company", "profile_company", "str", "site", "Business name", group="profile"),
    F("profile", "email", "profile_email", "str", "site", "Your email", group="profile"),
    F("profile", "bio", "profile_bio", "str", "site", "One-line bio", "Used in journalist answers", group="profile"),
    F("profile", "facts", "profile_facts", "list", "site", "True facts about you",
      "Things drafts may say, one per line, like '12 years repairing European cars'. Drafts never invent anything else.", group="profile"),
    F("dataforseo", "location_code", "dataforseo_location_code", "int", "site", "Your country",
      "Picks the free listings for your country", group="site"),
    F("finder", "google_alerts_feeds", "google_alerts_feeds", "list", "site", "Google Alerts feeds",
      "RSS feed addresses from google.com/alerts, one per line", group="free"),
    F("finder", "serp_mention_search", "serp_mention_search", "bool", "site", "Search Google for mentions", "Uses DataForSEO, paid per search", group="extras"),
    F("finder", "alert_min_score", "alert_min_score", "int", "site", "Tell me about opportunities scoring at least", group="notify"),
    F("finder", "auto_register_linked_mentions", "auto_register_linked_mentions", "bool", "site",
      "Add pages that already link to me to my links", group="finding", advanced=True),
    F("finder", "daily_finders", "daily_finders", "list", "site", "Finders run daily",
      "One per line: mentions, journalists, listings, partners, campaigns (gap, broken, resources need DataForSEO)", group="finding", advanced=True),
    F("finder", "weekly_finders", "weekly_finders", "list", "site", "Finders run weekly", group="finding", advanced=True),
    F("finder", "max_serp_queries_per_run", "max_serp_queries_per_run", "int", "site", "Google searches per run, at most", group="finding", advanced=True),
    F("finder", "max_pages_fetched_per_run", "max_pages_fetched_per_run", "int", "site", "Pages opened per run, at most", group="finding", advanced=True),
    F("finder", "max_links_checked_per_page", "max_links_checked_per_page", "int", "site", "Links checked per resource page", group="finding", advanced=True),
    F("finder", "gap_min_competitors", "gap_min_competitors", "int", "site", "Competitor gap: linking to at least this many competitors", group="finding", advanced=True),
    F("finder", "gap_limit", "gap_limit", "int", "site", "Competitor gap: sites per pair", group="finding", advanced=True),
    F("finder", "broken_limit", "broken_limit", "int", "site", "Broken links: per competitor", group="finding", advanced=True),
    F("finder", "resource_footprints", "resource_footprints", "list", "site", "Resource page searches", group="finding", advanced=True),
    F("campaigns", "active_days", "campaign_active_days", "int", "site", "Track each study for this many days", group="finding", advanced=True),
    F("sitegraph", "max_pages", "graph_max_pages", "int", "site", "Pages to read when mapping your site",
      "Raise it if your site has more pages than this", group="checking", advanced=True),
    F("dataforseo", "language_code", "dataforseo_language_code", "str", "site", "Search language", group="extras", advanced=True),
    F("search_console", "property", "gsc_property", "str", "site", "Search Console property", "Like sc-domain:ssautomotive.com.au", group="extras", advanced=True),
    # ---- shared by every site
    F("dataforseo", "login", "dataforseo_login", "str", "shared", "DataForSEO login", "API login from your DataForSEO dashboard", group="extras"),
    F("dataforseo", "password", "dataforseo_password", "str", "shared", "DataForSEO password", secret=True, group="extras"),
    F("dataforseo", "monthly_budget_usd", "dataforseo_monthly_budget_usd", "float", "shared", "Monthly DataForSEO budget (USD)",
      "The tool stops calling DataForSEO when this month's spend reaches this", group="extras"),
    F("ahrefs", "api_key", "ahrefs_api_key", "str", "shared", "Ahrefs API key", "From app.ahrefs.com/api/keys", secret=True, group="extras"),
    F("ahrefs", "cache_days", "ahrefs_cache_days", "int", "shared", "Keep Ahrefs ratings for (days)", group="extras", advanced=True),
    F("drafting", "anthropic_api_key", "anthropic_api_key", "str", "shared", "Anthropic API key", "For AI-personalised drafts", secret=True, group="extras"),
    F("drafting", "model", "anthropic_model", "str", "shared", "AI model", group="extras", advanced=True),
    F("journalist", "imap_host", "imap_host", "str", "shared", "Mail server", "imap.gmail.com for Gmail", group="extras"),
    F("journalist", "imap_port", "imap_port", "int", "shared", "Mail server port", group="extras", advanced=True),
    F("journalist", "username", "imap_username", "str", "shared", "Email address", group="extras"),
    F("journalist", "password", "imap_password", "str", "shared", "App password",
      "For Gmail: Google Account, Security, App passwords. Not your normal password.", secret=True, group="extras"),
    F("journalist", "folder", "imap_folder", "str", "shared", "Folder", group="extras", advanced=True),
    F("journalist", "senders", "journalist_senders", "list", "shared", "Request newsletters to read", "Sender names or addresses, one per line", group="extras", advanced=True),
    F("journalist", "days_back", "journalist_days_back", "int", "shared", "Requests from the last (days)", group="free", advanced=True),
    F("journalist", "bluesky_search", "bluesky_search", "bool", "shared", "Search Bluesky for #journorequest posts", group="free"),
    F("journalist", "bluesky_hashtags", "bluesky_hashtags", "list", "shared", "Hashtags", group="free", advanced=True),
    F("journalist", "mastodon_search", "mastodon_search", "bool", "shared", "Read #journorequest posts on Mastodon", group="free"),
    F("journalist", "mastodon_instances", "mastodon_instances", "list", "shared", "Mastodon servers", "One per line", group="free", advanced=True),
    F("free", "tranco", "use_tranco", "bool", "shared", "Rate sites with the free world ranking",
      "Downloads the free Tranco top-million list once a month (about 10 MB)", group="free"),
    F("monitor", "desktop_notifications", "desktop_notifications", "bool", "shared", "Show a Windows notification after the daily run",
      "When it finds link problems or good opportunities", group="notify"),
    F("email", "smtp_host", "email_smtp_host", "str", "shared", "Outgoing mail server", "smtp.gmail.com for Gmail", group="extras"),
    F("email", "smtp_port", "email_smtp_port", "int", "shared", "Outgoing mail port", group="extras", advanced=True),
    F("email", "username", "email_username", "str", "shared", "Mail username", group="extras"),
    F("email", "password", "email_password", "str", "shared", "Mail app password", secret=True, group="extras"),
    F("email", "from", "email_from", "str", "shared", "Send alerts from", group="extras", advanced=True),
    F("email", "to", "email_to", "str", "shared", "Send alerts to", group="extras"),
    F("telegram", "bot_token", "telegram_bot_token", "str", "shared", "Telegram bot token", "Create a bot with @BotFather", secret=True, group="extras"),
    F("telegram", "chat_id", "telegram_chat_id", "str", "shared", "Telegram chat id", group="extras"),
    F("monitor", "alert_on", "alert_on", "str", "shared", "Tell me about", "changes = problems and recoveries; bad = problems only", group="notify"),
    F("monitor", "weekly_days", "weekly_days", "int", "shared", "Re-check new links every (days)", group="checking", advanced=True),
    F("monitor", "intensive_period_days", "intensive_period_days", "int", "shared", "A link counts as new for (days)", group="checking", advanced=True),
    F("monitor", "monthly_days", "monthly_days", "int", "shared", "Then re-check every (days)", group="checking", advanced=True),
    F("general", "render", "render", "bool", "shared", "Check links in a real browser too", "Needs the headless browser that setup installs", group="checking"),
    F("general", "delay_seconds", "delay_seconds", "float", "shared", "Wait between requests to one site (seconds)", group="checking", advanced=True),
    F("general", "timeout_seconds", "timeout_seconds", "float", "shared", "Give up on a page after (seconds)", group="checking", advanced=True),
    F("general", "max_outbound_domains", "max_outbound_domains", "int", "shared", "A page linking to more sites than this makes a link weak", group="checking", advanced=True),
    F("general", "render_timeout_seconds", "render_timeout_seconds", "float", "shared", "Browser check time limit (seconds)", group="checking", advanced=True),
    F("general", "save_evidence", "save_evidence", "bool", "shared", "Keep evidence of every check", group="checking", advanced=True),
    F("general", "recheck_days", "recheck_days", "int", "shared", "'Check due' re-checks links older than (days)", group="checking", advanced=True),
    F("general", "max_page_bytes", "max_page_bytes", "int", "shared", "Largest page to read (bytes)", group="checking", advanced=True),
    F("general", "user_agent", "user_agent", "str", "shared", "Checker name sent to sites", group="checking", advanced=True),
    F("dashboard", "port", "dashboard_port", "int", "shared", "Dashboard port", group="checking", advanced=True),
    F("search_console", "service_account_file", "gsc_service_account_file", "str", "shared", "Search Console service account file",
      group="extras", advanced=True),
)
BY_ATTR = {f.attr: f for f in SCHEMA}


# --------------------------------------------------------------------------- sites

@dataclass
class Site:
    id: str
    domain: str
    file: Path
    data_dir: Path
    legacy: bool = False


def site_id(domain: str) -> str:
    d = domain.strip().lower().removeprefix("https://").removeprefix("http://").split("/")[0].removeprefix("www.")
    if not re.fullmatch(r"[a-z0-9.-]+(:\d+)?", d) or "." not in d.split(":")[0] and d.split(":")[0] != "localhost":
        raise ValueError(f"'{domain}' doesn't look like a website address. Use the form example.com.")
    return d.replace(":", "_")


def _read(path: Path) -> dict:
    """A settings file as a dict. Accepts a UTF-8 BOM (Notepad's "UTF-8 with BOM")."""
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8-sig")
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise SettingsFileError(f"The settings file {path} has a mistake: {exc}. Fix it in a text editor, "
                                f"or replace it with {path.name}.bak (the copy from before the last save).") from None


class SettingsFileError(ValueError):
    """A settings file that can't be read."""


def _merge(a: dict, b: dict) -> dict:
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in a.items()}
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


def root_of(config_path: str | Path | None) -> Path:
    p = Path(config_path) if config_path else Path("config.toml")
    return p.resolve()


def list_sites(config_path: str | Path | None = None) -> list[Site]:
    root = root_of(config_path)
    base = root.parent
    sites: list[Site] = []
    raw = _read(root)
    legacy_domain = str(raw.get("project", {}).get("site", "")).strip()
    sdir = base / SITES_DIR
    if sdir.is_dir():
        for d in sorted(p for p in sdir.iterdir() if (p / SITE_FILE).is_file()):
            domain = str(_read(d / SITE_FILE).get("project", {}).get("site", "")).strip() or d.name
            sites.append(Site(d.name, domain, d / SITE_FILE, d / "data"))
    if legacy_domain and not any(s.id == _safe_id(legacy_domain) for s in sites):
        data = Path(raw.get("general", {}).get("data_dir", "data"))
        sites.insert(0, Site(_safe_id(legacy_domain), legacy_domain, root, data if data.is_absolute() else base / data, legacy=True))
    return sites


def _safe_id(domain: str) -> str:
    if re.fullmatch(r"[a-z0-9._-]+", domain or "") and "." in domain:
        return domain  # already an id
    try:
        return site_id(domain)
    except ValueError:
        return re.sub(r"[^a-z0-9.-]+", "-", domain.lower()) or "site"


def find_site(config_path, wanted: str | None) -> Site | None:
    sites = list_sites(config_path)
    if not sites:
        return None
    if not wanted:
        return sites[0]
    w = _safe_id(wanted)
    return next((s for s in sites if s.id == w or s.domain.lower().removeprefix("www.") == wanted.lower().removeprefix("www.")), None)


def load(config_path: str | Path | None = None, site: str | None = None) -> Config:
    """Config for one site (the first one when site is None). With no sites yet, the shared settings alone."""
    root = root_of(config_path)
    raw = _read(root)
    s = find_site(root, site)
    if site and s is None:
        raise KeyError(f"No site '{site}'. Add it with: linkverify sites add {site}")
    cfg = Config()
    if s is not None and not s.legacy:
        raw = _merge(_shared_only(raw), _read(s.file))
        raw.setdefault("general", {})
        raw["general"] = {**raw["general"], "data_dir": str(s.data_dir)}
    _apply(cfg, raw, base=root.parent)
    cfg.cache_dir = root.parent / "cache"  # shared by every site
    cfg.source_path = root if root.is_file() else None
    cfg.site_id = s.id if s else ""
    return cfg


def _shared_only(raw: dict) -> dict:
    """The root file without any per-site settings (a legacy site's brand must not leak into other sites)."""
    site_keys = {(f.section, f.key) for f in SCHEMA if f.scope == "site"}
    out: dict = {}
    for sec, val in raw.items():
        if isinstance(val, dict):
            kept = {k: v for k, v in val.items() if (sec, k) not in site_keys}
            if kept:
                out[sec] = kept
        else:
            out[sec] = val
    return out


COUNTRY_BY_TLD = {"au": 2036, "nz": 2554, "pk": 2586, "in": 2356, "ae": 2784, "uk": 2826, "ca": 2124}


def add_site(config_path, domain: str) -> Site:
    """Create sites/<domain>/ with its own settings file and data folder. An existing site is returned as is."""
    sid = site_id(domain)
    root = root_of(config_path)
    with _LOCK:
        existing = find_site(root, sid)
        if existing:
            return existing
        d = root.parent / SITES_DIR / sid
        (d / "data").mkdir(parents=True, exist_ok=True)
        clean = sid.replace("_", ":")
        raw: dict = {"project": {"site": clean}}
        country = COUNTRY_BY_TLD.get(clean.split(":")[0].rsplit(".", 1)[-1])
        if country:  # search the Google of the site's own country
            raw["dataforseo"] = {"location_code": country}
        _write_raw(d / SITE_FILE, raw, f"Settings for {clean}. Shared settings are in config.toml.")
        if not root.is_file():
            _write_raw(root, {}, "Shared settings for every site.")
        return find_site(root, sid)


def site_exists(config_path, domain: str) -> Site | None:
    try:
        return find_site(config_path, site_id(domain))
    except ValueError:
        return None


def remove_site(config_path, sid: str) -> Path:
    """Moves the site's folder to sites/_removed/ (nothing is deleted)."""
    with _LOCK:
        return _remove_site(config_path, sid)


def _remove_site(config_path, sid: str) -> Path:
    s = find_site(config_path, sid)
    if s is None or s.legacy:
        raise KeyError(f"No site '{sid}' to remove.")
    folder = s.file.parent
    dest = folder.parent / "_removed" / folder.name
    n = 1
    while dest.exists():
        n += 1
        dest = folder.parent / "_removed" / f"{folder.name}-{n}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    folder.rename(dest)
    return dest


# --------------------------------------------------------------------------- reading and writing settings

def values_for(cfg: Config, scope: str | None = None) -> dict:
    return {f.attr: getattr(cfg, f.attr) for f in SCHEMA if scope in (None, f.scope)}


def coerce(field: Field, value):
    """A value from the Settings screen, as the type the config needs. Raises ValueError with a readable message.
    An empty number box means "back to the default"; lists are one item per line."""
    if field.kind == "bool":
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if field.kind == "list":
        if isinstance(value, str):
            value = value.split("\n")
        if not isinstance(value, (list, tuple)):
            raise ValueError(f"{field.label}: expected one item per line.")
        return [str(x).strip() for x in value if str(x).strip()]
    if field.kind in ("int", "float"):
        text = str(value if value is not None else "").strip()
        if not text:
            return getattr(Config(), field.attr)
        try:
            return int(text) if field.kind == "int" else float(text)
        except ValueError:
            raise ValueError(f"{field.label}: enter a {'whole number' if field.kind == 'int' else 'number'}.") from None
    if isinstance(value, (dict, list)):
        raise ValueError(f"{field.label}: expected text.")
    v = str(value if value is not None else "").strip()
    if field.attr == "my_site":
        v = v.lower().removeprefix("https://").removeprefix("http://").strip("/").removeprefix("www.")
    return v


def _toml_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ", ".join(f"{_toml_key(k)} = {_toml_value(x)}" for k, x in v.items()) + "}"
    s = str(v)
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t").replace("\r", "\\r") + '"'


def _toml_key(k: str) -> str:
    return k if re.fullmatch(r"[A-Za-z0-9_-]+", k) else _toml_value(k)


_ORDER: dict[str, list[str]] = {}
for _f in SCHEMA:
    _ORDER.setdefault(_f.section, []).append(_f.key)
_LABEL = {(f.section, f.key): f.label for f in SCHEMA}


def _serialize(raw: dict, header: str) -> str:
    lines = [f"# {header}", "# Written by Backlink Verifier. You can edit it by hand too (save it as UTF-8).", ""]
    top = {k: v for k, v in raw.items() if not isinstance(v, dict)}
    for k, v in top.items():
        lines.append(f"{_toml_key(k)} = {_toml_value(v)}")
    if top:
        lines.append("")
    sections = [s for s in _ORDER if s in raw] + [s for s in raw if isinstance(raw[s], dict) and s not in _ORDER]
    for sec in sections:
        table = raw[sec]
        keys = [k for k in _ORDER.get(sec, []) if k in table] + [k for k in table if k not in _ORDER.get(sec, [])]
        lines.append(f"[{_toml_key(sec)}]")
        for k in keys:
            label = _LABEL.get((sec, k))
            lines.append(f"{_toml_key(k)} = {_toml_value(table[k])}" + (f"  # {label}" if label else ""))
        lines.append("")
    return "\n".join(lines)


def _write_raw(path: Path, raw: dict, header: str) -> None:
    """Write one settings file atomically (a crash never leaves a half-written file), keeping a .bak of the old one."""
    text = _serialize(raw, header)
    tomllib.loads(text)  # never write a file we can't read back
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp", newline="\n") as tmp:
        tmp.write(text)
    if path.exists():
        path.with_suffix(path.suffix + ".bak").write_bytes(path.read_bytes())
    Path(tmp.name).replace(path)


def save(config_path, site: str | None, changes: dict) -> Config:
    """Apply {attr: value} changes and write them into the right file. Returns the reloaded Config.

    Only the changed keys are written; everything else in both files stays exactly as it was
    (including another site's settings kept in an older single-site config.toml).
    A changed key goes to the file that already holds it, otherwise to its scope's file."""
    if not isinstance(changes, dict):
        raise ValueError("Settings changes must be a set of name and value pairs.")
    root = root_of(config_path)
    with _LOCK:
        s = find_site(root, site)
        coerced = {}
        for attr, value in changes.items():
            f = BY_ATTR.get(attr)
            if f is None:
                raise ValueError(f"Unknown setting {attr}")
            coerced[attr] = coerce(f, value)
        if "my_site" in coerced and (s is None or coerced["my_site"] != s.domain):
            raise ValueError("To change the website address, add it as a new site.")
        root_raw = _read(root)
        site_raw = _read(s.file) if s is not None and not s.legacy else None
        root_changed = site_changed = False
        for attr, value in coerced.items():
            f = BY_ATTR[attr]
            if site_raw is not None and (f.scope == "site" or f.key in site_raw.get(f.section, {})):
                site_raw.setdefault(f.section, {})[f.key] = value
                site_changed = True
            elif f.scope == "site" and s is None:
                raise ValueError("Add a website first, then its settings can be saved.")
            else:
                root_raw.setdefault(f.section, {})[f.key] = value
                root_changed = True
        if root_changed or not root.is_file():
            _write_raw(root, root_raw, "Backlink Verifier settings." if s is not None and s.legacy else "Shared settings for every site.")
        if site_changed:
            _write_raw(s.file, site_raw, f"Settings for {s.domain}. Shared settings are in config.toml.")
        return load(root, s.id if s else None)
