// Renders public/icon.svg to a multi-size Windows .ico (PNG entries) for the desktop shortcut.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
const svg = readFileSync(new URL("../public/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
const sizes = [16, 32, 48, 256], pngs = [];
for (const s of sizes) {
  const page = await browser.newPage({ viewport: { width: s, height: s } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${s}" height="${s}" `)}</body></html>`);
  pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } }));
  await page.close();
}
await browser.close();
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length; const dirs = [];
sizes.forEach((s, i) => { const d = Buffer.alloc(16); d.writeUInt8(s >= 256 ? 0 : s, 0); d.writeUInt8(s >= 256 ? 0 : s, 1); d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(pngs[i].length, 8); d.writeUInt32LE(offset, 12); offset += pngs[i].length; dirs.push(d); });
writeFileSync(new URL("../public/icon.ico", import.meta.url), Buffer.concat([header, ...dirs, ...pngs]));
console.log("public/icon.ico written");
