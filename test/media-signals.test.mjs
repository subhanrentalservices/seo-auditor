// Images, video and the first phone screen (REQ-044 build rows 36, 37, 38, 54, 55, Oct 2026): lazy-loaded hero images,
// data-src placeholders, generic alt text and file names, images blocked by robots.txt, videos that aren't the main
// content, unreachable video thumbnails/files and CTAs below the fold. Network calls are faked. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import robotsParser from "robots-parser";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { genericAlt, altReuseIssues, imagesBlockedIssues, imageAgent } = await import("../src/image-checks.mjs");
const { videoNotMain, videoFileIssues, videoUrlsOf } = await import("../src/video-checks.mjs");
const { ctaFoldVerdict, foldTargets, CTA } = await import("../src/fold-check.mjs");
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues } = await import("../src/checks.mjs");

const S = "https://example.com";
const ids = (xs) => xs.map((x) => x[0]);
const ctx = { siteIsHttps: true, auditDate: "2026-10-27" };
const doc = (body, head = "") => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;
const data = (body, url = S + "/p") => parseHtml(doc(body), url).data;
const page = (url, d = {}, over = {}) => ({ url: S + url, final_url: S + url, status: 200, content_type: "text/html", indexable: 1, title: "A page title for the tests here",
  description: "x".repeat(130), h1: "Heading", words: 400, text_ratio: 20, depth: 1, outlinks: 1, inlinks: 1, canonical: S + url, data: { h1Count: 1, canonicals: 1, viewport: true, lang: "en", ...d }, ...over });
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

// ---- Row 36: lazy-loaded hero image, data-src placeholders ----
test("lcp_image_lazy: the first content image before the first H2 with loading=lazy", () => {
  const d = data('<main><h1>Brakes</h1><img src="/hero.jpg" loading="lazy" width="1200" alt="Workshop"><h2>More</h2></main>');
  assert.equal(d.lcpLazy, "/hero.jpg");
  assert.match(pageIssues(page("/p", d), ctx).find((x) => x[0] === "lcp_image_lazy")[1], /hero\.jpg/);
  assert.equal(data('<main><h1>B</h1><h2>More</h2><img src="/below.jpg" loading="lazy"></main>').lcpLazy, undefined, "after the first H2");
  assert.equal(data('<header><img src="/brand.png" loading="lazy" width="300"></header><main><h1>B</h1><img src="/hero.jpg"></main>').lcpLazy, undefined, "the site header is skipped; the hero is eager");
  assert.equal(data('<main><img src="/site-logo.png" loading="lazy"><img src="/hero.jpg" loading="lazy" width="150"></main>').lcpLazy, undefined, "logos skipped; narrower than 200 px");
  assert.equal(data('<main><img src="/i.png" width="40" loading="lazy"><img src="/hero.jpg" loading="lazy"></main>').lcpLazy, "/hero.jpg", "icons under 100 px are skipped");
});

test("img_src_placeholder: the real URL only in data-src, unless a noscript fallback has it", () => {
  const d = data('<main><img src="/img/blank.gif" data-src="/photos/car.jpg" alt="A blue car"><img data-srcset="/photos/b.jpg 1x" alt="b"></main>');
  assert.equal(d.imgPlaceholder, 2);
  assert.match(pageIssues(page("/p", d), ctx).find((x) => x[0] === "img_src_placeholder")[1], /2 image\(s\), e\.g\. \/photos\/car\.jpg/);
  assert.equal(data('<main><img src="data:image/gif;base64,R0lGOD" data-src="/photos/car.jpg"><noscript><img src="/photos/car.jpg"></noscript></main>').imgPlaceholder, undefined);
  assert.equal(data('<main><img src="/photos/car.jpg" data-src="/photos/car-large.jpg"></main>').imgPlaceholder, undefined, "a real src");
  assert.equal(data('<main><img src="/x.gif" srcset="/photos/car.jpg 1x" data-src="/photos/car.jpg"></main>').imgPlaceholder, undefined, "a real srcset");
});

// ---- Row 37: generic alt text and file names ----
test("img_alt_generic: file-name alts, generic words, 'image of', camera names; decorative and descriptive alts pass", () => {
  assert.equal(genericAlt("brake-pads.jpg", "/img/brake-pads.jpg"), "the file name");
  assert.equal(genericAlt("brake pads", "/img/brake_pads.jpg"), "the file name");
  assert.equal(genericAlt("Image", "/a.jpg"), '"Image"');
  assert.equal(genericAlt("photo 3", "/a.jpg"), '"photo 3"');
  assert.match(genericAlt("Image of a mechanic", "/a.jpg"), /starts with "Image of a"/);
  assert.equal(genericAlt("", "/a.jpg"), null, "decorative");
  assert.equal(genericAlt("Mechanic fitting new brake pads", "/IMG_2041.jpg"), null);
  assert.equal(genericAlt("Example Motors", "/logo.svg"), null, "a logo with the brand name");
  const d = data('<main><img src="/up/IMG_2041.JPG" alt="Mechanic fitting brake pads"><img src="/b.jpg" alt="picture"></main>');
  assert.equal(d.imgAltGeneric, 1);
  assert.equal(d.imgGenericName, 1);
  const det = pageIssues(page("/p", d), ctx).find((x) => x[0] === "img_alt_generic")[1];
  assert.match(det, /1 generic alt text\(s\), e\.g\. alt "picture" on b\.jpg; 1 camera\/screenshot file name\(s\), e\.g\. IMG_2041\.JPG/);
});

test("img_alt_generic: one alt text on 5 or more different images across the site (brand names ignored)", () => {
  const pairs = (alt, n, from = 0) => Array.from({ length: n }, (_, i) => [alt, `${S}/img/${from + i}.jpg`]);
  const pages = [page("/a", { imgAltPairs: pairs("Our workshop", 3) }), page("/b", { imgAltPairs: pairs("Our workshop", 2, 3) })];
  assert.deepEqual(altReuseIssues(pages), [["img_alt_generic", S + "/a", 'alt "Our workshop" is used for 5 different images on 2 page(s)']]);
  assert.deepEqual(altReuseIssues([page("/a", { imgAltPairs: pairs("Our workshop", 4) })]), []);
  assert.deepEqual(altReuseIssues(pages, { brandTerms: ["our workshop"] }), []);
  const same = [page("/a", { imgAltPairs: [["Logo", S + "/l.png"]] }), page("/b", { imgAltPairs: [["Logo", S + "/l.png"]] })];
  assert.deepEqual(altReuseIssues(same), [], "the same image on many pages is fine");
});

// ---- Row 38: images blocked by robots.txt ----
test("images_blocked_by_robots: one finding per folder; the Googlebot group applies when there is no Googlebot-Image group", () => {
  const txt = "User-agent: Googlebot\nDisallow: /private/\n\nUser-agent: *\nDisallow: /photos/";
  const robots = robotsParser(S + "/robots.txt", txt);
  assert.equal(imageAgent(txt), "Googlebot");
  const imgs = [[S + "/private/a.jpg", S + "/p"], [S + "/private/b.jpg", S + "/q"], [S + "/photos/c.jpg", S + "/p"], ["https://cdn.example.net/private/x.jpg", S + "/p"]];
  assert.deepEqual(imagesBlockedIssues(imgs, { robots, robotsTxt: txt, origin: S }),
    [["images_blocked_by_robots", S + "/private/", `2 image(s) disallowed for Googlebot, e.g. ${S}/private/a.jpg on ${S}/p`]]);
  const own = "User-agent: Googlebot-Image\nDisallow: /photos/\n\nUser-agent: Googlebot\nDisallow: /private/";
  assert.equal(imageAgent(own), "Googlebot-Image");
  assert.deepEqual(ids(imagesBlockedIssues(imgs, { robots: robotsParser(S + "/robots.txt", own), robotsTxt: own, origin: S })), ["images_blocked_by_robots"]);
  assert.deepEqual(imagesBlockedIssues(imgs, { robots: null, robotsTxt: "", origin: S }), []);
});

// ---- Row 54: video as main content, thumbnails and files ----
test("video_not_main: VideoObject pages whose first video is low on the page, or galleries", () => {
  const ld = '<script type="application/ld+json">{"@type":"VideoObject","name":"Fitting pads","thumbnailUrl":{"@type":"ImageObject","url":"https://example.com/t.jpg"},"uploadDate":"2026-01-02","contentUrl":"https://example.com/v.mp4"}</script>';
  const low = data(`<main><h1>Brakes</h1><p>${words(300)}</p><iframe src="https://www.youtube.com/embed/abc"></iframe></main>${ld}`);
  assert.equal(low.videos, 1);
  assert.ok(low.videoAt > 0.9);
  assert.deepEqual(low.videoUrls, [{ thumb: S + "/t.jpg", content: S + "/v.mp4" }]);
  assert.match(pageIssues(page("/p", low, { words: 300 }), ctx).find((x) => x[0] === "video_not_main")[1], /after \d+% of the main text/);
  const top = data(`<main><h1>Brakes</h1><iframe src="https://www.youtube.com/embed/abc"></iframe><p>${words(300)}</p></main>${ld}`);
  assert.ok(top.videoAt < 0.1);
  assert.equal(videoNotMain(top, 300), null);
  assert.match(videoNotMain({ videoObjects: 1, videos: 3, videoAt: 0 }, 300), /3 videos/);
  assert.equal(videoNotMain({ videos: 1, videoAt: 0.9 }, 300), null, "no VideoObject: not aiming for video results");
  assert.equal(videoNotMain({ videoObjects: 1, videos: 1, videoAt: 0.9 }, 100), null, "a short page");
  assert.equal(data('<main><video muted loop autoplay src="/bg.mp4"></video><p>x</p></main>').videos, undefined, "a decorative background video");
  assert.deepEqual(videoUrlsOf({ thumbnailUrl: ["https://example.com/a.jpg", "https://example.com/b.jpg"] }), { thumb: "https://example.com/a.jpg" });
});

test("video_thumbnail_unreachable: thumbnails that don't answer 200 and contentUrls that aren't video files; capped, one at a time", async () => {
  const log = [];
  const web = { [S + "/t-ok.jpg"]: [200, "image/jpeg"], [S + "/t-gone.jpg"]: [404, "text/html"], [S + "/v.mp4"]: [200, "text/html"], [S + "/w.mp4"]: [405, ""] };
  const fetchFn = async (u, init) => {
    log.push(`${init.method} ${u}`);
    if (u === S + "/w.mp4" && init.method === "GET") return new Response(null, { status: 206, headers: { "content-type": "video/mp4" } });
    const [status, type] = web[u] || [404, "text/html"];
    return new Response(null, { status, headers: type ? { "content-type": type } : {} });
  };
  const pages = [page("/a", { videoUrls: [{ thumb: S + "/t-ok.jpg", content: S + "/v.mp4" }, { thumb: S + "/t-gone.jpg", content: S + "/w.mp4" }] }), page("/b", { videoUrls: [{ thumb: S + "/t-gone.jpg" }] })];
  const out = await videoFileIssues(pages, { fetchFn });
  assert.deepEqual(out, [
    ["video_thumbnail_unreachable", S + "/a", `contentUrl ${S}/v.mp4 is text/html, not a video file`],
    ["video_thumbnail_unreachable", S + "/a", `thumbnailUrl ${S}/t-gone.jpg → HTTP 404`],
    ["video_thumbnail_unreachable", S + "/b", `thumbnailUrl ${S}/t-gone.jpg → HTTP 404`]]);
  assert.ok(log.includes(`GET ${S}/w.mp4`), "HEAD 405 falls back to a ranged GET");
  log.length = 0;
  await videoFileIssues(pages, { fetchFn, max: 2 });
  assert.equal(new Set(log.map((x) => x.split(" ")[1])).size, 2, "max URLs");
});

// ---- Row 55: CTA below the first phone screen ----
test("cta_below_fold: the first CTA below 823 px without a sticky call bar; only home and money pages with a CTA", () => {
  assert.match(ctaFoldVerdict({ found: 2, top: 1400, sticky: false, text: "Book now" }), /"Book now"\) starts 1400 px down/);
  assert.equal(ctaFoldVerdict({ found: 2, top: 500, sticky: false, text: "Call" }), null);
  assert.equal(ctaFoldVerdict({ found: 1, top: 10, sticky: true, text: "Call" }), null, "a sticky call bar counts as visible");
  assert.equal(ctaFoldVerdict({ found: 0, top: null }), null, "no CTA: no_conversion_path covers it");
  const pages = [page("/", { convTel: 1 }), page("/brakes.html", { convCta: 1 }, { inlinks: 9 }), page("/tyres.html", { convCta: 1 }, { inlinks: 3 }),
    page("/privacy.html", { convMail: 1 }), page("/blog/post.html", { convTel: 1 }), page("/plain.html", {})];
  assert.deepEqual(foldTargets(pages, S + "/").map((p) => p.url), [S + "/", S + "/brakes.html", S + "/tyres.html"]);
  assert.ok(CTA.test("Get a quote") && !CTA.test("Our history"));
});
