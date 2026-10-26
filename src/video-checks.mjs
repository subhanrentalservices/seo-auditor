// Video checks (REQ-044 build row 54, Oct 2026), from Google's video best practices: video features need "a
// dedicated watch page", whose "main purpose is to show users a single video"; on other pages the video is
// "complementary to the rest of the content"; the thumbnail must be "accessible by Googlebot" at "a stable URL" and
// Google must be able to fetch the video file for previews and key moments.
// - video_not_main: a page with VideoObject markup whose first video comes after half of the main text, or that
//   embeds 3 or more videos (heuristics: Google's classifiers decide what a watch page is),
// - video_thumbnail_unreachable: a VideoObject thumbnailUrl that doesn't answer 200, or a contentUrl that doesn't
//   answer 200 with a video type. Up to 20 URLs, one request at a time, 10 s timeout each.

// Video embeds a VideoObject should describe (YouTube, Vimeo, Wistia).
export const VIDEO_SRC = /youtube(?:-nocookie)?\.com\/(?:embed|watch)|youtu\.be\/|player\.vimeo\.com|vimeo\.com\/\d|fast\.wistia\.(?:net|com)|wistia\.com\/medias|wi\.st\//i;
const SKIP = /^(script|style|noscript|template|svg|iframe)$/i;

/** Video embeds in the page's content: iframes from video hosts, lite-youtube style players and <video> elements
 *  with controls (a muted or looping <video> without controls is a decorative background). */
export function videoEmbeds($, $c) {
  return $c.find("iframe, lite-youtube, lite-vimeo, [class*=wistia_async_], video").toArray().filter((e) => {
    const x = $(e);
    if (e.name === "iframe") return VIDEO_SRC.test(x.attr("src") || x.attr("data-src") || "");
    if (e.name === "video") return x.is("[controls]") || !x.is("[muted], [loop]");
    return true;
  });
}

/** Share of the content's text (0–1) that comes before element `target` in document order. */
export function textShareBefore(root, target) {
  let before = 0, total = 0, hit = false;
  const walk = (n) => {
    if (n === target) hit = true;
    if (n.type === "text") { const k = n.data.replace(/\s+/g, "").length; total += k; if (!hit) before += k; }
    else if (n.children && !SKIP.test(n.name || "")) n.children.forEach(walk);
  };
  walk(root);
  return total ? before / total : 0;
}

/** URLs a VideoObject node names: thumbnailUrl (string, array or ImageObject) and contentUrl. */
export function videoUrlsOf(o) {
  const first = (v) => { const x = [].concat(v || [])[0]; return typeof x === "string" ? x : x?.url || x?.contentUrl || null; };
  const out = {};
  const t = first(o.thumbnailUrl), c = first(o.contentUrl);
  if (t) out.thumb = String(t).slice(0, 300);
  if (c) out.content = String(c).slice(0, 300);
  return out.thumb || out.content ? out : null;
}

/** Page fields: videos (embed count) and videoAt (share of the main text before the first embed). */
export function videoFindings($, $c) {
  const embeds = videoEmbeds($, $c);
  if (!embeds.length) return {};
  return { videos: embeds.length, videoAt: +textShareBefore($c.get(0), embeds[0]).toFixed(2) };
}

/** video_not_main detail for one page, or null. Only pages with VideoObject markup (they aim for video results) and
 *  at least 150 words of text (on a short page the video is the content anyway). */
export function videoNotMain(d, words) {
  if (!d.videoObjects || !d.videos || words < 150) return null;
  if (d.videos >= 3) return `${d.videos} videos on the page (a gallery, not one watch page)`;
  if (d.videoAt >= 0.5) return `the first video comes after ${Math.round(d.videoAt * 100)}% of the main text`;
  return null;
}

const VIDEO_TYPE = /^video\/|^application\/(?:x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)/i;

/** Status and type of one URL: HEAD first, then a 1-byte ranged GET when HEAD isn't allowed. */
async function probe(url, fetchFn, timeout) {
  const once = async (method, headers = {}) => {
    try {
      const r = await fetchFn(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "Mozilla/5.0 (compatible; SEOAuditor/1.0; +local)", ...headers } });
      r.body?.cancel?.().catch?.(() => {});
      return { status: r.status === 206 ? 200 : r.status, type: r.headers.get("content-type") || "" };
    } catch (e) { return { status: 0, type: "", error: e.name === "TimeoutError" ? "timeout" : e.message }; }
  };
  const h = await once("HEAD");
  return h.status === 200 || h.status === 404 || h.status === 410 ? h : once("GET", { Range: "bytes=0-0" });
}

/** video_thumbnail_unreachable over the crawled pages' data.videoUrls ([{thumb, content}]). fetchFn is injected in
 *  tests; max caps the number of URLs requested (one at a time). */
export async function videoFileIssues(pages, { fetchFn = fetch, max = 20, timeout = 10000, stop = () => false } = {}) {
  const uses = new Map(); // url → { kind, pages: [] }
  for (const p of pages) for (const v of p.data?.videoUrls || []) for (const [kind, u] of [["thumbnailUrl", v.thumb], ["contentUrl", v.content]]) {
    if (!u || !/^https?:\/\//i.test(u)) continue;
    if (!uses.has(u)) uses.set(u, { kind, pages: [] });
    if (!uses.get(u).pages.includes(p.url)) uses.get(u).pages.push(p.url);
  }
  const out = [];
  for (const [u, x] of [...uses].slice(0, max)) {
    if (stop()) break;
    const r = await probe(u, fetchFn, timeout);
    let why = null;
    if (r.status !== 200) why = `${x.kind} ${u} → ${r.status ? `HTTP ${r.status}` : r.error || "no response"}`;
    else if (x.kind === "contentUrl" && r.type && !VIDEO_TYPE.test(r.type)) why = `contentUrl ${u} is ${r.type.split(";")[0]}, not a video file`;
    if (why) for (const pg of x.pages.slice(0, 20)) out.push(["video_thumbnail_unreachable", pg, why]);
  }
  return out;
}
