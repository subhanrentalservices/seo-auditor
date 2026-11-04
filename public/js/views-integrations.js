// Integrations (REQ-055 group 8): the Bing screen (Bing Webmaster Tools API and IndexNow), the Analytics screen (GA4
// Data API), and in App settings the Bing API key and Google sign-in for Search Console and GA4. Secrets typed here are sent once and never shown again (the server returns only "saved" flags).
// Text only, never innerHTML: page paths, queries and event names come from Google and the site.
import { h, mount, api, toast, num, pct, shortUrl, lineChart, table } from "./core.js";
import { VIEWS, NAV } from "./views.js";

const anchor = Math.max(NAV.findIndex((n) => n.view === "explorer"), NAV.findIndex((n) => n.view === "search"));
NAV.splice(anchor + 1, 0, { view: "analytics", label: "Analytics" }, { view: "bing", label: "Bing" });

const row = (label, el, hint) => [h("label", {}, label), h("div", {}, el, hint ? h("div", { class: "small muted" }, hint) : null)];
const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; } };
const local = (s) => (s ? new Date(s).toLocaleString("en-AU") : "–");
const fmtDay = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
const tile = (k, v, sub) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v", style: { fontSize: "22px" } }, v), sub ? h("div", { class: "small muted" }, sub) : null);
const errorList = (errors, names) => { const e = Object.entries(errors || {}).filter(([, v]) => v); return e.length ? h("div", {}, e.map(([k, v]) => h("p", { class: "down small" }, `! ${names[k] || k}: ${v}`))) : null; };
/** Saves one project setting and reloads the screen. */
const settingForm = (ctx, key, label, value, placeholder, hint) => {
  const inp = h("input", { type: "text", value: value || "", placeholder, style: { width: "260px" } });
  return h("form", { class: "row", onsubmit: async (e) => { e.preventDefault();
    try { await api(`/api/projects/${ctx.project.id}`, { method: "PUT", body: { settings: { [key]: inp.value.trim() } } }); toast("Saved"); ctx.app.refresh(); } catch (err) { toast(err.message); } } },
  h("label", {}, label), inp, h("button", { class: "btn small" }, "Save"), hint ? h("span", { class: "small muted" }, hint) : null);
};
const refreshBtn = (label, path, ctx) => { const b = h("button", { class: "btn primary" }, label);
  b.onclick = () => busy(b, async () => { await api(path, { method: "POST", body: {} }); toast("Updated"); ctx.app.refresh(); }); return b; };

// ---------- Analytics (GA4) ----------
const GA4_PARTS = { pages: "Organic landing pages", daily: "Organic trend", keyEvents: "Key events", ai: "AI referrals", channels: "All channels" };
VIEWS.analytics = async (ctx) => {
  const pid = ctx.project.id, base = ctx.project.start_url, d = await api(`/api/projects/${pid}/ga4`);
  const full = (p) => { try { return new URL(p, base).href; } catch { return p; } };
  const setup = h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Google Analytics 4"), d.configured ? refreshBtn("Refresh from GA4", `/api/projects/${pid}/ga4`, ctx) : null),
    settingForm(ctx, "ga4Property", "GA4 Property ID", ctx.project.settings.ga4Property, "123456789", "GA4 Admin → Property settings → Property ID (digits, not the G- measurement ID)."),
    h("p", { class: "hint", style: { marginBottom: 0 } }, d.mode === "oauth" ? "Uses your Google sign-in (App settings). Your account needs Viewer access to the property."
      : "Uses the Search Console service-account key file (or Google sign-in in App settings). Add the service account's email as a Viewer in GA4 Admin → Property access management, and enable the “Google Analytics Data API” in its Google Cloud project.",
    d.fetchedAt ? ` Last fetched ${local(d.fetchedAt)} (${d.startDate} to ${d.endDate}). Refreshes after each audit, at most every 12 hours.` : ""),
    errorList(d.errors, GA4_PARTS));
  if (!d.configured || !d.fetchedAt) return [setup, d.configured ? h("div", { class: "card empty" }, "Press “Refresh from GA4” to fetch the first data.") : null];
  const t = d.totals || {};
  const tiles = h("div", { class: "card" }, h("h2", {}, "Organic search, last 28 days"), h("div", { class: "grid g4" },
    tile("Sessions", num(t.sessions)), tile("Engaged sessions", num(t.engagedSessions), t.sessions ? `${pct(t.engagedSessions / t.sessions)} engagement rate` : null),
    tile("Key events", num(t.keyEvents), "GA4's name for conversions"), tile("Users", num(t.users), "summed per landing page")),
  d.daily.length ? [h("h3", {}, "Organic sessions per day"), lineChart(d.daily.map((x) => ({ x: fmtDay(x.date), y: x.sessions, sub: `${num(x.keyEvents)} key events` })), { max: null, fmt: num, label: "Organic sessions per day" })] : null);
  const pages = h("div", { class: "card" }, h("h2", {}, "Organic landing pages"),
    table([{ label: "Landing page", cls: "url", get: (r) => shortUrl(full(r.page), base) }, { label: "Sessions", num: true, get: (r) => num(r.sessions) },
      { label: "Engaged", num: true, get: (r) => num(r.engagedSessions) }, { label: "Key events", num: true, get: (r) => num(r.keyEvents) },
      { label: "Rate", num: true, get: (r) => (r.sessions ? pct(r.keyEvents / r.sessions) : "–") }], d.pages, { empty: "No organic sessions in the last 28 days." }));
  const events = h("div", { class: "card" }, h("h2", {}, "Key events by landing page (organic)"),
    table([{ label: "Landing page", cls: "url", get: (r) => shortUrl(full(r.page), base) }, { label: "Event", key: "event" }, { label: "Count", num: true, get: (r) => num(r.keyEvents) }],
      d.keyEvents, { empty: "No key events from organic visits. Mark events as key events in GA4 Admin → Events." }));
  const ai = h("div", { class: "card" }, h("h2", {}, "Visits from AI assistants (last 28 days)"),
    table([{ label: "Assistant", key: "assistant" }, { label: "Sessions", num: true, get: (r) => num(r.sessions) }, { label: "Engaged", num: true, get: (r) => num(r.engagedSessions) },
      { label: "Key events", num: true, get: (r) => num(r.keyEvents) }, { label: "Pages", num: true, get: (r) => num(r.pages) }], d.ai.assistants, { empty: "No visits referred by ChatGPT, Perplexity, Gemini, Copilot or Claude." }),
    d.ai.rows.length ? h("details", {}, h("summary", { class: "small" }, `By landing page (${d.ai.rows.length})`),
      table([{ label: "Assistant", key: "assistant" }, { label: "Source", key: "source" }, { label: "Landing page", cls: "url", get: (r) => shortUrl(full(r.page), base) },
        { label: "Sessions", num: true, get: (r) => num(r.sessions) }, { label: "Key events", num: true, get: (r) => num(r.keyEvents) }], d.ai.rows)) : null,
    h("p", { class: "hint", style: { marginBottom: 0 } }, "Counted from the referring site GA4 records. Many AI visits arrive without a referrer (apps, copied links) and show as Direct, so this is a lower bound."));
  const pctOr = (v) => (v == null ? "–" : pct(v));
  const channels = h("div", { class: "card" }, h("h2", {}, "All channels (last 28 days)"),
    d.adsUnlinked ? h("p", { class: "hint", style: { color: "var(--warn, #b45309)" } }, `${num(d.adsUnlinked.sessions)} Google Ads click session(s) arrived with no campaign name (google / cpc with a placeholder such as “(not set)” or “(organic)”), ${num(d.adsUnlinked.keyEvents)} key events. Usually Google Ads isn't linked to this GA4 property (GA4 Admin → Product links → Google Ads links) or auto-tagging is off, so campaign, cost and cost per click don't reach GA4 and cost per lead can't be worked out.`) : null,
    table([{ label: "Channel", key: "channel" }, { label: "Sessions", num: true, get: (r) => num(r.sessions) }, { label: "Engagement rate", num: true, get: (r) => pctOr(r.engagementRate) },
      { label: "Bounce rate", num: true, get: (r) => pctOr(r.bounceRate) }, { label: "Key events", num: true, get: (r) => num(r.keyEvents) }], d.channels || [], { empty: "No sessions in the last 28 days." }),
    h("p", { class: "hint", style: { marginBottom: 0 } }, "GA4 bounce rate is the share of sessions that weren't engaged (engaged: over 10 seconds, a key event, or 2+ page views), so it is 100% minus the engagement rate. Compare channels with each other; a high bounce rate on one page type (contact, phone number) can be fine."));
  return [setup, tiles, channels, pages, events, ai];
};

// ---------- Bing Webmaster Tools + IndexNow ----------
const BING_PARTS = { traffic: "Clicks and impressions", queries: "Top searches", pages: "Top pages", crawl: "Crawl stats", issues: "Crawl issues", links: "Inbound links" };
const pos1 = (p) => (p === null || p === undefined ? "–" : Number(p).toFixed(1));
async function indexNowCard(ctx) {
  const pid = ctx.project.id, c = await api(`/api/projects/${pid}/indexnow/changed`);
  const urls = h("textarea", { rows: 8, style: { width: "100%" }, placeholder: "One URL per line" }, c.urls.map((u) => u.url).join("\n"));
  const result = h("div", {});
  const send = h("button", { class: "btn primary", type: "button" }, "Submit to IndexNow");
  send.onclick = () => busy(send, async () => {
    const r = await api(`/api/projects/${pid}/indexnow`, { method: "POST", body: { urls: urls.value.split(/\s+/).filter(Boolean) } });
    mount(result, h("p", { class: r.ok ? "up" : "down" }, `${r.ok ? "✓" : "!"} ${r.message} (${num(r.submitted)} URLs${r.status ? `, HTTP ${r.status}` : ""})`),
      r.rejected.length ? h("details", {}, h("summary", { class: "small" }, `${r.rejected.length} not sent`), r.rejected.map((x) => h("div", { class: "small" }, `${x.url}: ${x.reason}`))) : null);
  });
  const check = h("button", { class: "btn", type: "button" }, "Check key file");
  check.onclick = () => busy(check, async () => { const r = await api(`/api/projects/${pid}/indexnow/check-key`, { method: "POST", body: {} }); mount(result, h("p", { class: r.ok ? "up" : "down" }, `${r.ok ? "✓" : "!"} ${r.message} ${r.url}`)); });
  return h("div", { class: "card" }, h("h2", {}, "IndexNow: tell Bing and others what changed"),
    settingForm(ctx, "indexNowKey", "IndexNow key", c.key, "8–128 letters, digits or dashes", c.key ? `Host it at ${new URL(ctx.project.start_url).origin}/${c.key}.txt` : "Make one up (e.g. a random 32-character string)."),
    h("p", { class: "hint" }, "Upload a text file named <key>.txt holding only the key to your site's root folder (that part is yours to do), then check it here. Only URLs on this site's exact host are sent. ",
      c.note || (c.urls.length ? `Prefilled with ${c.urls.length} pages new or changed since the previous audit.` : "No page is new or changed since the previous audit.")),
    urls, h("div", { class: "row", style: { marginTop: "8px" } }, send, c.key ? check : null), result,
    c.log.length ? h("details", {}, h("summary", { class: "small" }, "Recent submissions"),
      table([{ label: "When", get: (r) => local(r.ts.replace(" ", "T") + "Z") }, { label: "URLs", num: true, get: (r) => num(r.urls) }, { label: "Result", get: (r) => `${r.status || "–"} ${r.message}` }], c.log)) : null);
}

VIEWS.bing = async (ctx) => {
  const pid = ctx.project.id, base = ctx.project.start_url, d = await api(`/api/projects/${pid}/bing`);
  const inow = await indexNowCard(ctx).catch((e) => h("div", { class: "card" }, h("p", { class: "down" }, e.message)));
  const setup = h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Bing Webmaster Tools"), d.hasKey ? refreshBtn("Refresh from Bing", `/api/projects/${pid}/bing`, ctx) : null),
    d.hasKey ? null : h("p", {}, d.message, " ", h("a", { href: "#/app" }, "App settings →")),
    settingForm(ctx, "bingSiteUrl", "Bing site", ctx.project.settings.bingSiteUrl, d.siteUrl || base, "Empty = matched by this website's address."),
    d.fetchedAt ? h("p", { class: "hint", style: { marginBottom: 0 } }, `Site ${d.siteUrl}. Last fetched ${local(d.fetchedAt)}. Refreshes after each audit, at most every 12 hours.`) : null,
    errorList(d.errors, BING_PARTS));
  if (!d.fetchedAt) return [setup, inow];
  const t = d.totals;
  const days = d.daily.filter((x) => x.clicks !== null);
  const traffic = h("div", { class: "card" }, h("h2", {}, t ? `Bing search, ${t.from} to ${t.to}` : "Bing search"),
    t ? h("div", { class: "grid g4" }, tile("Clicks", num(t.clicks)), tile("Impressions", num(t.impressions)), tile("CTR", t.impressions ? pct(t.clicks / t.impressions) : "–")) : null,
    days.length ? [h("h3", {}, "Clicks per day"), lineChart(days.map((x) => ({ x: fmtDay(x.date), y: x.clicks, sub: `${num(x.impressions)} impressions` })), { max: null, fmt: num, label: "Bing clicks per day" })] : null);
  const rowCols = (label, url) => [{ label, cls: url ? "url" : "", get: (r) => (url ? shortUrl(r.key, base) : r.key) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) },
    { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Avg. pos.", num: true, get: (r) => pos1(r.position) }];
  const period = d.rowsFrom ? ` (weeks ${d.rowsFrom} to ${d.rowsTo}, as Bing returns them)` : "";
  const crawlDays = d.daily.filter((x) => x.crawledPages !== null);
  const lastCrawl = crawlDays.at(-1);
  const crawl = h("div", { class: "card" }, h("h2", {}, "Crawling"),
    lastCrawl ? h("p", {}, `${lastCrawl.date}: ${num(lastCrawl.crawledPages)} pages crawled, ${num(lastCrawl.crawlErrors)} crawl errors, ${num(lastCrawl.inIndex)} in the index, ${num(lastCrawl.inLinks)} inbound links (Bing's counts).`) : null,
    crawlDays.length ? lineChart(crawlDays.map((x) => ({ x: fmtDay(x.date), y: x.crawledPages, sub: `${num(x.crawlErrors)} errors` })), { max: null, fmt: num, label: "Pages crawled by Bing per day" }) : null,
    h("h3", {}, `Crawl issues (${d.crawlIssues.length})`),
    table([{ label: "URL", cls: "url", get: (r) => shortUrl(r.url, base) }, { label: "Issue", get: (r) => r.labels.join(", ") || "–" }, { label: "HTTP", num: true, get: (r) => r.httpCode ?? "–" },
      { label: "Inbound links", num: true, get: (r) => num(r.inLinks) }], d.crawlIssues, { empty: "Bing reports no crawl issues." }));
  const links = h("div", { class: "card" }, h("h2", {}, "Inbound links (Bing's sample)"),
    table([{ label: "Your page", cls: "url", get: (r) => shortUrl(r.url, base) }, { label: "Links", num: true, get: (r) => num(r.count) }], d.links.targets, { empty: "Bing lists no inbound links." }),
    d.links.sample.length ? [h("h3", {}, `Links to ${shortUrl(d.links.sample[0].target, base)}`),
      table([{ label: "From", cls: "url", get: (r) => r.source }, { label: "Anchor text", get: (r) => r.anchor || "–" }], d.links.sample)] : null);
  return [setup, traffic,
    h("div", { class: "card" }, h("h2", {}, `Top searches on Bing${period}`), table(rowCols("Search", false), d.queries, { empty: "No searches yet." })),
    h("div", { class: "card" }, h("h2", {}, `Top pages on Bing${period}`), table(rowCols("Page", true), d.pages, { empty: "No pages yet." })),
    crawl, links, inow];
};

// ---------- App settings: Bing API key ----------
async function bingKeyCard() {
  const c = await api("/api/bing/config");
  const key = h("input", { type: "password", placeholder: c.hasKey ? "saved — type to replace" : "", autocomplete: "off" });
  const save = h("button", { class: "btn primary" }, "Save");
  const clear = h("button", { type: "button", class: "btn", hidden: !c.hasKey }, "Remove key");
  clear.onclick = () => busy(clear, async () => { await api("/api/bing/config", { method: "PUT", body: { clear: true } }); key.placeholder = ""; clear.hidden = true; toast("Bing API key removed"); });
  return h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); busy(save, async () => {
    const r = await api("/api/bing/config", { method: "PUT", body: { apiKey: key.value } }); key.value = ""; key.placeholder = r.hasKey ? "saved — type to replace" : ""; clear.hidden = !r.hasKey; toast("Bing API key saved");
  }); } }, h("h2", {}, "Bing Webmaster Tools"),
  h("p", { class: "hint" }, "Free. In Bing Webmaster Tools (add and verify your site, or import it from Search Console): Settings → API access → API key → Generate. Stored only in data/config.json on this PC; never shown again."),
  h("div", { class: "form" }, ...row("API key", key), h("div", { class: "full row" }, save, clear)));
}

// ---------- App settings: Google sign-in ----------
async function googleCard(ctx) {
  const g = await api("/api/google/oauth");
  const clientId = h("input", { type: "text", value: g.clientId, placeholder: "1234…apps.googleusercontent.com", autocomplete: "off", style: { width: "100%", maxWidth: "440px" } });
  const secret = h("input", { type: "password", placeholder: g.hasSecret ? "saved — type to replace" : "GOCSPX-…", autocomplete: "new-password" });
  const status = h("div", {});
  const link = h("div", { class: "small" });
  const showStatus = (s) => mount(status, h("p", {}, s.connected ? `Signed in as ${s.email || "a Google account"} since ${local(s.connectedAt)}. ` : "Not signed in. ",
    `Search Console and GA4 now use ${s.mode === "oauth" ? "this Google account" : "the service-account key file"}.`),
  s.lastError ? h("p", { class: "down" }, "! " + s.lastError) : null, s.pending ? h("p", { class: "small muted" }, "Waiting for Google… finish the sign-in in your browser (5 minutes).") : null);
  showStatus(g);

  const save = h("button", { type: "submit", class: "btn" }, "Save client");
  const signIn = h("button", { type: "button", class: "btn primary" }, g.connected ? "Sign in again" : "Sign in with Google");
  const poll = async () => {
    for (let i = 0; i < 160; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api("/api/google/oauth").catch(() => null);
      if (s && !s.pending) { showStatus(s); mount(link); toast(s.connected && !s.lastError ? `Signed in as ${s.email || "your Google account"}` : s.lastError || "Sign-in ended"); ctx.app.refresh(); return; }
    }
  };
  signIn.onclick = () => busy(signIn, async () => {
    const r = await api("/api/google/oauth/start", { method: "POST", body: {} });
    window.open(r.url, "_blank", "noopener");
    mount(link, "If no browser tab opened: ", h("a", { href: r.url, target: "_blank", rel: "noopener" }, "open Google sign-in"), ".");
    showStatus({ ...g, pending: true, lastError: null });
    poll();
  });
  const mode = h("select", {}, [["service", "Service-account key file"], ["oauth", "My Google account (signed in)"]].map(([v, l]) => h("option", { value: v, selected: v === g.mode }, l)));
  mode.onchange = async () => { try { showStatus(await api("/api/google/oauth", { method: "PUT", body: { mode: mode.value } })); toast("Saved"); } catch (e) { toast(e.message); mode.value = g.mode; } };
  const out = h("button", { type: "button", class: "btn" }, "Sign out");
  out.onclick = () => busy(out, async () => { await api("/api/google/oauth/disconnect", { method: "POST", body: {} }); toast("Signed out: back to the service account"); ctx.app.refresh(); });

  return h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); busy(save, async () => {
    const s = await api("/api/google/oauth", { method: "PUT", body: { clientId: clientId.value, clientSecret: secret.value } });
    secret.value = ""; secret.placeholder = s.hasSecret ? "saved — type to replace" : "GOCSPX-…"; showStatus(s); toast("OAuth client saved");
  }); } },
  h("h2", {}, "Google sign-in (Search Console and GA4)"),
  h("p", { class: "hint" }, "Instead of a service-account key file, sign in with your own Google account. Create a free OAuth client: Google Cloud console → APIs & Services → enable “Google Search Console API” and “Google Analytics Data API” → OAuth consent screen (External; add yourself as a test user, or publish it: in Testing, Google ends the sign-in after 7 days) → Credentials → Create credentials → OAuth client ID → type “Desktop app”. Paste its ID and secret here, save, then sign in. Read-only access. The secret and the sign-in token stay in data/config.json on this PC and are never shown again."),
  status,
  h("div", { class: "form" },
    ...row("OAuth client ID", clientId), ...row("Client secret", secret),
    ...(g.connected ? row("Use for Google data", mode, "Switch back to the key file without signing out.") : []),
    h("div", { class: "full row" }, save, g.clientId && g.hasSecret ? signIn : h("span", { class: "small muted" }, "Save a client ID and secret to sign in."), g.connected ? out : null),
    h("div", { class: "full" }, link)));
}

const appView = VIEWS.app;
VIEWS.app = async (ctx) => {
  const base = await appView(ctx);
  const failed = (title) => (e) => h("div", { class: "card" }, h("h2", {}, title), h("p", { class: "down" }, e.message));
  return [...[base].flat(), await googleCard(ctx).catch(failed("Google sign-in")), await bingKeyCard().catch(failed("Bing Webmaster Tools"))];
};
