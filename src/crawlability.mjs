// Crawlability: can Google reach and fetch the site the way it is meant to be fetched? Site-level checks from
// Google Search Central's crawling docs (robots.txt handling, soft 404s, host variants, blocked resources) plus the
// helpers the crawler uses for page-level ones. Read-only: a few extra requests per audit.
import robotsParser from "robots-parser";

/** One request without following redirects; network errors keep their code (ENOTFOUND, ERR_TLS_CERT_ALTNAME_INVALID, …). */
export async function probe(url, ua, timeout = 15000) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeout), headers: { "User-Agent": ua, Accept: "text/html,*/*;q=0.8" } });
    const type = res.headers.get("content-type") || "";
    const body = res.status === 200 && /html/.test(type) ? (await res.text()).slice(0, 2_000_000) : "";
    return { status: res.status, location: res.headers.get("location"), body };
  } catch (e) {
    const code = e.cause?.code || e.code || (e.name === "TimeoutError" ? "TIMEOUT" : "ERROR");
    return { status: 0, error: code, detail: e.cause?.message || e.message };
  }
}

const TLS = /TLS|CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ALTNAME/i;
const DNS = /ENOTFOUND|EAI_AGAIN|ENODATA/;

/** Follows a host variant to where it ends up: [{url, status}] hops, or the network error that stopped it. */
async function follow(url, ua, get, max = 5) {
  const hops = [];
  let cur = url;
  for (let i = 0; i <= max; i++) {
    const r = await get(cur, ua);
    hops.push({ url: cur, status: r.status, error: r.error });
    if (r.status >= 300 && r.status < 400 && r.location) { cur = new URL(r.location, cur).href; continue; }
    return hops;
  }
  return hops;
}

/** http://, https://, with and without www: every variant should 301 to the site's own address over valid TLS. */
export async function hostVariants(start, ua, get = probe) {
  const u = new URL(start);
  const bare = u.hostname.replace(/^www\./, ""), canonical = u.origin;
  const out = [];
  for (const proto of ["https:", "http:"]) for (const host of [bare, "www." + bare]) {
    const origin = `${proto}//${host}`;
    if (origin === canonical) continue;
    const hops = await follow(origin + "/", ua, get);
    const last = hops.at(-1);
    if (last.error && DNS.test(last.error) && hops.length === 1) { out.push(["host_variant_missing", origin + "/", `${host} has no DNS record: typing it gives a "site can't be reached" error`]); continue; }
    const bad = hops.find((h) => h.error && TLS.test(h.error));
    if (bad) { out.push(["host_variant_tls", origin + "/", `${new URL(bad.url).host}: certificate doesn't cover this name (${bad.error})${hops.length > 1 ? ` after ${hops.slice(0, -1).map((h) => h.status).join(" → ")}` : ""}`]); continue; }
    if (last.error) { out.push(["host_variant_missing", origin + "/", `${last.error} at ${last.url}`]); continue; }
    const end = new URL(last.url).origin;
    if (end !== canonical || last.status !== 200) out.push(["host_variant_redirect", origin + "/", `ends at ${last.url} (HTTP ${last.status}), not ${canonical}/`]);
    else if (![301, 308].includes(hops[0].status)) out.push(["host_variant_redirect", origin + "/", `first redirect is ${hops[0].status}, use 301`]);
  }
  return out;
}

const assetUrls = (html, base) => {
  const out = new Set();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) out.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (/rel=["']?stylesheet/i.test(m[0])) { const h = m[0].match(/href=["']([^"']+)["']/i); if (h) out.add(h[1]); }
  return [...out].map((x) => { try { return new URL(x, base).href; } catch { return null; } }).filter((x) => x && new URL(x).origin === new URL(base).origin);
};

/** Site checks: robots.txt errors, size and blanket disallow, blocked CSS/JS, soft 404s, host variants. Returns [[id, url, detail]]. */
export async function crawlabilitySiteIssues({ start, robotsRes, robotsTxt, robots, ua, get = probe }) {
  const origin = new URL(start).origin, out = [];
  if (robotsRes.status >= 500 || robotsRes.status === 0 || robotsRes.error)
    out.push(["robots_txt_error", origin + "/robots.txt", robotsRes.error ? `no response (${robotsRes.error})` : `HTTP ${robotsRes.status}`]);
  if (robotsTxt.length > 500 * 1024) out.push(["robots_txt_large", origin + "/robots.txt", `${Math.round(robotsTxt.length / 1024)} KiB`]);
  if (robotsTxt && robots.isAllowed(start, "Googlebot") === false) out.push(["robots_disallow_all", origin + "/robots.txt", "Googlebot may not fetch the start page"]);
  else if (robotsTxt) {
    const home = await get(start, ua);
    const blocked = home.body ? assetUrls(home.body, start).filter((x) => robots.isAllowed(x, "Googlebot") === false) : [];
    if (blocked.length) out.push(["robots_blocks_resources", start, `${blocked.length} file(s), e.g. ${blocked.slice(0, 3).join(", ")}`]);
  }
  const missing = `${origin}/seo-auditor-missing-page-${Date.now().toString(36)}.html`;
  const r404 = await get(missing, ua);
  if (r404.status === 200) out.push(["soft_404", missing, "a page that doesn't exist answers HTTP 200"]);
  out.push(...(await hostVariants(start, ua, get)));
  return out;
}

/** URL parameter traps: one path crawled under many ?query variants. */
export function paramTraps(urls, min = 30) {
  const byPath = new Map();
  for (const u of urls) { const x = new URL(u); if (!x.search) continue; const k = x.origin + x.pathname; byPath.set(k, (byPath.get(k) || 0) + 1); }
  return [...byPath].filter(([, n]) => n >= min).map(([path, n]) => [path, n]);
}

// ---------------- Google crawl checks (REQ-046, 2026-10-26; Google Search Central docs) ----------------

// Elements the HTML parser keeps inside <head>; any other element, or text, closes the head and starts the body.
const HEAD_OK = new Set(["base", "basefont", "bgsound", "link", "meta", "title", "style", "script", "noscript", "template", "html", "head"]);
const RAW_TEXT = new Set(["script", "style", "title", "noscript", "template"]); // contents are skipped, not parsed as tags
const START_TAG = /<([a-zA-Z][^\s/>]*)(?:[^>"']|"[^"]*"|'[^']*')*>/y;
const stripInert = (s) => s.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "");

/** Scans the RAW HTML source (not a repaired DOM) from <head> for the first element or text that isn't allowed there.
 *  Returns null when the head is well-formed or nothing important follows the break; otherwise
 *  { element, line, tags: [...], robots } where tags lists the canonical / hreflang links the parser moves into the
 *  body. Comments and the contents of script, style, noscript, template and title are ignored. */
export function headClosedEarly(html) {
  html = String(html || "");
  const lower = html.toLowerCase();
  const startAt = (re) => { const m = re.exec(html); return m ? m.index + m[0].length : -1; };
  let i = startAt(/<head(?=[\s>/])[^>]*>/i);
  if (i < 0) i = startAt(/<html(?=[\s>/])[^>]*>/i);
  if (i < 0) i = Math.max(0, startAt(/<!doctype[^>]*>/i));
  let brk = null;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const text = html.slice(i, lt < 0 ? html.length : lt);
    const nonSpace = text.search(/\S/);
    if (nonSpace >= 0) { brk = { element: `text "${text.trim().slice(0, 30)}"`, at: i + nonSpace }; break; }
    if (lt < 0) break;
    i = lt;
    if (lower.startsWith("<!--", i)) { const e = html.indexOf("-->", i + 4); i = e < 0 ? html.length : e + 3; continue; }
    if (lower.startsWith("<!", i) || lower.startsWith("<?", i)) { const e = html.indexOf(">", i); i = e < 0 ? html.length : e + 1; continue; }
    if (lower.startsWith("</", i)) {
      const name = lower.slice(i + 2, i + 40).match(/^[a-z][^\s>/]*/)?.[0];
      if (name === "head" || name === "body" || name === "html") break; // the head ends where it should
      if (name === "br") { brk = { element: "</br>", at: i }; break; }
      const e = html.indexOf(">", i); i = e < 0 ? html.length : e + 1; continue; // other stray end tags are ignored
    }
    START_TAG.lastIndex = i;
    const m = START_TAG.exec(html);
    if (!m) { brk = { element: 'text "<"', at: i }; break; }
    const name = m[1].toLowerCase();
    if (name === "body") break;
    if (!HEAD_OK.has(name)) { brk = { element: `<${name}>`, at: i }; break; }
    i = m.index + m[0].length;
    if (RAW_TEXT.has(name)) { const e = lower.indexOf("</" + name, i); i = e < 0 ? html.length : e; }
  }
  if (!brk) return null;
  const rest = html.slice(brk.at);
  const end = rest.search(/<\/head\s*>|<body[\s>]/i);
  const region = stripInert(end < 0 ? rest : rest.slice(0, end));
  const tags = [];
  if (/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bcanonical\b/i.test(region)) tags.push("canonical");
  const hl = (region.match(/<link\b[^>]*\bhreflang\s*=/gi) || []).length;
  if (hl) tags.push(`${hl} hreflang link(s)`);
  if (!tags.length) return null; // Google honours a robots meta tag in the body, so that alone is not a problem
  const robots = /<meta\b[^>]*\bname\s*=\s*["']?(?:robots|googlebot)\b/i.test(region);
  return { element: brk.element, line: html.slice(0, brk.at).split("\n").length, tags, robots };
}

const robotsLines = (t) => String(t || "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
  .map((l) => { const k = l.indexOf(":"); if (k < 0) return l; const key = l.slice(0, k).trim().toLowerCase(), v = l.slice(k + 1).trim(); return `${key}: ${key === "user-agent" ? v.toLowerCase() : v}`; });
const label = (l) => l.replace(/^[a-z-]+/, (k) => k.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("-"));

/** robots.txt now vs the previous finished audit. prevPages: URLs that were 200 and indexable then. Comment-only and
 *  whitespace edits don't count. Returns [[id, url, detail]]: robots_txt_changed for any rule change, and
 *  robots_disallow_added when the new file blocks Googlebot from a previously indexable URL, or blocks Googlebot or
 *  every crawler (*) from the whole site. */
export function robotsDiff(prevTxt, curTxt, prevPages, origin, prevAudit) {
  const a = robotsLines(prevTxt), b = robotsLines(curTxt);
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const ca = count(a), cb = count(b);
  const added = [...cb].flatMap(([l, n]) => Array(Math.max(0, n - (ca.get(l) || 0))).fill(l));
  const removed = [...ca].flatMap(([l, n]) => Array(Math.max(0, n - (cb.get(l) || 0))).fill(l));
  if (!added.length && !removed.length) return [];
  const url = origin + "/robots.txt", since = prevAudit ? ` since audit #${prevAudit}` : "";
  const out = [["robots_txt_changed", url, `${added.length} line(s) added, ${removed.length} removed${since}: ` +
    [...added.map((l) => "+ " + label(l)), ...removed.map((l) => "- " + label(l))].slice(0, 6).join("; ")]];
  const before = robotsParser(url, prevTxt || ""), after = robotsParser(url, curTxt || "");
  const blocks = (r, u, ua) => r.isAllowed(u, ua) === false;
  const whole = (r, ua) => blocks(r, origin + "/", ua) && blocks(r, origin + "/seo-auditor-any-path.html", ua);
  const blanket = [["Googlebot", "Googlebot"], ["*", "SEOAuditorAnyBot"]].filter(([, ua]) => whole(after, ua) && !whole(before, ua)).map(([n]) => n);
  const newly = [...new Set(prevPages || [])].filter((u) => !blocks(before, u, "Googlebot") && blocks(after, u, "Googlebot"));
  const rules = added.filter((l) => l.startsWith("disallow:") && l !== "disallow:").map(label);
  if (blanket.length || newly.length) out.push(["robots_disallow_added", url, [
    blanket.length ? `Disallow: / now blocks ${blanket.join(" and ")} from the whole site` : "",
    newly.length ? `${newly.length} page(s) indexable in audit #${prevAudit ?? "?"} now blocked for Googlebot, e.g. ${newly.slice(0, 2).join(", ")}` : "",
    rules.length ? `new rule(s): ${rules.slice(0, 3).join(", ")}` : ""].filter(Boolean).join("; ")]);
  return out;
}

/** Width/height and format of an image file from its first bytes (PNG, GIF, BMP, ICO, JPEG, SVG; WebP format only). */
export function imageSize(buf) {
  if (!buf || buf.length < 10) return null;
  const b = Buffer.from(buf);
  if (b.readUInt32BE(0) === 0x89504e47 && b.length >= 24) return { format: "PNG", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString("latin1", 0, 4) === "GIF8") return { format: "GIF", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.toString("latin1", 0, 2) === "BM" && b.length >= 26) return { format: "BMP", width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  if (b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 && b.readUInt16LE(4) > 0) {
    let best = null;
    for (let k = 0, o = 6; k < b.readUInt16LE(4) && o + 16 <= b.length; k++, o += 16) {
      const w = b[o] || 256, h = b[o + 1] || 256;
      if (!best || w * h > best.width * best.height) best = { format: "ICO", width: w, height: h };
    }
    return best || { format: "ICO" };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length && b[i] === 0xff;) {
      const mk = b[i + 1];
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { format: "JPEG", width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { format: "JPEG" };
  }
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { format: "WebP" };
  const svg = b.toString("utf8", 0, Math.min(b.length, 4096)).match(/<svg\b[^>]*>/i);
  if (svg) {
    const num = (n) => { const m = svg[0].match(new RegExp(`\\s${n}\\s*=\\s*["']?\\s*([\\d.]+)(?:px)?\\s*["'\\s/>]`, "i")); return m ? +m[1] : null; };
    const vb = svg[0].match(/\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    return { format: "SVG", width: num("width") ?? (vb ? +vb[1] : null), height: num("height") ?? (vb ? +vb[2] : null), vector: true };
  }
  return null;
}

/** GET a file as bytes (redirects followed, capped). */
export async function fetchBytes(url, ua, max = 2_000_000) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "User-Agent": ua, Accept: "*/*" } });
    const bytes = res.status === 200 ? Buffer.from(await res.arrayBuffer()).subarray(0, max) : Buffer.alloc(0);
    return { status: res.status, type: res.headers.get("content-type") || "", bytes };
  } catch (e) { return { status: 0, error: e.cause?.code || e.name, bytes: Buffer.alloc(0) }; }
}

const ICON_FORMATS = new Set(["BMP", "GIF", "ICO", "PNG", "JPEG", "PPM", "TIFF"]); // Google's favicon guidelines
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")) || []).slice(1).find((x) => x !== undefined);

/** Favicon for Google Search (home page only): declared with <link rel=icon|shortcut icon|apple-touch-icon>, crawlable
 *  by Googlebot-Image, HTTP 200, a format Google lists, square, 48x48 or larger when the size is known. Fine when any
 *  declared icon passes (first 3 checked). Returns [[id, url, detail]]. */
export async function faviconIssues({ start, html, robotsTxt = "", ua, getBytes = fetchBytes }) {
  const links = [...stripInert(String(html || "")).matchAll(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
    .map((m) => ({ rel: (attr(m[0], "rel") || "").toLowerCase().split(/\s+/), href: attr(m[0], "href") })).filter((l) => l.href);
  const icon = links.filter((l) => l.rel.includes("icon"));
  const touch = links.filter((l) => l.rel.some((r) => r === "apple-touch-icon" || r === "apple-touch-icon-precomposed"));
  const cands = [...new Set([...icon, ...touch].map((l) => { try { return new URL(l.href.trim(), start).href; } catch { return null; } }).filter(Boolean))];
  if (!cands.length) return [["favicon_issue", start, 'no <link rel="icon"> (or shortcut icon / apple-touch-icon) on the home page']];
  const robots = robotsParser(new URL("/robots.txt", start).href, robotsTxt);
  const imageUa = /^\s*user-agent\s*:\s*googlebot-image\s*$/im.test(robotsTxt) ? "Googlebot-Image" : "Googlebot"; // Googlebot-Image falls back to Googlebot's rules
  const problems = [];
  for (const u of cands.slice(0, 3)) {
    const p = [];
    if (robotsTxt && robots.isAllowed(u, imageUa) === false) p.push("blocked for Googlebot-Image by robots.txt");
    const r = await getBytes(u, ua);
    if (r.status !== 200) p.push(`HTTP ${r.status || r.error || "no response"}`);
    else {
      const s = imageSize(r.bytes);
      if (!s) p.push("not a recognised image file");
      else {
        if (!ICON_FORMATS.has(s.format)) p.push(`${s.format} isn't one of Google's listed favicon formats`);
        if (s.width && s.height && s.width !== s.height) p.push(`not square (${s.width}x${s.height})`);
        else if (s.width && !s.vector && s.width < 48) p.push(`${s.width}x${s.height}, smaller than 48x48`);
      }
    }
    if (!p.length) return [];
    problems.push(`${u}: ${p.join(", ")}`);
  }
  return [["favicon_issue", start, problems.join("; ")]];
}

/** Text of the block opening at the first "{" within 200 characters of `from` (brace matching, max 3,000 chars). */
function blockAfter(src, from) {
  const s = src.indexOf("{", from);
  if (s < 0 || s - from > 200) return "";
  for (let i = s, depth = 0; i < Math.min(src.length, s + 3000); i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(s, i + 1);
  }
  return src.slice(s, s + 3000);
}

/** Possible back-button hijacking in a script's text: a popstate handler that pushes a new entry, sends the visitor
 *  forward, or redirects on a page that pushed an entry; or history.pushState inside a loop. Returns descriptions. */
export function historyTraps(js) {
  const src = String(js || ""), out = new Set();
  if (!/pushState|popstate/.test(src)) return [];
  for (const m of src.matchAll(/addEventListener\s*\(\s*["'`]popstate["'`]\s*,|\bonpopstate\s*=/g)) {
    const from = m.index + m[0].length, brace = src.indexOf("{", from);
    // Only inline handlers: a named function can't be followed reliably.
    if (brace < 0 || !/^\s*(?:async\s*)?(?:function\b[^{]*|\([^()]*\)\s*=>\s*|[\w$]+\s*=>\s*)$/.test(src.slice(from, brace))) continue;
    const body = blockAfter(src, from);
    if (/\bpushState\s*\(/.test(body)) out.add("popstate handler calls history.pushState (re-adds an entry when the visitor presses back)");
    else if (/history\.(?:go\s*\(\s*1\s*\)|forward\s*\()/.test(body)) out.add("popstate handler sends the visitor forward again");
    else if (/\bpushState\s*\(/.test(src) && /location(?:\.href)?\s*=(?!=)|location\.(?:replace|assign)\s*\(/.test(body)) out.add("page pushes a history entry and redirects when the visitor presses back");
  }
  if (/\b(?:for|while)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:\{[^{}]{0,300}?|(?:window\.)?history\.)pushState\s*\(/.test(src))
    out.add("history.pushState inside a loop (fills the history with entries)");
  return [...out];
}

/** Back-button check on the same-site script files the home page loads (max 10). Returns [[id, url, detail]]. */
export async function scriptTrapIssues({ start, html, ua, getBytes = fetchBytes, max = 10 }) {
  const out = [];
  const scripts = [...String(html || "").replace(/<!--[\s\S]*?(?:-->|$)/g, "").matchAll(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
    .map((m) => attr(m[0], "src")).filter(Boolean)
    .map((s) => { try { return new URL(s, start).href; } catch { return null; } }).filter((u) => u && new URL(u).origin === new URL(start).origin);
  for (const u of [...new Set(scripts)].slice(0, max)) {
    const r = await getBytes(u, ua);
    if (r.status !== 200) continue;
    const found = historyTraps(r.bytes.toString("utf8"));
    if (found.length) out.push(["back_button_hijack", start, `possible, in script ${u}: ${found.join("; ")}`]);
  }
  return out;
}
