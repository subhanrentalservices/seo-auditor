// Custom extraction (REQ-055 group 3): the rules editor for project settings and the Pages table's extra columns
// and filter. The server validates every rule (src/extract.mjs); this only collects them.
import { h, mount, toast } from "./core.js";

const MAX = 20;
const OUTPUTS = [["text", "Text"], ["html", "Inner HTML"], ["attr", "Attribute"], ["count", "Count"]];

/** Rules editor: { el, read() } with read() → the rules list for the settings PUT. */
export function extractEditor(rules = []) {
  const rows = h("div", {});
  const add = (r = { type: "css", output: "text" }) => {
    if (rows.children.length >= MAX) return toast(`At most ${MAX} extraction rules`);
    const name = h("input", { type: "text", value: r.name || "", placeholder: "Column name", maxLength: 40, style: { width: "130px" } });
    const type = h("select", {}, [["css", "CSS"], ["regex", "Regex"]].map(([v, l]) => h("option", { value: v, selected: r.type === v }, l)));
    const expr = h("input", { type: "text", value: r.type === "regex" ? r.pattern || "" : r.selector || "", maxLength: 300, style: { width: "220px" } });
    const output = h("select", {}, OUTPUTS.map(([v, l]) => h("option", { value: v, selected: (r.output || "text") === v }, l)));
    const attr = h("input", { type: "text", value: r.attr || "", placeholder: "attribute", maxLength: 60, style: { width: "90px" } });
    const flags = h("input", { type: "text", value: r.flags || "", placeholder: "flags (i m s u)", maxLength: 4, style: { width: "100px" } });
    const sync = () => {
      const css = type.value === "css";
      expr.placeholder = css ? "CSS selector, e.g. .price or meta[name=author]" : "Regex on the raw HTML, e.g. gtag\\('config', '([^']+)'";
      output.hidden = !css; attr.hidden = !css || output.value !== "attr"; flags.hidden = css;
    };
    type.onchange = sync; output.onchange = sync; sync();
    const row = h("div", { class: "row", style: { marginBottom: "4px", flexWrap: "wrap" } }, name, type, expr, output, attr, flags,
      h("button", { type: "button", class: "btn", onclick: () => row.remove() }, "Remove"));
    row.read = () => (type.value === "regex" ? { name: name.value.trim(), type: "regex", pattern: expr.value, flags: flags.value.trim() }
      : { name: name.value.trim(), type: "css", selector: expr.value.trim(), output: output.value, ...(output.value === "attr" ? { attr: attr.value.trim() } : {}) });
    rows.append(row);
  };
  for (const r of rules) add(r);
  const el = h("div", {}, rows, h("button", { type: "button", class: "btn", onclick: () => add() }, "Add rule"));
  return { el, read: () => [...rows.children].map((r) => r.read()).filter((r) => r.name || r.selector || r.pattern) };
}

/** Pages table columns for the audit's extraction rules (sortable as x:<name>). */
export const extractColumns = (names) => names.map((n) => ({ key: `x:${n}`, label: n, get: (r) => {
  const v = r.extract?.[n];
  return v === null || v === undefined ? "" : String(v).length > 80 ? String(v).slice(0, 79) + "…" : String(v);
} }));

/** Filter controls: rule, condition, text. q gets x / xop / xv; reload() is called after a change. */
export function extractFilter(names, q, reload) {
  if (!names.length) return null;
  const rule = h("select", {}, [["", "Extraction: any"], ...names.map((n) => [n, n])].map(([v, l]) => h("option", { value: v, selected: q.x === v }, l)));
  const op = h("select", {}, [["contains", "contains"], ["filled", "has a value"], ["empty", "is empty"]].map(([v, l]) => h("option", { value: v, selected: (q.xop || "contains") === v }, l)));
  const text = h("input", { type: "search", value: q.xv || "", placeholder: "text", style: { width: "120px" } });
  let t;
  const apply = () => { q.x = rule.value; q.xop = op.value; q.xv = text.value; q.offset = 0; text.hidden = op.value !== "contains"; reload(); };
  rule.onchange = apply; op.onchange = apply; text.oninput = () => { clearTimeout(t); t = setTimeout(apply, 250); };
  text.hidden = op.value !== "contains";
  return mount(h("span", { class: "row" }), rule, op, text);
}
