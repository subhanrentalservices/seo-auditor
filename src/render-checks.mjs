// JavaScript rendering checks (REQ-044 build rows 4, 13, 14, 27; Oct 2026): what changes between the raw HTML and the
// rendered page, files the render needs that robots.txt blocks or that fail, uncaught script errors and JavaScript
// redirects. renderPage drives the browser; the rest are pure functions over its log, so tests need no browser.

const hostKey = (h) => h.replace(/^www\./, "");
const urlOf = (u, base) => { try { return new URL(u, base); } catch { return null; } };
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
// Second-level labels under a country code (example.co.uk, example.com.au): the registrable domain has three labels.
const SLD = /^(com|net|org|gov|edu|co|ac|ne|or|go|gob|nic|ltd|plc|sch|mil|id|asn)$/;
/** Registrable domain of a host, approximately (no public suffix list): example.com, example.com.au. */
export function siteOf(host) {
  const parts = hostKey(String(host || "").toLowerCase()).split(".");
  return parts.slice(parts.length > 2 && SLD.test(parts.at(-2)) && parts.at(-1).length === 2 ? -3 : -2).join(".");
}
const sameSite = (a, b) => { const x = urlOf(a), y = urlOf(b); return Boolean(x && y && siteOf(x.hostname) === siteOf(y.hostname)); };

/** Titles that differ only by a brand part JavaScript adds or removes ("Brakes" vs "Brakes | Example Co") are the same. */
export function sameTitle(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (!s) return false;
  return (l.startsWith(s) && /^\s*[|\-–—:·•»]/.test(l.slice(s.length))) || (l.endsWith(s) && /[|\-–—:·•»]\s*$/.test(l.slice(0, l.length - s.length)));
}

/** Differences between the raw HTML and the rendered DOM that matter to Google (both are parseHtml results; url is the
 *  page URL, used to tell internal links). */
export function rawRenderedDiff(raw, ren, url = null) {
  const out = [];
  if (raw.data.noindex && !ren.data.noindex) out.push("noindex in the raw HTML is removed by JavaScript (Google may skip rendering, so the page can stay out of the index)");
  else if (!raw.data.noindex && ren.data.noindex) out.push("JavaScript adds noindex that isn't in the raw HTML");
  else if (raw.robotsMeta !== ren.robotsMeta) out.push(`robots meta "${raw.robotsMeta || "(none)"}" in raw HTML, "${ren.robotsMeta || "(none)"}" after rendering`);
  // A canonical set only by JavaScript is allowed (JavaScript SEO basics); changing or removing the HTML one is not.
  if (raw.canonical && raw.canonical !== ren.canonical) out.push(ren.canonical ? `canonical ${raw.canonical} in raw HTML, ${ren.canonical} after rendering` : `canonical ${raw.canonical} removed by JavaScript`);
  if (ren.words >= 200 && raw.words < ren.words * 0.2) out.push(`main text only after rendering: ${raw.words} words in raw HTML, ${ren.words} rendered`);
  if (!sameTitle(raw.title, ren.title)) out.push(raw.title ? `title "${raw.title.slice(0, 50)}" in raw HTML, "${(ren.title || "(none)").slice(0, 50)}" after rendering` : "title only after rendering");
  if (norm(raw.h1) !== norm(ren.h1)) out.push(raw.h1 ? `H1 "${raw.h1.slice(0, 40)}" in raw HTML, "${(ren.h1 || "(none)").slice(0, 40)}" after rendering` : "H1 only after rendering");
  // Internal links in the page's own content that exist only after rendering (menus, header and footer are left out).
  const host = url ? hostKey(new URL(url).hostname) : null;
  const inRaw = new Set(raw.links.map((l) => l.to));
  const content = [...new Set(ren.links.filter((l) => l.placement === "content" && (!host || hostKey(urlOf(l.to)?.hostname || "") === host)).map((l) => l.to))];
  const added = content.filter((u) => !inRaw.has(u));
  if (added.length >= 5 && added.length >= content.length * 0.2) out.push(`${added.length} of ${content.length} internal content links only after rendering`);
  const types = (ren.data.schemaTypes || []).filter((t) => !(raw.data.schemaTypes || []).includes(t));
  if (types.length) out.push(`structured data only after rendering: ${types.slice(0, 4).join(", ")}`);
  if (!raw.data.hreflangAlts?.length && ren.data.hreflangAlts?.length) out.push(`${ren.data.hreflangAlts.length} hreflang link(s) only after rendering`);
  return out.join("; ");
}

const LOGGED = new Set(["script", "stylesheet", "xhr", "fetch", "font"]);

// Rendering like Google (REQ-055 group 2, Oct 2026): Googlebot renders as a smartphone about 412 px wide (mobile-first
// indexing), so the page gets a phone viewport. Each page has its own browser context: no cookies or storage carry
// over between pages (Google renders stateless).
export const RENDER_VIEWPORT = { width: 412, height: 915 };
const SKIPPED = new Set(["image", "media"]);

/** Scrolls to the bottom one screen at a time, so content loaded on scroll (IntersectionObserver, lazy lists) appears.
 *  Google expands the viewport to the page's height instead; stepping through it triggers the same loaders. At most
 *  `steps` screens, while left() ms remain. */
async function scrollToBottom(page, left, steps = 25, pauseMs = 250) {
  let lastHeight = -1;
  for (let i = 0; i < steps && left() > 1500; i++) {
    const [end, height] = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      window.scrollBy(0, window.innerHeight);
      return [window.scrollY + window.innerHeight >= el.scrollHeight - 2, el.scrollHeight];
    });
    // Two animation frames (IntersectionObserver callbacks run on a frame), then time for lazy content to load.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))).catch(() => {});
    await page.waitForTimeout(pauseMs);
    if (end && height === lastHeight) break; // at the bottom, and nothing more was added below
    lastHeight = height;
  }
  await page.waitForLoadState("networkidle", { timeout: Math.min(3000, left()) }).catch(() => {});
}

/** Renders a page in the browser and logs what Google's renderer would also see: main-frame document requests (a
 *  JavaScript redirect makes a new one), script/style/data/font requests with their status, and uncaught errors.
 *  opts: mobile (phone viewport, default on), blockMedia (images, video and audio aren't downloaded and fonts are only
 *  asked with HEAD, so a broken font still shows its status; the DOM is unchanged: an <img> keeps its src, only the
 *  pixels are missing), scroll (to the bottom, for lazy-loaded content), idleMs (wait for network idle, capped),
 *  totalMs (the whole page). Returns { html, url, docs, requests, errors, ms }, or null when the page didn't load. */
export async function renderPage(browser, url, ua, { mobile = true, blockMedia = true, scroll = true, idleMs = 10000, totalMs = 45000 } = {}) {
  const t0 = Date.now(), left = () => Math.max(1000, totalMs - (Date.now() - t0));
  const context = await browser.newContext({ userAgent: ua, ...(mobile ? { viewport: RENDER_VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 } : {}) });
  const page = await context.newPage();
  if (blockMedia) await page.route("**/*", async (route) => {
    const type = route.request().resourceType();
    if (SKIPPED.has(type)) return route.abort().catch(() => {});
    if (type !== "font") return route.continue().catch(() => {});
    try { // a server that refuses HEAD is asked once more with GET, so it isn't reported as a broken font
      let res = await route.fetch({ method: "HEAD" });
      if (res.status() >= 400) res = await route.fetch();
      await route.fulfill({ status: res.status(), body: "" });
    } catch { await route.abort().catch(() => {}); }
  });
  const docs = [], requests = new Map(), errors = [];
  page.on("request", (q) => {
    if (q.isNavigationRequest() && q.frame() === page.mainFrame()) { if (docs.push(q.url()) === 10) page.close().catch(() => {}); } // a redirect loop: stop waiting
    else if (LOGGED.has(q.resourceType()) && requests.size < 400) requests.set(q, { url: q.url(), type: q.resourceType(), status: 0 });
  });
  page.on("response", (r) => { const x = requests.get(r.request()); if (x) x.status = r.status(); });
  page.on("pageerror", (e) => { if (errors.length < 10) errors.push({ message: String(e.message || e).slice(0, 200), stack: String(e.stack || "").slice(0, 1000) }); });
  try {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: left() }); }
    catch { if (docs.length < 2) return null; } // a JavaScript redirect interrupted the load
    await page.waitForLoadState("networkidle", { timeout: Math.min(idleMs, left()) }).catch(() => {}); // capped: some pages never go idle
    if (scroll) await scrollToBottom(page, left).catch(() => {});
    const html = await page.content().catch(() => null);
    return { html, url: page.url(), docs, requests: [...requests.values()], errors, ms: Date.now() - t0 };
  } catch { return null; } finally { await context.close().catch(() => {}); }
}

// Same-site analytics and tag endpoints (server-side tagging, beacons) aren't needed to render the page.
const TAGS = /\/(?:gtm\.js|gtag\/js|g\/collect|collect|analytics(?:\.js)?|pixel|beacon)(?:$|[?/.])/i;
const key = (u) => { const x = urlOf(u); return x ? x.origin + x.pathname : u; };

/** JavaScript redirect in a render log: a later main-frame document request to another path (history.pushState
 *  makes none, and a change of query or #hash only, as consent and A/B tools do, doesn't count). The same path twice
 *  is a loop. A meta refresh also makes a document request; meta_refresh reports it. Returns { to } or { loop, chain }. */
export function jsRedirectOf(fetched, render, metaRefresh = false) {
  const docs = (render?.docs || []).map(key).filter((k, i, a) => i === 0 || k !== a[i - 1]);
  if (metaRefresh || docs.length < 2) return null;
  if (new Set(docs).size < docs.length) return { loop: true, chain: docs.slice(0, 5) };
  return key(render.docs.at(-1)) !== key(fetched) ? { to: render.docs.at(-1) } : null;
}

/** What the render log says about one page. fetched: the URL the crawler fetched (after server redirects);
 *  robotsFor(origin) → robots-parser object or null (async; the crawler caches it per host); words: { raw, rendered }
 *  main-text word counts. Returns page data fields: jsRedirect, renderBlocked, renderErrors, renderErrorContent,
 *  renderFailed (same-site script/style/font URLs that answered 400+, for broken_internal_resource). */
export async function renderFindings({ fetched, render, robotsFor = async () => null, words = {}, metaRefresh = false }) {
  const d = {};
  const jr = jsRedirectOf(fetched, render, metaRefresh);
  if (jr) d.jsRedirect = jr;
  const blocked = [], failed = [];
  for (const r of render.requests || []) {
    if (!sameSite(r.url, fetched) || TAGS.test(urlOf(r.url)?.pathname || "")) continue; // third-party hosts are ignored
    if (r.status >= 400 && ["script", "stylesheet", "font"].includes(r.type)) failed.push(r.url);
    if (r.type === "font") continue;
    const robots = await robotsFor(urlOf(r.url).origin);
    if (robots && robots.isAllowed(r.url, "Googlebot") === false) blocked.push(r.url);
  }
  if (blocked.length) d.renderBlocked = [...new Set(blocked)].slice(0, 20);
  if (failed.length) d.renderFailed = [...new Set(failed)].slice(0, 20);
  const errs = (render.errors || []).map((e) => {
    const srcs = [...String(e.stack || "").matchAll(/https?:\/\/[^\s)'"]+/g)].map((m) => m[0]);
    return { message: e.message, firstParty: !srcs.length || srcs.some((s) => sameSite(s, fetched)), source: srcs[0] ? urlOf(srcs[0])?.host : null };
  });
  if (errs.length) {
    d.renderErrors = errs.slice(0, 5);
    // Heuristic: the site's own script failed and the rendered page lost most of its text, or never had any.
    const { raw = null, rendered = null } = words;
    if (errs.some((e) => e.firstParty) && rendered !== null && ((raw >= 100 && rendered < raw * 0.2) || (raw !== null && raw < 50 && rendered < 50)))
      d.renderErrorContent = `${raw} words in raw HTML, ${rendered} rendered`;
  }
  return d;
}

/** Adds the rendering results to a page's data: raw-vs-rendered differences, uncrawlable links from the raw HTML when
 *  it has more than the rendered DOM, and the render log findings. */
export function mergeRender(d, raw, ren, url, found) {
  if (raw) {
    const diff = rawRenderedDiff(raw, ren, url);
    if (diff) d.rawVsRendered = diff;
    if ((raw.data.jsLinks || 0) > (d.jsLinks || 0)) { d.jsLinks = raw.data.jsLinks; d.jsLinkExample = raw.data.jsLinkExample; }
  }
  if (found) Object.assign(d, found);
  return d;
}
