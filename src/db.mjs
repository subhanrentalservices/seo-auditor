// SQLite storage (Node's built-in node:sqlite, no native build). One file: data/seo-auditor.db
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Data folder: data/ next to the code, or SEO_AUDITOR_DATA (the installed desktop app uses the user's app-data folder).
export const DATA = process.env.SEO_AUDITOR_DATA ? path.resolve(process.env.SEO_AUDITOR_DATA) : path.join(ROOT, "data");
mkdirSync(DATA, { recursive: true });
export const db = new DatabaseSync(path.join(DATA, "seo-auditor.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_url TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued', started_at TEXT, finished_at TEXT,
  pages_crawled INTEGER DEFAULT 0, pages_queued INTEGER DEFAULT 0,
  health INTEGER, errors INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, notices INTEGER DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}', message TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY, audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  url TEXT NOT NULL, final_url TEXT, status INTEGER, depth INTEGER, content_type TEXT,
  response_ms INTEGER, bytes INTEGER, title TEXT, description TEXT, h1 TEXT, canonical TEXT,
  indexable INTEGER, in_sitemap INTEGER DEFAULT 0, inlinks INTEGER DEFAULT 0, outlinks INTEGER DEFAULT 0,
  words INTEGER, text_ratio REAL, data TEXT NOT NULL DEFAULT '{}',
  UNIQUE(audit_id, url)
);
CREATE TABLE IF NOT EXISTS links (
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  from_url TEXT NOT NULL, to_url TEXT NOT NULL, anchor TEXT, internal INTEGER, nofollow INTEGER, kind TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY, audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  check_id TEXT NOT NULL, severity TEXT NOT NULL, url TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS cwv (
  audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  url TEXT NOT NULL, lcp_ms INTEGER, cls REAL, tbt_ms INTEGER, transfer_kb INTEGER
);
CREATE TABLE IF NOT EXISTS gsc (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL,
  start_date TEXT, end_date TEXT, fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, url)
);
CREATE INDEX IF NOT EXISTS idx_pages_audit ON pages(audit_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS page_text (audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE, url TEXT NOT NULL, text TEXT, PRIMARY KEY (audit_id, url));
CREATE INDEX IF NOT EXISTS idx_links_audit_to ON links(audit_id, to_url);
CREATE INDEX IF NOT EXISTS idx_links_audit_from ON links(audit_id, from_url);
CREATE INDEX IF NOT EXISTS idx_issues_audit ON issues(audit_id, check_id);
`);

// Additive migrations for databases created by older versions.
for (const [table, col, type] of [["audits", "ai_readiness", "INTEGER"], ["audits", "site_info", "TEXT"],
  ["cwv", "fcp_ms", "INTEGER"], ["cwv", "si_ms", "INTEGER"], ["cwv", "perf", "INTEGER"], ["cwv", "a11y", "INTEGER"], ["cwv", "bp", "INTEGER"],
  ["cwv", "seo", "INTEGER"], ["cwv", "details", "TEXT"], ["cwv", "error", "TEXT"], ["links", "placement", "TEXT"], ["links", "rel", "TEXT"]]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

export const DEFAULT_SETTINGS = {
  maxPages: 0,            // 0 = no limit
  concurrency: 6,
  respectRobots: true,
  renderJs: false,        // render each page in headless Chromium (slower)
  includeSubdomains: false,
  checkExternalLinks: true,
  auditBlockedUrls: false, // opt-in: fetch robots.txt-blocked URLs the site links to once, to find a noindex Google can't see (own sites only)
  siteProbes: false,      // opt-in, own sites only: up to 60 extra requests after the crawl: search pages, Googlebot/smartphone parity, staging hosts, 304/compression, secret files, TLS expiry, language redirects
  userAgent: "Mozilla/5.0 (compatible; SEOAuditor/1.0; +local)",
  schedule: "off",        // off | daily | weekly
  cwvPages: 5,            // pages measured for Core Web Vitals (0 = off)
  gscProperty: "",        // e.g. "https://example.com/" or "sc-domain:example.com"
  dfsLocation: 2036,      // DataForSEO location code (2036 = Australia, 2840 = USA, 2826 = UK)
  dfsLanguage: "en",
  brandTerms: "",         // extra names that count as a brand mention in AI answers (comma-separated)
  spamAllowTerms: "",     // words hacked_spam_signals never reports on this site, e.g. "casino" for a casino's own site (comma-separated)
  targetKeywords: "",     // searches the owner wants to be found for, one per line (queries.mjs targetReport; up to 4,000 characters)
  aiLocation: 0,          // DataForSEO location for AI/SERP checks (0 = same as dfsLocation; 9199156 = Dandenong VIC)
  localFolder: "",        // optional: folder with the site's files, for file/line hints
  napName: "",            // business listings: name, address and phone to check listings against
  napAddress: "",         // (empty = read from the home page's LocalBusiness JSON-LD)
  napPhone: "",
};

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function projectSettings(project) {
  return { ...DEFAULT_SETTINGS, ...JSON.parse(project.settings || "{}") };
}
