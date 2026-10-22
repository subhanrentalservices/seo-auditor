// SEO Auditor desktop app (Windows and macOS): one window around the local web app.
// The server runs in a utility process so long crawls never freeze the window. Data lives in the user's app-data
// folder (Windows: %APPDATA%\SEO Auditor, macOS: ~/Library/Application Support/SEO Auditor).
import { app, BrowserWindow, shell, utilityProcess, dialog, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SEO_AUDITOR_PORT) || 4560;
const URL_ROOT = `http://localhost:${PORT}/`;

if (!app.requestSingleInstanceLock()) app.quit();

const data = app.getPath("userData");
process.env.SEO_AUDITOR_DATA ||= path.join(data, "data");
process.env.LV_WORKSPACE ||= path.join(data, "link-engine");
if (app.isPackaged) process.env.LV_ENGINE ||= path.join(process.resourcesPath, "engine", process.platform === "win32" ? "linkverify.exe" : "linkverify");

let win = null, server = null;

async function isOurServer() {
  try { const r = await fetch(URL_ROOT + "api/projects", { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

function startServer() {
  return new Promise((resolve) => {
    server = utilityProcess.fork(path.join(HERE, "server-entry.mjs"), [], { env: process.env, serviceName: "SEO Auditor server", stdio: "pipe" });
    server.stdout?.on("data", (d) => process.stdout.write(d));
    server.stderr?.on("data", (d) => process.stderr.write(d));
    server.on("message", (m) => resolve(m));
    server.on("exit", (code) => { server = null; resolve({ ready: false, error: `server stopped (${code})` }); });
  });
}

function openWindow(hash = "") {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, title: "SEO Auditor", backgroundColor: "#eceef1", show: false,
    icon: path.join(HERE, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { win = null; });
  // Links to other websites open in the normal browser; the app's own pages (e.g. the link map) open in a new window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL_ROOT)) return { action: "allow" };
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(URL_ROOT)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.loadURL(URL_ROOT + hash);
}

app.on("second-instance", () => openWindow());
app.on("activate", () => openWindow());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { server?.kill(); });

app.whenReady().then(async () => {
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  // An SEO Auditor already running on this computer (e.g. started from the old shortcut) is reused as is.
  if (!(await isOurServer())) {
    const r = await startServer();
    if (!r.ready && !(r.error === "in-use" && (await isOurServer()))) {
      dialog.showErrorBox("SEO Auditor could not start", r.error === "in-use"
        ? `Another program is using port ${PORT}. Close it and open SEO Auditor again.` : String(r.error));
      return app.quit();
    }
  }
  openWindow(process.argv.includes("--link-building") ? "#/link-building" : "");
});
