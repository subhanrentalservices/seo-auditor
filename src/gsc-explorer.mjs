// Search Console explorer (REQ-055 group 4, item 7): the Performance report with any filter, asked live from the
// Search Analytics API — searches and pages by contains / does not contain / exact / regex (RE2, Search Console's regex
// flavour), country, device, search type and dates, grouped by the dimensions chosen — with a CSV export.
// Every input is validated here before it reaches Google; a bad filter is a 400 with a plain reason.
import { get, projectSettings } from "./db.mjs";
import { query, detectProperty, gsc } from "./gsc.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const DIMENSIONS = ["query", "page", "country", "device", "date"];
export const OPERATORS = ["contains", "notContains", "equals", "notEquals", "includingRegex", "excludingRegex"];
export const TYPES = ["web", "image", "video", "news", "discover", "googleNews"];
const NO_QUERY = new Set(["discover", "googleNews"]); // these report no searches and no position
const DEVICES = ["DESKTOP", "MOBILE", "TABLET"];
const MAX_ROWS = 100000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Explorer input → a Search Analytics request body plus the row cap. Defaults: last 28 days of final data, by query. */
export function buildRequest(input = {}, now = Date.now()) {
  const end = input.endDate || iso(now - 3 * 864e5), start = input.startDate || iso(Date.parse(end) - 27 * 864e5);
  if (!DAY.test(start) || !DAY.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) fail(400, "Dates must be YYYY-MM-DD");
  if (start > end) fail(400, "The start date is after the end date");
  if (start < iso(now - 486 * 864e5)) fail(400, "Search Console keeps 16 months of data: pick a later start date");
  const type = input.type || "web";
  if (!TYPES.includes(type)) fail(400, `Search type must be one of ${TYPES.join(", ")}`);
  const dims = [...new Set((Array.isArray(input.dimensions) && input.dimensions.length ? input.dimensions : ["query"]).map(String))];
  for (const d of dims) if (!DIMENSIONS.includes(d)) fail(400, `Unknown dimension: ${d}`);
  if (NO_QUERY.has(type) && dims.includes("query")) fail(400, "Discover and Google News don't report searches: group by page, country, device or date");
  const filters = [];
  for (const dim of ["query", "page"]) {
    const f = input[dim];
    if (!f || f.value === undefined || f.value === "") continue;
    const operator = f.operator || "contains", expression = String(f.value);
    if (!OPERATORS.includes(operator)) fail(400, `Unknown operator: ${operator}`);
    if (NO_QUERY.has(type) && dim === "query") fail(400, "Discover and Google News don't report searches");
    if (/Regex$/.test(operator)) {
      try { new RegExp(expression); } catch { fail(400, `The ${dim} pattern is not a valid regular expression`); }
      // RE2 (what Search Console uses) has no lookaround and no back-references.
      if (/\(\?<?[=!]|\\[1-9]/.test(expression)) fail(400, `The ${dim} pattern uses lookaround or a back-reference, which Search Console's regex (RE2) doesn't support`);
    }
    filters.push({ dimension: dim, operator, expression });
  }
  if (input.country) {
    const c = String(input.country).toLowerCase();
    if (!/^[a-z]{3}$/.test(c)) fail(400, "Country: a three-letter ISO code, e.g. aus, usa, gbr");
    filters.push({ dimension: "country", operator: "equals", expression: c });
  }
  if (input.device) {
    const d = String(input.device).toUpperCase();
    if (!DEVICES.includes(d)) fail(400, "Device: desktop, mobile or tablet");
    filters.push({ dimension: "device", operator: "equals", expression: d });
  }
  if (JSON.stringify(filters).length > 4000) fail(400, "Filters are too long (Search Console allows 4,096 characters)");
  const limit = Math.min(Math.max(1, Math.floor(Number(input.limit) || 1000)), MAX_ROWS);
  const body = { startDate: start, endDate: end, type, dimensions: dims, ...(filters.length ? { dimensionFilterGroups: [{ groupType: "and", filters }] } : {}) };
  return { body, limit };
}

/** API rows → flat rows: one column per dimension plus the metrics (no position for Discover / Google News). */
export function shapeRows(rows, dims, type = "web") {
  return rows.map((r) => {
    const o = {};
    dims.forEach((d, i) => { o[d] = d === "device" ? String(r.keys[i]).toLowerCase() : r.keys[i]; });
    o.clicks = r.clicks; o.impressions = r.impressions; o.ctr = r.ctr ?? (r.impressions ? r.clicks / r.impressions : 0);
    if (!NO_QUERY.has(type)) o.position = r.position;
    return o;
  });
}

export async function explore(project, input, { call = gsc, now } = {}) {
  const { body, limit } = buildRequest(input, now);
  const property = projectSettings(project).gscProperty || (await detectProperty(project.start_url, call));
  if (!property) fail(400, "No Search Console property for this site is shared with the service account");
  const rows = await query(property, body, limit, call);
  const cut = rows.slice(0, limit);
  return { property, request: body, truncated: rows.length >= limit, columns: [...body.dimensions, "clicks", "impressions", "ctr", ...(NO_QUERY.has(body.type) ? [] : ["position"])],
    rows: shapeRows(cut, body.dimensions, body.type) };
}

// Same cell rules as the audit exports: quotes when needed, and a leading = + - @ is defused for spreadsheets.
const cell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
export const toCsv = (columns, rows) => [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n");

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["POST", /^\/api\/projects\/(\d+)\/gsc\/explore$/, ([id], q, b) => explore(project(id), b)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/gsc\/explore\.csv$/, async ([id], q, b) => {
    const r = await explore(project(id), b);
    return { __raw: true, body: "﻿" + toCsv(r.columns, r.rows), type: "text/csv; charset=utf-8",
      headers: { "Content-Disposition": `attachment; filename="search-console-${r.request.startDate}-${r.request.endDate}.csv"` } };
  }]);
}
