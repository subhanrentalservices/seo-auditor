"""Settings, read from config.toml (see config.example.toml)."""

from __future__ import annotations

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_UA = (
    "Mozilla/5.0 (compatible; BacklinkVerifier/0.4; personal link checker)"
)


@dataclass
class Config:
    data_dir: Path = Path("data")
    user_agent: str = DEFAULT_UA
    timeout_seconds: float = 20.0
    delay_seconds: float = 1.0  # minimum gap between requests to one host
    max_page_bytes: int = 5_000_000
    max_outbound_domains: int = 100  # above this a link is "Weak"
    render: bool = True  # use a headless browser for checks 4 and 12
    render_timeout_seconds: float = 30.0
    save_evidence: bool = True
    recheck_days: int = 7  # `check --due`: links not checked for this many days

    # monitor schedule: weekly while a link is new, then monthly
    weekly_days: int = 7
    monthly_days: int = 30
    intensive_period_days: int = 90
    alert_on: str = "changes"  # "changes" (bad and good) or "bad" (only problems)

    email_smtp_host: str = ""
    email_smtp_port: int = 587
    email_username: str = ""
    email_password: str = ""
    email_from: str = ""
    email_to: str = ""
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    dashboard_port: int = 8787

    ahrefs_api_key: str = ""
    dataforseo_login: str = ""
    dataforseo_password: str = ""
    dataforseo_location_code: int = 2840  # United States
    dataforseo_language_code: str = "en"
    gsc_service_account_file: str = ""
    gsc_property: str = ""  # e.g. "sc-domain:example.com" or "https://example.com/"

    dataforseo_monthly_budget_usd: float = 10.0  # the tool stops calling DataForSEO above this

    # Phase 3: your project, used by the opportunity finders
    my_site: str = ""
    brand_names: list[str] = field(default_factory=list)
    competitors: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    my_pages: list[str] = field(default_factory=list)

    # finders
    google_alerts_feeds: list[str] = field(default_factory=list)
    serp_mention_search: bool = True
    max_serp_queries_per_run: int = 10
    max_pages_fetched_per_run: int = 60
    gap_min_competitors: int = 2
    gap_limit: int = 200
    broken_limit: int = 200
    resource_footprints: list[str] = field(default_factory=lambda: [
        '"useful resources"', 'intitle:resources', 'inurl:links', '"recommended tools"', '"further reading"'])
    max_links_checked_per_page: int = 80
    auto_register_linked_mentions: bool = True
    daily_finders: list[str] = field(default_factory=lambda: ["mentions", "journalists"])
    weekly_finders: list[str] = field(default_factory=lambda: ["listings", "partners", "gap", "broken", "resources", "campaigns"])
    alert_min_score: int = 60

    # journalist requests
    imap_host: str = ""
    imap_port: int = 993
    imap_username: str = ""
    imap_password: str = ""
    imap_folder: str = "INBOX"
    journalist_senders: list[str] = field(default_factory=lambda: [
        "sourceofsources", "helpab2bwriter", "mentionmatch", "qwoted", "featured.com", "sourcebottle", "helpareporter"])
    journalist_days_back: int = 3
    bluesky_search: bool = True
    bluesky_hashtags: list[str] = field(default_factory=lambda: ["#journorequest"])

    # Phase 4: you (for drafts), AI drafting, campaigns
    profile_name: str = ""
    profile_title: str = ""
    profile_company: str = ""
    profile_email: str = ""
    profile_bio: str = ""
    profile_facts: list[str] = field(default_factory=list)  # true things you can say about yourself
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5-5"
    ahrefs_cache_days: int = 30
    campaign_active_days: int = 180
    graph_max_pages: int = 300  # pages read when mapping your site

    # free sources (no accounts, no email)
    use_tranco: bool = True  # free popularity ranking of the top million sites, as site strength
    mastodon_search: bool = True
    mastodon_instances: list[str] = field(default_factory=lambda: ["journa.host", "mastodon.social"])
    desktop_notifications: bool = True  # Windows notifications from the daily run
    cache_dir: Path | None = None  # shared downloads (the Tranco list); default <data_dir>/cache

    source_path: Path | None = field(default=None, repr=False)
    site_id: str = ""  # which site in a multi-site workspace (see workspace.py)

    @property
    def cache_path(self) -> Path:
        return self.cache_dir or (self.data_dir / "cache")

    @property
    def has_ai(self) -> bool:
        return bool(self.anthropic_api_key)

    @property
    def has_project(self) -> bool:
        return bool(self.my_site)

    @property
    def has_imap(self) -> bool:
        return bool(self.imap_host and self.imap_username and self.imap_password)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "links.db"

    @property
    def evidence_dir(self) -> Path:
        return self.data_dir / "evidence"

    @property
    def has_dataforseo(self) -> bool:
        return bool(self.dataforseo_login and self.dataforseo_password)

    @property
    def has_gsc(self) -> bool:
        return bool(self.gsc_service_account_file and self.gsc_property)

    @property
    def has_email(self) -> bool:
        return bool(self.email_smtp_host and self.email_to)

    @property
    def has_telegram(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)

    @property
    def log_dir(self) -> Path:
        return self.data_dir / "logs"


def load_config(path: str | Path | None = None) -> Config:
    cfg = Config()
    candidates = [Path(path)] if path else [Path("config.toml")]
    for p in candidates:
        if p.is_file():
            raw = tomllib.loads(p.read_text(encoding="utf-8-sig"))
            _apply(cfg, raw, base=p.parent)
            cfg.source_path = p
            break
    return cfg


def _apply(cfg: Config, raw: dict, base: Path) -> None:
    general = raw.get("general", {})
    for key in (
        "user_agent",
        "timeout_seconds",
        "delay_seconds",
        "max_page_bytes",
        "max_outbound_domains",
        "render",
        "render_timeout_seconds",
        "save_evidence",
        "recheck_days",
    ):
        if key in general:
            setattr(cfg, key, type(getattr(cfg, key))(general[key]))
    if "data_dir" in general:
        d = Path(general["data_dir"])
        cfg.data_dir = d if d.is_absolute() else base / d

    ahrefs = raw.get("ahrefs", {})
    cfg.ahrefs_api_key = str(ahrefs.get("api_key", "")).strip()

    d4s = raw.get("dataforseo", {})
    cfg.dataforseo_login = str(d4s.get("login", "")).strip()
    cfg.dataforseo_password = str(d4s.get("password", "")).strip()
    if "location_code" in d4s:
        cfg.dataforseo_location_code = int(d4s["location_code"])
    if "language_code" in d4s:
        cfg.dataforseo_language_code = str(d4s["language_code"])
    if "monthly_budget_usd" in d4s:
        cfg.dataforseo_monthly_budget_usd = float(d4s["monthly_budget_usd"])

    def strlist(v) -> list[str]:
        if isinstance(v, str):
            v = [v]
        return [str(x).strip() for x in (v or []) if str(x).strip()]

    proj = raw.get("project", {})
    cfg.my_site = str(proj.get("site", "")).strip().lower().removeprefix("https://").removeprefix("http://").strip("/")
    cfg.brand_names = strlist(proj.get("brand_names", []))
    cfg.competitors = strlist(proj.get("competitors", []))
    cfg.topics = strlist(proj.get("topics", []))
    cfg.my_pages = strlist(proj.get("pages", []))

    fnd = raw.get("finder", {})
    if "google_alerts_feeds" in fnd:
        cfg.google_alerts_feeds = strlist(fnd["google_alerts_feeds"])
    if "resource_footprints" in fnd:
        cfg.resource_footprints = strlist(fnd["resource_footprints"])
    for key in ("daily_finders", "weekly_finders"):
        if key in fnd:
            setattr(cfg, key, [x.lower() for x in strlist(fnd[key])])
    if cfg.weekly_finders == ["gap", "broken", "resources", "campaigns"]:  # the old default: add the free finders
        cfg.weekly_finders = ["listings", "partners"] + cfg.weekly_finders
    for key in ("max_serp_queries_per_run", "max_pages_fetched_per_run", "gap_min_competitors", "gap_limit",
                "broken_limit", "max_links_checked_per_page", "alert_min_score"):
        if key in fnd:
            setattr(cfg, key, int(fnd[key]))
    for key in ("serp_mention_search", "auto_register_linked_mentions"):
        if key in fnd:
            setattr(cfg, key, bool(fnd[key]))

    prof = raw.get("profile", {})
    cfg.profile_name = str(prof.get("name", "")).strip()
    cfg.profile_title = str(prof.get("title", "")).strip()
    cfg.profile_company = str(prof.get("company", "")).strip()
    cfg.profile_email = str(prof.get("email", "")).strip()
    cfg.profile_bio = str(prof.get("bio", "")).strip()
    cfg.profile_facts = strlist(prof.get("facts", []))

    drafting = raw.get("drafting", {})
    cfg.anthropic_api_key = str(drafting.get("anthropic_api_key", "")).strip()
    if drafting.get("model"):
        cfg.anthropic_model = str(drafting["model"]).strip()
    if "cache_days" in ahrefs:
        cfg.ahrefs_cache_days = int(ahrefs["cache_days"])
    if "max_pages" in raw.get("sitegraph", {}):
        cfg.graph_max_pages = int(raw["sitegraph"]["max_pages"])
    camp = raw.get("campaigns", {})
    if "active_days" in camp:
        cfg.campaign_active_days = int(camp["active_days"])

    jr = raw.get("journalist", {})
    cfg.imap_host = str(jr.get("imap_host", "")).strip()
    cfg.imap_port = int(jr.get("imap_port", 993))
    cfg.imap_username = str(jr.get("username", "")).strip()
    cfg.imap_password = str(jr.get("password", "")).strip()
    cfg.imap_folder = str(jr.get("folder", "INBOX")).strip() or "INBOX"
    if "senders" in jr:
        cfg.journalist_senders = [s.lower() for s in strlist(jr["senders"])]
    if "days_back" in jr:
        cfg.journalist_days_back = int(jr["days_back"])
    if "bluesky_search" in jr:
        cfg.bluesky_search = bool(jr["bluesky_search"])
    if "bluesky_hashtags" in jr:
        cfg.bluesky_hashtags = strlist(jr["bluesky_hashtags"])
    if "mastodon_search" in jr:
        cfg.mastodon_search = bool(jr["mastodon_search"])
    if "mastodon_instances" in jr:
        cfg.mastodon_instances = [x.lower().removeprefix("https://").strip("/") for x in strlist(jr["mastodon_instances"])]
    free = raw.get("free", {})
    if "tranco" in free:
        cfg.use_tranco = bool(free["tranco"])
    if "desktop_notifications" in raw.get("monitor", {}):
        cfg.desktop_notifications = bool(raw["monitor"]["desktop_notifications"])

    mon = raw.get("monitor", {})
    for key in ("weekly_days", "monthly_days", "intensive_period_days"):
        if key in mon:
            setattr(cfg, key, int(mon[key]))
    if "alert_on" in mon:
        cfg.alert_on = str(mon["alert_on"]).strip().lower()

    email = raw.get("email", {})
    cfg.email_smtp_host = str(email.get("smtp_host", "")).strip()
    cfg.email_smtp_port = int(email.get("smtp_port", 587))
    cfg.email_username = str(email.get("username", "")).strip()
    cfg.email_password = str(email.get("password", "")).strip()
    cfg.email_from = str(email.get("from", "") or cfg.email_username).strip()
    cfg.email_to = str(email.get("to", "")).strip()

    tg = raw.get("telegram", {})
    cfg.telegram_bot_token = str(tg.get("bot_token", "")).strip()
    cfg.telegram_chat_id = str(tg.get("chat_id", "")).strip()

    dash = raw.get("dashboard", {})
    if "port" in dash:
        cfg.dashboard_port = int(dash["port"])

    gsc = raw.get("search_console", {})
    sa = str(gsc.get("service_account_file", "")).strip()
    if sa and not Path(sa).is_absolute():
        sa = str(base / sa)
    cfg.gsc_service_account_file = sa
    cfg.gsc_property = str(gsc.get("property", "")).strip()
