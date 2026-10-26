// Shared helpers: DOM builder (text only, never innerHTML — crawled titles are untrusted), API client,
// toast/tooltip, formatting and the small SVG charts.
const SVGNS = "http://www.w3.org/2000/svg";

export function h(tag, attrs, ...kids) {
  const svg = ["svg", "path", "circle", "line", "rect", "text", "g", "polyline"].includes(tag);
  const el = svg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.setAttribute("class", v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && !svg && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const mount = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter(Boolean)); return el; };

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
export function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}
export function tip(evt, ...content) {
  const t = $("#tip");
  if (!evt) { t.hidden = true; return; }
  mount(t, ...content); t.hidden = false;
  const x = Math.min(evt.clientX + 14, innerWidth - t.offsetWidth - 8), y = Math.max(evt.clientY - t.offsetHeight - 10, 8);
  t.style.left = x + "px"; t.style.top = y + "px";
}

export const num = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-AU"));
export const pct = (n) => (n === null || n === undefined ? "–" : `${(n * 100).toFixed(1)}%`);
export function when(s) {
  if (!s) return "–";
  const d = new Date(s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z"));
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
export const shortUrl = (u, base) => { try { const x = new URL(u); return base && x.origin === new URL(base).origin ? (x.pathname + x.search) || "/" : u; } catch { return u; } };
export const SEV_LABEL = { error: "Errors", warning: "Warnings", notice: "Notices" };
export const sevBadge = (s) => h("span", { class: `badge ${s}` }, h("span", { class: `dot sev-${s}`, "aria-hidden": "true" }), s === "error" ? "Error" : s === "warning" ? "Warning" : "Notice");

/** Score band → status (colour always paired with an icon + word). */
export function band(score) {
  if (score === null || score === undefined) return { word: "No data", color: "var(--muted)", icon: "·" };
  if (score >= 90) return { word: "Good", color: "var(--good)", icon: "✓" };
  if (score >= 70) return { word: "Needs work", color: "var(--warn)", icon: "!" };
  return { word: "Poor", color: "var(--crit)", icon: "✕" };
}

/** Ring meter for a 0–100 score with label and status word. */
export function meter(score, label, sub, note) {
  const r = 34, c = 2 * Math.PI * r, b = band(score);
  const frac = Math.max(0, Math.min(1, (score ?? 0) / 100));
  return h("div", { class: "meter" },
    h("svg", { width: 84, height: 84, viewBox: "0 0 84 84", role: "img", "aria-label": `${label}: ${score ?? "no data"} out of 100, ${b.word}` },
      h("circle", { cx: 42, cy: 42, r, fill: "none", stroke: "var(--surface-2)", "stroke-width": 9 }),
      h("circle", { cx: 42, cy: 42, r, fill: "none", stroke: b.color, "stroke-width": 9, "stroke-linecap": "round",
        "stroke-dasharray": `${c * frac} ${c}`, transform: "rotate(-90 42 42)" })),
    h("div", {}, h("div", { class: "lbl" }, label), h("div", { class: "big" }, score ?? "–"),
      h("div", { class: "small" }, h("span", { style: { color: b.color }, "aria-hidden": "true" }, b.icon + " "), b.word, sub ? h("span", { class: "muted" }, " · ", sub) : null),
      note ? h("div", { class: "small muted" }, note) : null));
}

/** Single-series line over time with crosshair + tooltip. points: [{x: label, y: value, sub?}] */
export function lineChart(points, { height = 160, max = 100, fmt = (v) => v, label = "" } = {}) {
  const W = 600, H = height, L = 32, R = 10, T = 10, B = 22;
  const svg = h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
  if (!points.length) return svg;
  const top = max ?? Math.max(...points.map((p) => p.y), 1);
  const X = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const Y = (v) => T + (1 - v / top) * (H - T - B);
  for (const g of [0, 0.5, 1]) {
    svg.append(h("line", { class: "gridline", x1: L, x2: W - R, y1: Y(top * g), y2: Y(top * g) }),
      h("text", { class: "axis", x: L - 6, y: Y(top * g) + 4, "text-anchor": "end" }, fmt(Math.round(top * g))));
  }
  svg.append(h("polyline", { class: "line", points: points.map((p, i) => `${X(i)},${Y(p.y)}`).join(" ") }));
  const last = points.length - 1;
  svg.append(h("circle", { class: "pt", cx: X(last), cy: Y(points[last].y), r: 4.5 }));
  svg.append(h("text", { class: "axis", x: L, y: H - 4 }, points[0].x), h("text", { class: "axis", x: W - R, y: H - 4, "text-anchor": "end" }, points[last].x));
  const xh = h("line", { class: "xh", y1: T, y2: H - B, visibility: "hidden" });
  const dot = h("circle", { class: "pt", r: 5, visibility: "hidden" });
  const hit = h("rect", { x: L, y: 0, width: W - L - R, height: H, fill: "transparent" });
  hit.addEventListener("mousemove", (e) => {
    const box = svg.getBoundingClientRect(); const vx = ((e.clientX - box.left) / box.width) * W;
    let i = points.length === 1 ? 0 : Math.round(((vx - L) / (W - L - R)) * last); i = Math.max(0, Math.min(last, i));
    xh.setAttribute("x1", X(i)); xh.setAttribute("x2", X(i)); xh.setAttribute("visibility", "visible");
    dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(points[i].y)); dot.setAttribute("visibility", "visible");
    tip(e, h("b", {}, fmt(points[i].y)), " ", h("span", { class: "muted" }, points[i].x), points[i].sub ? h("div", { class: "muted" }, points[i].sub) : null);
  });
  hit.addEventListener("mouseleave", () => { xh.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip(null); });
  svg.append(xh, dot, hit);
  return svg;
}

/** Vertical bars, one series. rows: [{x, y}] */
export function barChart(rows, { height = 170, width = 340, label = "", unit = "" } = {}) {
  const W = width, H = height, L = 32, R = 6, T = 10, B = 22;
  const svg = h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label });
  if (!rows.length) return svg;
  const top = Math.max(...rows.map((r) => r.y), 1);
  const slot = (W - L - R) / rows.length, bw = Math.min(56, slot - 2);
  const Y = (v) => T + (1 - v / top) * (H - T - B);
  for (const g of [0, 0.5, 1]) svg.append(h("line", { class: "gridline", x1: L, x2: W - R, y1: Y(top * g), y2: Y(top * g) }),
    h("text", { class: "axis", x: L - 6, y: Y(top * g) + 4, "text-anchor": "end" }, num(Math.round(top * g))));
  rows.forEach((r, i) => {
    const x = L + i * slot + (slot - bw) / 2, y = Y(r.y), hgt = Math.max(H - B - y, r.y ? 2 : 0), rad = Math.min(4, hgt / 2, bw / 2);
    // Rounded data end, square at the baseline.
    const d = `M${x},${H - B} V${y + rad} Q${x},${y} ${x + rad},${y} H${x + bw - rad} Q${x + bw},${y} ${x + bw},${y + rad} V${H - B} Z`;
    const bar = h("path", { class: "bar", d });
    const hit = h("rect", { x: L + i * slot, y: T, width: slot, height: H - T - B, fill: "transparent" });
    hit.addEventListener("mousemove", (e) => { bar.classList.add("hl"); tip(e, h("b", {}, num(r.y), unit), " ", h("span", { class: "muted" }, r.x)); });
    hit.addEventListener("mouseleave", () => { bar.classList.remove("hl"); tip(null); });
    svg.append(bar, h("text", { class: "axis", x: x + bw / 2, y: H - 6, "text-anchor": "middle" }, r.x), hit);
  });
  return svg;
}

export function table(cols, rows, { onRow, empty = "Nothing here" } = {}) {
  if (!rows.length) return h("div", { class: "empty" }, empty);
  return h("div", { class: "tbl-wrap" }, h("table", { class: "t" },
    h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c.num ? "num" : "" }, c.label)))),
    h("tbody", {}, rows.map((r) => h("tr", { style: onRow ? { cursor: "pointer" } : null, onclick: onRow ? () => onRow(r) : null },
      cols.map((c) => h("td", { class: [c.num ? "num" : "", c.cls || ""].join(" ") }, c.get ? c.get(r) : r[c.key])))))));
}
