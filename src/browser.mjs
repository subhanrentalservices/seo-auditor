// Headless browser for JS rendering, PDF reports and Lighthouse. Uses Playwright's downloaded Chromium when it is
// there (developer setup), otherwise the Chrome or Edge already installed on the computer (installed desktop app,
// which doesn't ship Playwright's browser).
import { existsSync } from "node:fs";

export async function launchChromium(opts = {}) {
  const { chromium } = await import("playwright");
  let first;
  for (const extra of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try { return await chromium.launch({ ...opts, ...extra }); } catch (e) { first ||= e; }
  }
  throw new Error("No browser found for this feature. Install Google Chrome, then try again. (" + String(first?.message || first).split("\n")[0] + ")");
}

/** Path to a Chrome-family executable for Lighthouse. */
export async function chromiumPath() {
  try { const { chromium } = await import("playwright"); const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch {}
  const { Launcher } = await import("chrome-launcher");
  const found = Launcher.getInstallations?.() || [];
  if (found.length) return found[0];
  throw new Error("Lighthouse needs Google Chrome. Install it, then try again.");
}
