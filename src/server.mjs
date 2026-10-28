// Local web server: JSON API under /api, live progress via Server-Sent Events, static UI from public/.
// Listens on 127.0.0.1 only. Host/Origin checks stop other websites in the browser from calling the API.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./db.mjs";
import * as api from "./api.mjs";
import { onEvent } from "./runner.mjs";

export const PORT = Number(process.env.SEO_AUDITOR_PORT) || 4560;
const PUBLIC = path.join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

// [method, pattern, handler(params, query, body)] — extra modules push their own routes here.
export const routes = [
  ["GET", /^\/api\/projects$/, () => api.listProjects()],
  ["POST", /^\/api\/projects$/, (p, q, b) => api.createProject(b)],
  ["GET", /^\/api\/projects\/(\d+)$/, ([id]) => api.getProject(id)],
  ["PUT", /^\/api\/projects\/(\d+)$/, ([id], q, b) => api.updateProject(id, b)],
  ["DELETE", /^\/api\/projects\/(\d+)$/, ([id]) => api.deleteProject(id)],
  ["POST", /^\/api\/projects\/(\d+)\/audits$/, ([id]) => api.startProjectAudit(id)],
  ["GET", /^\/api\/audits\/(\d+)$/, ([id]) => api.getAudit(id)],
  ["POST", /^\/api\/audits\/(\d+)\/stop$/, ([id]) => api.stopAudit(id)],
  ["GET", /^\/api\/audits\/(\d+)\/issues\/([a-z0-9_]+)$/, ([id, check], q) => api.getIssue(id, check, q)],
  ["GET", /^\/api\/audits\/(\d+)\/pages$/, ([id], q) => api.listPages(id, q)],
  ["GET", /^\/api\/audits\/(\d+)\/page$/, ([id], q) => api.getPage(id, q.url)],
  ["GET", /^\/api\/compare\/(\d+)\/(\d+)$/, ([a, b]) => api.compareAudits(a, b)],
  ["GET", /^\/api\/checks$/, () => api.catalog()],
];
// [path prefix, handler(req, res, url)] for modules that answer raw requests themselves (link building proxy).
export const prefixes = [];

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw Object.assign(new Error("Request too large"), { status: 413 }); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

function events(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write("retry: 3000\n\n");
  const off = onEvent((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { off(); clearInterval(ping); });
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "Forbidden" });
  try {
    const body = await readFile(file);
    send(res, 200, body, MIME[path.extname(file)] || "application/octet-stream",
      { "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
  } catch { send(res, 404, "Not found", "text/plain"); }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      // DNS-rebinding and cross-site protection: only our own host, and no foreign Origin on any request.
      if (!ALLOWED_HOSTS.has(req.headers.host || "")) return send(res, 421, { error: "Wrong host" });
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "Cross-site request blocked" });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/api/events") return events(req, res);
      for (const [pre, fn] of prefixes) if (url.pathname.startsWith(pre)) return await fn(req, res, url);
      const exp = url.pathname.match(/^\/api\/audits\/(\d+)\/export\/(issues|pages|links)\.csv$/);
      if (exp && req.method === "GET") return send(res, 200, "﻿" + api.exportCsv(exp[1], exp[2]), "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="audit-${exp[1]}-${exp[2]}.csv"` });
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && !(req.headers["content-type"] || "").includes("application/json") && req.method !== "DELETE")
          return send(res, 415, { error: "Use application/json" });
        for (const [method, re, fn] of routes) {
          const m = url.pathname.match(re);
          if (m && method === req.method) {
            const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
            const out = await fn(m.slice(1), Object.fromEntries(url.searchParams), body);
            if (out && out.__raw) return send(res, 200, out.body, out.type, out.headers);
            return send(res, 200, out);
          }
        }
        return send(res, 404, { error: "Not found" });
      }
      if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
      return serveStatic(res, url.pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? "Internal error: " + e.message : e.message });
    }
  });
}

// Modules loaded at start (each may export register({ routes, prefixes })). Order matters for after-audit steps: the
// alerts run last, after Search Console has refreshed. scheduled-run.mjs loads the same list without the server.
export const MODULES = ["./cwv.mjs", "./gsc.mjs", "./dataforseo.mjs", "./visibility.mjs", "./report.mjs", "./scheduler.mjs", "./extras.mjs", "./desktop.mjs", "./backlinks.mjs", "./quality.mjs", "./page2.mjs", "./indexing.mjs", "./topics.mjs", "./citations.mjs", "./decay.mjs", "./queries.mjs", "./reclaim.mjs", "./linkgraph.mjs", "./trends.mjs", "./serpfeatures.mjs", "./changes.mjs",
  "./gsc-history.mjs", "./rank.mjs", "./gsc-sitemaps.mjs", "./gsc-discover.mjs", "./index-rotation.mjs", "./gsc-explorer.mjs",
  "./issue-trends.mjs", "./alert-channels.mjs", "./task-schedule.mjs", "./report-delivery.mjs", "./alerts.mjs"]; // alerts last: it reads data the others refresh after an audit

/** Load every module and listen on 127.0.0.1. Used by `node src/server.mjs` and by the desktop app. */
export async function startServer() {

  for (const m of MODULES) await import(m).then((x) => x.register?.({ routes, prefixes })).catch((e) => { if (e.code !== "ERR_MODULE_NOT_FOUND") console.error(m, e.message); });
  process.on("unhandledRejection", (e) => console.error("unhandled:", e?.stack || e));
  await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(PORT, "127.0.0.1", () => { console.log(`SEO Auditor running at http://localhost:${PORT}`); resolve(srv); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, "src", "server.mjs")) await startServer();
