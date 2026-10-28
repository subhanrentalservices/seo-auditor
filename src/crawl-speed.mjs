// Adaptive crawl speed (REQ-055 group 2, Oct 2026). The crawl starts at the project's Parallel requests
// (`concurrency`) and adds one parallel request at a time, up to `maxConcurrency` (default 12), while the site answers
// fast and without errors. It drops back when the site struggles:
//   - 429, or 503 (slow-down answers): half the parallel requests, and no more speeding up for the rest of the audit
//     (the fetch ladder also halves its own limit and waits out Retry-After; the crawl uses the lower of the two);
//   - a timeout, a dropped connection, a retried request, 502 or 504: back to the starting width (or one less below it);
//   - rising response times: one less when the median time to first byte of the last window is over twice (and
//     300 ms above) the first window's median.
// A robots.txt Crawl-delay for this tool's agent ("SEOAuditor") or "*" is always respected: one request at a time,
// at least that many seconds apart (Google ignores Crawl-delay; this tool doesn't). Pure apart from the injected
// clock and sleep, so tests need no network.

export const DEFAULT_MAX = 12;
export const WINDOW = 10; // answers judged together before the width changes again
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };

/** Crawl-delay in ms for this tool's agent or "*" (robots-parser picks the most specific group), or 0. */
export function crawlDelayMs(robots, agent = "SEOAuditor") {
  const s = Number(robots?.getCrawlDelay?.(agent));
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0;
}

/** start/max: parallel requests; crawlDelay: ms between request starts (0 = none). Returns { width(), record(answer),
 *  gate(), stats }. record({ ms, status, error, retries, slowDown, direct }) after every page request; gate() before
 *  every request to the site's own hosts (it waits for the Crawl-delay slot). */
export function createSpeed({ start = 6, max = DEFAULT_MAX, crawlDelay = 0, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const from = Math.max(1, Math.floor(start) || 1);
  const top = crawlDelay ? 1 : Math.max(from, Math.floor(max) || from);
  let width = crawlDelay ? 1 : from, frozen = false, baseline = null, nextAt = 0, window = [];
  const stats = { from, max: top, peak: width, width, ups: 0, downs: 0, frozen: false, crawlDelayS: crawlDelay ? crawlDelay / 1000 : null };
  const set = (w, why) => {
    w = Math.max(1, Math.min(top, w));
    if (w > width) stats.ups++; else if (w < width) stats.downs++;
    width = stats.width = w;
    stats.peak = Math.max(stats.peak, w);
    if (why) stats.last = why;
    window = [];
  };
  return {
    width: () => width,
    stats,
    record({ ms = null, status = 0, error = null, retries = 0, slowDown = false, direct = true } = {}) {
      if (slowDown || status === 429 || status === 503) { frozen = stats.frozen = true; return set(Math.floor(width / 2), "slow-down answer"); }
      if (error || status === 0 || status === 502 || status === 504 || retries) return set(width > from ? from : width - 1, "errors");
      if (!direct || ms === null || ms === undefined) return; // a fallback's timing isn't the server's answer
      window.push(ms);
      if (window.length < WINDOW) return;
      const m = median(window);
      if (baseline === null) baseline = m;
      if (m > baseline * 2 && m > baseline + 300) return set(width - 1, "slower answers");
      if (!frozen && width < top && m <= baseline * 1.5 + 100) return set(width + 1, null);
      window = [];
    },
    /** Waits for this request's Crawl-delay slot; slots are handed out in call order, so parallel callers queue up. */
    async gate() {
      if (!crawlDelay) return;
      const at = Math.max(now(), nextAt);
      nextAt = at + crawlDelay;
      const wait = at - now();
      if (wait > 0) await sleep(wait);
    },
  };
}
