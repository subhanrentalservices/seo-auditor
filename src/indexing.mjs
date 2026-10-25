// Index status: Google's URL Inspection for every page the latest audit says should be indexed, grouped by Google's
// reason, so "N pages not indexed" in Search Console becomes a list with a fix per reason. Read-only (no indexing
// requests); the API allows about 2,000 inspections a day per property, so a run is capped.
import { db, all, get, run, projectSettings } from "./db.mjs";
import { gsc, detectProperty } from "./gsc.mjs";
import { emit } from "./runner.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS index_status (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, url TEXT NOT NULL,
  verdict TEXT, coverage TEXT, indexing_state TEXT, robots TEXT, fetch_state TEXT, google_canonical TEXT, user_canonical TEXT,
  last_crawl TEXT, sitemap INTEGER, wanted INTEGER, inspected_at TEXT NOT NULL DEFAULT (datetime('now')), error TEXT, PRIMARY KEY (project_id, url));
CREATE TABLE IF NOT EXISTS index_runs (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, urls INTEGER, status TEXT, message TEXT);
`);

export const MAX_PER_RUN = 500;

// Google's coverage states (Search Console wording) → kind + what to do. Order matters: "Soft 404" before "404".
const RULES = [
  [/^Submitted and indexed|^Indexed/i, "indexed", "Indexed."],
  [/unknown to Google/i, "unknown", "Google hasn't found this page yet. Keep it in the sitemap, link to it from another page's text, then use Request indexing in Search Console."],
  [/Discovered - currently not indexed/i, "discovered", "Google knows the URL but hasn't crawled it yet. Link to it from strong pages' text; Request indexing for the important ones. New pages often wait a few weeks."],
  [/Crawled - currently not indexed/i, "crawled", "Google crawled it and chose not to index it yet. Usually the page looks thin or too similar to another: make it clearly different and useful, and link to it from related pages."],
  [/Alternate page with proper canonical/i, "alternate", "This URL's canonical points at another page, so Google indexes that one instead. Fine if intended."],
  [/different canonical|Duplicate/i, "duplicate", "Google treats this as a duplicate of the URL shown as Google's canonical. Make the content distinct, or point the canonical at the page you want indexed."],
  [/noindex/i, "noindex", "Google saw a noindex rule. Remove it if this page should be in Google."],
  [/redirect/i, "redirect", "Google sees a redirect here. Use the final URL in links and in the sitemap."],
  [/Soft 404/i, "soft404", "Google thinks the page is empty or an error page. Add real content, or return a proper 404/410 if it's gone."],
  [/404|Not found/i, "notfound", "Google got a 404. Restore the page, or redirect it to the closest page."],
  [/robots/i, "blocked", "robots.txt blocks Google from this page. Allow it if the page should be in Google."],
  [/Server error|5xx/i, "server", "Google got a server error. Check the server, then Request indexing again."],
];
export function classify(coverage, verdict) {
  for (const [re, kind, advice] of RULES) if (re.test(coverage || "")) return { kind, advice };
  if (verdict === "PASS") return { kind: "indexed", advice: "Indexed." };
  return { kind: "other", advice: "Open the URL in Search Console's URL inspection for details." };
}

/** One URL Inspection response → the fields stored. */
export function parseInspection(r) {
  const x = r?.inspectionResult?.indexStatusResult || {};
  return { verdict: x.verdict || null, coverage: x.coverageState || null, indexing_state: x.indexingState || null, robots: x.robotsTxtState || null,
    fetch_state: x.pageFetchState || null, google_canonical: x.googleCanonical || null, user_canonical: x.userCanonical || null,
    last_crawl: x.lastCrawlTime || null, sitemap: x.sitemap?.length ? 1 : 0 };
}

/** HTML pages from the latest finished audit: wanted = 200 and indexable; the rest (canonicalised, noindex, redirecting)
 *  should stay out of Google and are checked as "expected", so the counts line up with Search Console's. Wanted first. */
export function targets(projectId) {
  const a = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", projectId);
  if (!a) return [];
  return all(`SELECT url, (status=200 AND indexable=1) wanted FROM pages WHERE audit_id=? AND (content_type LIKE 'text/html%' OR status BETWEEN 300 AND 399)
    ORDER BY wanted DESC, depth, url`, a.id).map((r) => ({ url: r.url, wanted: r.wanted ? 1 : 0 }));
}

const realInspect = (property) => (url) => gsc("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { inspectionUrl: url, siteUrl: property });
const running = new Set();

export async function startIndexRun(project, { inspect } = {}) {
  if (running.has(project.id)) throw Object.assign(new Error("An index status check is already running"), { status: 409 });
  const urls = targets(project.id).slice(0, MAX_PER_RUN);
  if (!urls.length) throw Object.assign(new Error("Run an audit first: the check inspects the pages the audit found indexable"), { status: 400 });
  let call = inspect;
  if (!call) {
    const property = projectSettings(project).gscProperty || (await detectProperty(project.start_url));
    if (!property) throw Object.assign(new Error("No Search Console property for this site is shared with the service account"), { status: 400 });
    call = realInspect(property);
  }
  const runId = Number(run("INSERT INTO index_runs (project_id, urls, status) VALUES (?, ?, 'running')", project.id, urls.length).lastInsertRowid);
  const started = get("SELECT started_at s FROM index_runs WHERE id=?", runId).s;
  running.add(project.id);
  const job = (async () => {
    const queue = [...urls]; let done = 0, quota = null;
    const up = db.prepare(`INSERT OR REPLACE INTO index_status (project_id, url, verdict, coverage, indexing_state, robots, fetch_state, google_canonical, user_canonical, last_crawl, sitemap, wanted, inspected_at, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)`);
    const worker = async () => {
      while (queue.length && !quota) {
        const { url, wanted } = queue.shift();
        try {
          const x = parseInspection(await call(url));
          up.run(project.id, url, x.verdict, x.coverage, x.indexing_state, x.robots, x.fetch_state, x.google_canonical, x.user_canonical, x.last_crawl, x.sitemap, wanted, null);
        } catch (e) {
          const msg = e.response?.data?.error?.message || e.message;
          if (e.response?.status === 429 || /quota/i.test(msg)) quota = msg; // daily limit: stop, keep the last result for this page
          else up.run(project.id, url, null, null, null, null, null, null, null, null, null, wanted, String(msg).slice(0, 300));
        }
        emit({ type: "phase", projectId: project.id, auditId: null, phase: `Index status ${++done}/${urls.length}` });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // Pages no longer in the audit drop out of the list once a full run has replaced them.
    if (!quota) run("DELETE FROM index_status WHERE project_id=? AND inspected_at < ?", project.id, started);
    run("UPDATE index_runs SET status=?, finished_at=datetime('now'), message=? WHERE id=?", quota ? "stopped" : "done", quota, runId);
    running.delete(project.id);
    emit({ type: "phase", projectId: project.id, auditId: null, phase: null });
  })().catch((e) => { running.delete(project.id); run("UPDATE index_runs SET status='failed', message=? WHERE id=?", e.message, runId); });
  return { runId, urls: urls.length, done: job };
}

export function indexData(projectId) {
  const rows = all("SELECT * FROM index_status WHERE project_id=? ORDER BY url", projectId).map((r) => ({ ...r, ...classify(r.coverage, r.verdict) }));
  const ok = rows.filter((r) => !r.error), want = ok.filter((r) => r.wanted), rest = ok.filter((r) => !r.wanted);
  const groups = {};
  for (const r of want) groups[r.kind] = (groups[r.kind] || 0) + 1;
  return { running: running.has(projectId), lastRun: get("SELECT * FROM index_runs WHERE project_id=? ORDER BY id DESC LIMIT 1", projectId) || null,
    pending: targets(projectId).length, total: want.length, indexed: groups.indexed || 0, notIndexed: want.length - (groups.indexed || 0),
    expected: rest.filter((r) => r.kind !== "indexed").length,
    // A URL the site keeps out of Google (canonical elsewhere, noindex, redirect) that Google indexed anyway: a duplicate risk.
    strayIndexed: rest.filter((r) => r.kind === "indexed").length,
    errors: rows.filter((r) => r.error).length, groups, rows };
}

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || (() => { throw Object.assign(new Error("Project not found"), { status: 404 }); })();
  routes.push(["GET", /^\/api\/projects\/(\d+)\/indexing$/, ([id]) => indexData(project(id).id)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/indexing$/, async ([id]) => { const r = await startIndexRun(project(id)); return { runId: r.runId, urls: r.urls }; }]);
}
