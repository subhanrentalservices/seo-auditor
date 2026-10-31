// A tiny local website for the end-to-end test (e2e.test.mjs), served on 127.0.0.1 at a random port. It has one of
// each thing an audit must notice: a 301 and a 302 that internal links point to, a robots.txt that blocks a folder
// and declares the sitemap, a sitemap with a noindex page and a dead URL in it, a canonical to another page, a
// noindex page, a JavaScript-only page (empty #root filled by /app.js) and a broken internal link.
import http from "node:http";

const words = (seed, n = 220) => Array.from({ length: n }, (_, i) => `${seed}${i % 13} text part ${i}`).join(" ");
const page = (path, title, body, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title><meta name="description" content="${title}: a description of this page that is long enough for the length check.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="{{origin}}${path}">${head}</head>
<body><header><a href="/">Home</a> <a href="/about">About</a></header><main><h1>${title}</h1>${body}</main></body></html>`;

/** Path → [status, body, type, extra headers]. {{origin}} is replaced with the server's own address. */
export const FIXTURE = {
  "/robots.txt": [200, "User-agent: *\nDisallow: /blocked/\n\nSitemap: {{origin}}/sitemap.xml\n", "text/plain"],
  "/sitemap.xml": [200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>{{origin}}/</loc></url><url><loc>{{origin}}/about</loc></url><url><loc>{{origin}}/private</loc></url><url><loc>{{origin}}/gone</loc></url></urlset>`, "application/xml"],
  "/": [200, page("/", "Fixture home page for the audit test", `<p>${words("home")}</p>
<p><a href="/about">About us</a> <a href="/old-page">Old page</a> <a href="/temp">Contact (temporary)</a> <a href="/missing">A page that is gone</a>
<a href="/copy">Copy of about</a> <a href="/private">Private page</a> <a href="/app">The app</a> <a href="/blocked/secret">Secret</a></p>`)],
  "/about": [200, page("/about", "About the fixture website team", `<p>${words("about")}</p><a href="/contact">Contact</a>`)],
  "/contact": [200, page("/contact", "Contact the fixture website", `<p>${words("contact")}</p>`)],
  "/copy": [200, page("/about", "A copy that names About as canonical", `<p>${words("copy")}</p>`)],
  "/private": [200, page("/private", "Private page not for search", `<p>${words("private")}</p>`, '<meta name="robots" content="noindex">')],
  "/old-page": [301, "", "text/html", { Location: "/about" }],
  "/temp": [302, "", "text/html", { Location: "/contact" }],
  "/app": [200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The fixture app page</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="{{origin}}/app"></head>
<body><div id="root"></div><script src="/app.js"></script></body></html>`],
  "/app.js": [200, `document.getElementById("root").innerHTML = "<main><h1>Rendered by JavaScript</h1><p>" +
  Array.from({ length: 300 }, function (_, i) { return "rendered" + (i % 11) + " words " + i; }).join(" ") + "</p></main>";`, "text/javascript"],
  "/blocked/secret": [200, page("/blocked/secret", "Blocked by robots", `<p>${words("secret")}</p>`)],
};

/** Starts the fixture on 127.0.0.1 (port 0 = any free port). Returns { origin, requests, close }. */
export async function startFixture(site = FIXTURE) {
  const requests = [];
  let origin = "";
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    requests.push({ method: req.method, path, ua: req.headers["user-agent"] || "" });
    const [status, body = "", type = "text/html; charset=utf-8", headers = {}] = site[path] || [404, "<!doctype html><title>Not found</title><p>Not found</p>", "text/html; charset=utf-8"];
    const loc = headers.Location ? { Location: origin + headers.Location } : {};
    res.writeHead(status, { "Content-Type": type, ...headers, ...loc });
    res.end(req.method === "HEAD" ? undefined : body.replaceAll("{{origin}}", origin));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
