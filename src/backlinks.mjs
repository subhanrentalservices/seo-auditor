// Link building (the former Backlink Verifier app): its Python engine in backlinks/ runs as a child process on
// 127.0.0.1:4561 and the UI talks to it through /lv/* on this server, so there is one app, one port, one window.
// The engine keeps its own protections (Host check + a per-start token on every change); this module fetches
// the token from the engine's page and adds it, so the token never reaches the browser.
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, DATA } from "./db.mjs";

const BL = path.join(ROOT, "backlinks");
// Engine data (config.toml + sites/): next to the engine in a developer setup, where its daily-run task
// (linkverify.bat) expects it; the installed desktop app sets LV_WORKSPACE to the user's app-data folder.
const WS = process.env.LV_WORKSPACE ? path.resolve(process.env.LV_WORKSPACE) : BL;
// LV_ENGINE: the packaged engine program (PyInstaller) in the desktop app; otherwise the Python venv.
const ENGINE = process.env.LV_ENGINE || "";
const PY = path.join(BL, ".venv", "Scripts", "python.exe");
const LOG = path.join(DATA, "backlinks.log");
export const ENGINE_PORT = Number(process.env.LV_PORT) || 4561;

let child = null, token = null, lastError = null, restarts = 0, stopping = false;

function log(line) { try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {} }

export function start() {
  if (child) return;
  if (!ENGINE && !existsSync(PY)) { lastError = "The link building engine is not installed. Run backlinks\\setup.bat once."; return; }
  mkdirSync(WS, { recursive: true });
  token = null;
  // windowsHide: false on purpose. The SEO Auditor runs in a hidden console (scripts/launch.ps1); the engine shares
  // it, and so do the programs the engine starts (schtasks, the headless browser). With windowsHide: true the engine
  // had no console at all, so Windows opened a new visible window for each of those child programs.
  const args = ["--config", path.join(WS, "config.toml"), "dashboard", "--no-browser", "--port", String(ENGINE_PORT)];
  child = spawn(ENGINE || PY, ENGINE ? args : ["-m", "linkverify", ...args],
    { cwd: ENGINE ? WS : BL, windowsHide: false, env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" } });
  child.stdout.on("data", (d) => log(String(d).trimEnd()));
  child.stderr.on("data", (d) => { const s = String(d).trimEnd(); log(s); lastError = s.split("\n").pop(); });
  child.on("exit", (code) => {
    log(`engine exited (${code})`); child = null; token = null;
    if (stopping) return;
    // Restart a crashed engine, but stop retrying if it keeps dying (the error stays visible in the UI).
    if (++restarts <= 5) setTimeout(start, 3000 * restarts);
  });
  child.on("error", (e) => { lastError = e.message; log("spawn failed: " + e.message); });
}

export function stop() { stopping = true; child?.kill(); }
for (const sig of ["exit", "SIGINT", "SIGTERM"]) process.on(sig, () => { stop(); if (sig !== "exit") process.exit(0); });

function engine(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: ENGINE_PORT, method, path: p, timeout: 120000,
      headers: { ...headers, ...(body ? { "Content-Length": body.length } : {}) } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "application/octet-stream", body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("The link building engine did not answer in time.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  if (token) return token;
  const r = await engine("GET", "/");
  const m = String(r.body).match(/name="lv-token" content="([^"]+)"/);
  if (!m) throw new Error("The link building engine answered without its token.");
  return (token = m[1]);
}

async function waitReady(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await getToken(); restarts = 0; lastError = null; return true; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  return false;
}

async function readRaw(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw Object.assign(new Error("Request too large"), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/** /lv/status, /lv/api/... (JSON, screenshots) and /lv/s/<site>/graph (the link map page). */
async function handle(req, res, url) {
  if (url.pathname === "/lv/status") {
    if (!child) start();
    const ready = child ? await waitReady(8000) : false;
    let tail = "";
    try { tail = readFileSync(LOG, "utf8").split("\n").slice(-6).join("\n"); } catch {}
    return send(res, 200, { ready, error: ready ? null : lastError, log: ready ? "" : tail });
  }
  const allowed = /^\/lv\/(api\/[A-Za-z0-9_./%-]*|s\/[^/]+\/graph)$/.exec(url.pathname);
  if (!allowed || !["GET", "POST"].includes(req.method)) return send(res, 404, { error: "Not found" });
  if (req.method === "POST" && !(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error: "Use application/json" });
  const body = req.method === "POST" ? await readRaw(req) : null;
  if (!child) start();
  if (!(await waitReady())) return send(res, 503, { error: lastError || "The link building engine is starting. Try again in a moment." });
  const target = url.pathname.slice(3) + url.search;
  const call = async () => engine(req.method, target, { body, headers: body ? { "Content-Type": "application/json", "X-LV-Token": await getToken() } : {} });
  let r = await call();
  if (r.status === 403 && body) { token = null; r = await call(); } // engine restarted with a new token
  send(res, r.status, r.body, r.type);
}

// The link map page loads its font from /fonts/ (absolute path inside the engine's own page).
const FONTS = path.join(BL, "linkverify", "static", "app", "fonts");
function font(req, res, url) {
  const m = /^\/fonts\/([a-z0-9_-]+\.woff2)$/.exec(url.pathname);
  try { if (m) return send(res, 200, readFileSync(path.join(FONTS, m[1])), "font/woff2"); } catch {}
  send(res, 404, "Not found", "text/plain");
}

// The original Backlink Verifier screens (public/lv/views) link straight to /api/s/<site>/links/<id>/screenshot and
// /s/<site>/graph; serve those paths from the engine too (no SEO Auditor route starts with /api/s/ or /s/).
const viaEngine = (req, res, url) => handle(req, res, new URL("/lv" + url.pathname + url.search, url));

export function register({ prefixes }) {
  prefixes?.push(["/lv/", handle], ["/fonts/", font], ["/api/s/", viaEngine], ["/s/", viaEngine]);
  start();
}
