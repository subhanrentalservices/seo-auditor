// Business listings (citations): the directory pages that list the business (Yellow Pages, TrueLocal, Facebook...)
// checked against the site's own name, address and phone. Google trusts a local business more when every listing
// agrees, so a listing with an old address or a different phone is worth fixing. The reference details come from the
// home page's LocalBusiness/Organization JSON-LD, or from Settings when filled in. Read-only: one GET per listing.
import * as cheerio from "cheerio";
import { db, all, get, run, projectSettings } from "./db.mjs";
import { emit } from "./runner.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS citations (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, url TEXT NOT NULL,
  site TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')), checked_at TEXT, http INTEGER, status TEXT,
  name_ok INTEGER, address_ok INTEGER, phone_ok INTEGER, website_ok INTEGER, other_phones TEXT, error TEXT, PRIMARY KEY (project_id, url));
`);

const ABBR = { st: "street", rd: "road", hwy: "highway", ave: "avenue", av: "avenue", dr: "drive", pde: "parade", cres: "crescent", cr: "crescent",
  ct: "court", pl: "place", ln: "lane", blvd: "boulevard", bvd: "boulevard", cct: "circuit", tce: "terrace", hwys: "highways", mt: "mount" };

/** Lower case, entities and punctuation gone, street abbreviations spelled out: "12 Example St." and "12 Example Street" match. */
export function normText(s) {
  return String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[’'`]/g, "").replace(/[^a-z0-9&]+/g, " ")
    .split(" ").filter(Boolean).map((w) => ABBR[w] || w).join(" ");
}

/** Australian phone → national digits ("+61 3 9000 1234" and "(03) 9000 1234" → "0390001234"). */
export function normPhone(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("61") && d.length === 11) d = "0" + d.slice(2);
  return d;
}

/** Australian phone numbers written in a text (landlines, mobiles, 13/1300/1800), normalised and de-duplicated. */
export function phonesIn(text) {
  const re = /(?:\+?61[\s.-]?\(?0?\)?|\(?0)[2-478]\)?(?:[\s.-]?\d){8}(?!\d)|\b1[38]00(?:[\s.-]?\d){6}(?!\d)|\b13(?:[\s.-]?\d){4}(?!\d)/g;
  return [...new Set((String(text).match(re) || []).map(normPhone))];
}

const BIZ_TYPES = /LocalBusiness|AutoRepair|AutomotiveBusiness|AutoBodyShop|Store|Organization|Corporation|ProfessionalService|HomeAndConstructionBusiness|Restaurant|MedicalBusiness|LegalService/;

/** Name, address and phone from a page's JSON-LD (the first business-like node with an address or phone). */
export function napFromHtml(html) {
  const $ = cheerio.load(html);
  let found = null;
  const walk = (o) => {
    if (found || !o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    const types = [].concat(o["@type"] || []).join(" ");
    if (BIZ_TYPES.test(types) && (o.address || o.telephone)) {
      const a = Array.isArray(o.address) ? o.address[0] : o.address;
      const address = typeof a === "string" ? a
        : a ? [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(", ") : "";
      found = { name: o.name || "", address, phone: o.telephone || "" };
      return;
    }
    Object.values(o).forEach(walk);
  };
  $('script[type="application/ld+json"]').each((_, el) => { try { walk(JSON.parse($(el).text())); } catch { /* invalid JSON-LD */ } });
  return found;
}

/** The address split into the parts a listing must show: street line, suburb, postcode (state is often left out). */
export function addressParts(address) {
  const parts = String(address || "").split(",").map((s) => s.trim()).filter(Boolean);
  const postcode = (String(address).match(/\b\d{4}\b(?!.*\b\d{4}\b)/) || [""])[0];
  const street = parts[0] || "";
  const suburb = (parts[1] || "").replace(/\b(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\b|\b\d{4}\b/gi, "").trim();
  return { street: normText(street), suburb: normText(suburb), postcode };
}

/** One listing page against the business's details. */
export function compareListing(html, nap, siteUrl) {
  const $ = cheerio.load(html);
  const ld = $('script[type="application/ld+json"]').map((_, el) => $(el).text()).get().join(" ");
  const tels = $('a[href^="tel:"]').map((_, el) => $(el).attr("href").slice(4)).get().join(" ");
  // Tags become spaces, so "3999</p><p>Ph" doesn't glue words and numbers together.
  const visible = html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ");
  const text = `${visible} ${ld} ${tels}`;
  const flat = normText(text);
  const words = normText(nap.name).split(" ").filter((w) => !["pty", "ltd", "group", "the"].includes(w));
  const name_ok = words.length > 0 && words.every((w) => flat.includes(w)) ? 1 : 0;
  const a = addressParts(nap.address);
  const address_ok = a.street && flat.includes(a.street) && (!a.suburb || flat.includes(a.suburb)) && (!a.postcode || text.includes(a.postcode)) ? 1 : 0;
  const ours = normPhone(nap.phone);
  const phones = phonesIn(text);
  const phone_ok = ours && phones.includes(ours) ? 1 : 0;
  const host = new URL(siteUrl).hostname.replace(/^www\./, "");
  const website_ok = html.includes(host) || html.includes(encodeURIComponent("https://" + host)) ? 1 : 0;
  const other = phones.filter((p) => p !== ours && !/^1[38]00|^13\d{4}$/.test(p)); // directories' own 1300 numbers aren't the business's
  const status = name_ok && address_ok && phone_ok ? "match" : "mismatch";
  return { status, name_ok, address_ok, phone_ok, website_ok, other_phones: other.slice(0, 5) };
}

/** The details listings are checked against: Settings first, else the home page's JSON-LD. */
export async function referenceNap(project, fetchPage = realFetch) {
  const s = projectSettings(project);
  if (s.napName && s.napAddress && s.napPhone) return { name: s.napName, address: s.napAddress, phone: s.napPhone, source: "settings" };
  const r = await fetchPage(project.start_url);
  const nap = r.ok ? napFromHtml(r.html) : null;
  if (!nap) return null;
  return { name: s.napName || nap.name, address: s.napAddress || nap.address, phone: s.napPhone || nap.phone, source: "site" };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 SEOAuditor/1.0";
async function realFetch(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-AU,en;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html };
  } catch (e) { return { ok: false, status: 0, html: "", error: e.message }; }
}
// Bot walls answer 200 with a challenge page as well as 403/429/503.
const BLOCKED = /captcha|cf-chl|challenge-platform|access denied|are you a robot|verify you are human|enable javascript and cookies/i;

export function siteName(url) {
  const h = new URL(url).hostname.replace(/^www\.|^m\.|^au\./, "");
  return h.split(".")[0];
}

export function addCitation(projectId, url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw Object.assign(new Error("Enter the full listing address, starting with https://"), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error("Only web addresses (https://) can be checked"), { status: 400 });
  run("INSERT OR IGNORE INTO citations (project_id, url, site) VALUES (?,?,?)", projectId, u.href, siteName(u.href));
  return { url: u.href };
}
export function removeCitation(projectId, url) { run("DELETE FROM citations WHERE project_id=? AND url=?", projectId, String(url)); return { ok: true }; }

const running = new Set();
export async function checkCitations(project, { fetchPage = realFetch } = {}) {
  if (running.has(project.id)) throw Object.assign(new Error("A listing check is already running"), { status: 409 });
  const rows = all("SELECT url FROM citations WHERE project_id=?", project.id);
  if (!rows.length) throw Object.assign(new Error("Add the listing pages first (one web address each)"), { status: 400 });
  const nap = await referenceNap(project, fetchPage);
  if (!nap) throw Object.assign(new Error("No business name, address and phone found: add LocalBusiness JSON-LD to the home page, or fill them in Settings"), { status: 400 });
  running.add(project.id);
  const up = db.prepare(`UPDATE citations SET checked_at=datetime('now'), http=?, status=?, name_ok=?, address_ok=?, phone_ok=?, website_ok=?, other_phones=?, error=?
    WHERE project_id=? AND url=?`);
  const job = (async () => {
    let done = 0;
    for (const { url } of rows) {
      const r = await fetchPage(url);
      const wall = BLOCKED.test(r.html.slice(0, 20000));
      const c = r.ok ? compareListing(r.html, nap, project.start_url) : null;
      if (c && !(wall && !c.phone_ok)) {
        up.run(r.status, c.status, c.name_ok, c.address_ok, c.phone_ok, c.website_ok, JSON.stringify(c.other_phones), null, project.id, url);
      } else {
        const st = wall || [401, 403, 429, 503].includes(r.status) ? "blocked" : [404, 410].includes(r.status) ? "gone" : "error";
        up.run(r.status || null, st, null, null, null, null, null, r.error || (wall ? "Bot check page" : `HTTP ${r.status}`), project.id, url);
      }
      emit({ type: "phase", projectId: project.id, auditId: null, phase: `Listings ${++done}/${rows.length}` });
    }
    running.delete(project.id);
    emit({ type: "phase", projectId: project.id, auditId: null, phase: null });
  })().catch((e) => { running.delete(project.id); console.error("citations:", e.message); });
  return { urls: rows.length, nap, done: job };
}

const ADVICE = {
  match: "Name, address and phone match the site.",
  mismatch: "Edit this listing so the name, address and phone are exactly as on the site (claim it first if needed).",
  blocked: "The directory blocks automated checks. Open it and compare the name, address and phone by eye.",
  gone: "The listing page no longer exists. Remove it here, or recreate the listing.",
  error: "The page could not be loaded. Check the address and try again.",
};
export function citationsData(project) {
  const s = projectSettings(project);
  const rows = all("SELECT * FROM citations WHERE project_id=? ORDER BY status='match', site, url", project.id)
    .map((r) => ({ ...r, other_phones: JSON.parse(r.other_phones || "[]"), advice: r.status ? ADVICE[r.status] : "Not checked yet." }));
  const count = (st) => rows.filter((r) => r.status === st).length;
  return { running: running.has(project.id), napSettings: { name: s.napName || "", address: s.napAddress || "", phone: s.napPhone || "" },
    total: rows.length, match: count("match"), mismatch: count("mismatch"), blocked: count("blocked"), unchecked: rows.filter((r) => !r.status).length,
    noWebsite: rows.filter((r) => r.status === "match" && !r.website_ok).length, rows };
}

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || (() => { throw Object.assign(new Error("Project not found"), { status: 404 }); })();
  routes.push(["GET", /^\/api\/projects\/(\d+)\/citations$/, ([id]) => citationsData(project(id))]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/citations$/, ([id], q, b) => addCitation(project(id).id, b.url)]);
  routes.push(["DELETE", /^\/api\/projects\/(\d+)\/citations$/, ([id], q) => removeCitation(project(id).id, q.url)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/citations\/check$/, async ([id]) => { const r = await checkCitations(project(id)); return { urls: r.urls, nap: r.nap }; }]);
}
