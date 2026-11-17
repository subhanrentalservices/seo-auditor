// Human Writer tab (owner, 14-15 Nov 2026): the detect -> humanize -> detect loop with Claude and the human-voice skill.
// Paste text written anywhere, check it (free, local detector), make an editable facts list, then let Claude rewrite
// until every 150+ word block is under 20%. Scores are shown as numbers and words, never colour alone.
import { h, mount, api, toast, num, table } from "./core.js";
import { VIEWS, NAV } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "ai") + 1, 0, { view: "writer", label: "Human Writer" });

const pc = (x) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
const LIMIT = 0.2;
const verdict = (ai) => (ai === null || ai === undefined ? ["", "no score"] : ai < LIMIT ? ["ok", "reads human"] : ai < 0.5 ? ["mid", "mixed"] : ["bad", "reads like AI"]);
const BG = { ok: "rgba(40,160,90,.13)", mid: "rgba(230,160,30,.18)", bad: "rgba(220,60,50,.15)", "": "transparent" };
const usd = (x) => `$${(x || 0).toFixed(x < 1 ? 3 : 2)}`;
const STATUS = { queued: "Waiting", running: "Working…", passed: "Passed", done: "Finished (not all blocks passed)", failed: "Failed", stopped: "Stopped" };

/** Markdown shown with each scored paragraph shaded by its block's score and a score label at the block start. */
function shaded(md, blocks) {
  const paraBlock = new Map();
  blocks.forEach((b, k) => b.paras.forEach((p, j) => paraBlock.set(p, { k, first: j === 0, ai: b.ai })));
  const [, body] = md.replace(/\r\n/g, "\n").match(/^(?:---\n[\s\S]*?\n---\n)?([\s\S]*)$/);
  const segs = [];
  for (const part of body.split(/(```[\s\S]*?```)/)) {
    if (part.startsWith("```")) { segs.push(part); continue; }
    for (const raw of part.split(/\n\s*\n/)) if (raw.trim()) segs.push(raw.trim());
  }
  return h("div", { class: "hw-text" }, segs.map((s, i) => {
    const b = paraBlock.get(i);
    if (!b) return h("p", { class: "hw-plain" }, s);
    const [cls, word] = verdict(b.ai);
    return h("p", { style: { background: BG[cls], padding: "6px 8px", borderRadius: "6px", margin: "0 0 6px" } },
      b.first ? h("span", { class: "badge", style: { marginRight: "6px" }, title: `Block ${b.k + 1}: ${word}` }, `Block ${b.k + 1} · ${pc(b.ai)} · ${word}`) : null, s);
  }));
}

function checkPanel(r, variant, onHot) {
  const pass = r.blocks.filter((b) => b.ai < LIMIT).length;
  const v = r.variant || {};
  return h("div", {},
    h("p", {}, h("b", {}, `Detector: ${pc(r.ai)} AI for the whole text`), ` · ${pass} of ${r.blocks.length} blocks under 20% · ${num(r.words)} words`,
      r.short ? h("span", { class: "small" }, " · under 90 words of prose: too short for a reliable score, so judge it by the AI phrases below")
        : r.pass ? h("span", { class: "up" }, " ✓ every block passes") : h("span", { class: "down" }, " ✕ rewrite the blocks at 20% or more")),
    r.blocks.length ? table([
      { label: "Block", get: (b) => String(r.blocks.indexOf(b) + 1) },
      { label: "AI", num: true, get: (b) => h("b", {}, pc(b.ai)) },
      { label: "Verdict", get: (b) => verdict(b.ai)[1] },
      { label: "Words", num: true, get: (b) => num(b.words) },
      { label: "Starts with", get: (b) => h("span", { class: "small" }, b.text.slice(0, 110) + "…") },
      { label: "", get: (b) => (b.ai >= LIMIT ? h("button", { class: "btn sm", onclick: () => onHot(b.text) }, "Which sentences?") : "") },
    ], r.blocks) : h("p", { class: "small muted" }, "No prose paragraphs of 8+ words found (headings, lists and tables are not scored)."),
    h("p", { class: "small" }, `AI phrases: ${r.aiCheck.hits.length ? r.aiCheck.hits.map((x) => `“${x.match}”`).join(", ") : "none"}`,
      r.aiCheck.style ? ` · style score ${r.aiCheck.style.score}/100` : ""),
    variant === "neutral"
      ? h("p", { class: "small" }, v.mixed ? `Spelling mixes American (${v.american}) and British (${v.british}) forms.` : "Spelling is consistent.")
      : h("p", { class: "small" }, v.hits?.length ? ["Other-variant spellings: ", v.hits.map((x) => `${x.word} → ${x.suggestion}${x.maybeName ? " (a name? check)" : ""}${x.count > 1 ? ` ×${x.count}` : ""}`).join(", ")] : "Spelling matches the chosen English."));
}

VIEWS.writer = async () => {
  const opt = await api("/api/writer/options");
  const sel = (o, v) => h("select", {}, Object.entries(o).map(([k, label]) => h("option", { value: k, selected: k === v }, label)));
  const input = h("textarea", { rows: 14, style: { width: "100%", fontFamily: "inherit" }, placeholder: "Paste the text here (Markdown or plain). Written anywhere: ChatGPT, Gemini, Claude, yourself." });
  const f = {
    purpose: sel(opt.purposes, "blog"), variant: sel(opt.variants, "us"), tone: sel(opt.tones, "professional"),
    level: sel(opt.levels, "normal"), length: sel(opt.lengths, "same"), model: sel(opt.models, opt.settings.model),
    mode: sel({ translate: "Translate my notes to English (reads human)", edit: "Edit my own English draft (reads human)", rewrite: "Rewrite an AI text", write: "Write from my points" }, "translate"),
    keyword: h("input", { type: "text", placeholder: "Keyword to keep (optional)", style: { width: "220px" } }),
    notes: h("input", { type: "text", placeholder: "Notes for Claude (optional), e.g. keep it under 300 words", style: { width: "360px", maxWidth: "100%" } }),
    maxRounds: h("input", { type: "number", min: 1, max: 8, value: opt.settings.maxRounds, style: { width: "60px" } }),
  };
  const reference = h("textarea", { rows: 4, style: { width: "100%", marginTop: "6px" }, placeholder: "Live page (optional, Markdown of the post you are replacing): its headings, tables, links and numbers are kept and checked, and your text goes in its place" });
  const values = () => ({ text: input.value, reference: reference.value, purpose: f.purpose.value, variant: f.variant.value, tone: f.tone.value, level: f.level.value,
    length: f.length.value, model: f.model.value, mode: f.mode.value, keyword: f.keyword.value, notes: f.notes.value, maxRounds: Number(f.maxRounds.value) });
  const studyNote = h("p", { class: "hint", style: { display: "none" } }, "Study mode keeps your own ideas and as much of your wording as possible, and only improves grammar, flow and voice. ",
    "If this is for graded work, check your school's or university's AI policy first: many require you to say when AI helped.");
  f.purpose.addEventListener("change", () => { studyNote.style.display = f.purpose.value === "study" ? "" : "none"; });
  const label = (t, el) => h("label", { class: "small", style: { display: "inline-flex", flexDirection: "column", gap: "3px", marginRight: "10px" } }, t, el);

  const out = h("div", {});
  const factsBox = h("textarea", { rows: 8, style: { width: "100%", display: "none" }, placeholder: "One fact per line" });
  const factsHint = h("p", { class: "small muted", style: { display: "none" } }, "Edit freely: delete wrong lines, add missing facts. Claude must keep every line true. Leave empty to let the run make its own list.");
  const spent = h("span", { class: "small muted" }, `Claude this month: ${usd(opt.monthSpent)} of ${usd(opt.settings.monthlyCapUsd)}`);

  const showHot = async (text) => {
    const box = h("div", { class: "card" }, h("p", { class: "small" }, "Scoring each sentence left out (local detector)…"));
    out.prepend(box);
    try {
      const r = await api("/api/writer/hotspots", { method: "POST", body: { text } });
      const max = Math.max(0.01, ...r.sentences.map((s) => s.drop));
      mount(box, h("h3", {}, `Block at ${pc(r.score)}: what pushes it up`),
        h("p", { class: "small muted" }, "Each sentence's number is how many points the block drops when that sentence is left out. Rewrite the top one or two from the facts, in new words."),
        h("div", {}, r.sentences.map((s) => h("span", { title: `${Math.round(s.drop * 100)} points`,
          style: { background: s.drop > 0.02 ? `rgba(220,60,50,${Math.min(0.35, (s.drop / max) * 0.35)})` : "transparent", padding: "1px 2px", borderRadius: "3px" } },
          s.text, h("sup", { class: "small muted" }, ` ${Math.round(s.drop * 100)}`), " "))),
        h("button", { class: "btn sm", onclick: () => box.remove() }, "Close"));
    } catch (e) { mount(box, h("p", { class: "down" }, e.message)); }
  };

  const check = h("button", { class: "btn", onclick: async () => {
    if (!input.value.trim()) return toast("Paste a text first");
    check.disabled = true; mount(out, h("p", { class: "small" }, "Checking with the local detector…"));
    try { const r = await api("/api/writer/check", { method: "POST", body: { text: input.value, variant: f.variant.value } });
      mount(out, h("div", { class: "card" }, h("h3", {}, "Check"), checkPanel(r, f.variant.value, showHot), h("h3", {}, "Your text, shaded by block"), shaded(input.value, r.blocks))); }
    catch (e) { mount(out, h("p", { class: "down" }, e.message)); }
    check.disabled = false;
  } }, "Check only (free)");
  const factsBtn = h("button", { class: "btn", onclick: async () => {
    if (!input.value.trim()) return toast("Paste a text first");
    factsBtn.disabled = true; factsBtn.textContent = "Listing facts…";
    try { const r = await api("/api/writer/facts", { method: "POST", body: { text: input.value, purpose: f.purpose.value } });
      factsBox.value = r.facts.join("\n"); factsBox.style.display = ""; factsHint.style.display = ""; toast(`${r.facts.length} facts listed (${usd(r.cost)})`); }
    catch (e) { toast(e.message); }
    factsBtn.disabled = false; factsBtn.textContent = "1. Facts list (editable)";
  } }, "1. Facts list (editable)");
  const goBtn = h("button", { class: "btn primary", onclick: async () => {
    if (!input.value.trim()) return toast("Paste a text first");
    try { const r = await api("/api/writer/runs", { method: "POST", body: { ...values(), facts: factsBox.style.display ? [] : factsBox.value.split("\n") } });
      toast(r.queued > 1 ? `Queued (${r.queued - 1} ahead)` : "Started"); showRun(r.id); loadHistory(); }
    catch (e) { toast(e.message); }
  } }, "2. Humanize with Claude");

  // ---------- a run ----------
  const showRun = async (id) => {
    let r;
    try { r = await api(`/api/writer/runs/${id}`); } catch (e) { return toast(e.message); }
    const live = r.status === "queued" || r.status === "running";
    const last = r.rounds[r.rounds.length - 1];
    const copy = h("button", { class: "btn sm", disabled: !r.output, onclick: async () => { await navigator.clipboard.writeText(r.output); toast("Copied"); } }, "Copy");
    const exp = (fmt, t) => h("a", { class: "btn sm", href: `/api/writer/runs/${id}/export?format=${fmt}`, style: r.output ? {} : { pointerEvents: "none", opacity: 0.5 } }, t);
    const fin = r.final;
    mount(out, h("div", { class: "card" },
      h("div", { class: "card-h" }, h("h3", {}, `Run ${r.id}: ${r.name}`), h("span", { class: "small muted" }, `${STATUS[r.status] || r.status} · ${opt.variants[r.options.variant]} · ${opt.purposes[r.options.purpose]} · ${usd(r.cost)} · ${num(r.tokens_in + r.tokens_out)} tokens`),
        live ? h("button", { class: "btn sm", onclick: async () => { await api(`/api/writer/runs/${id}/stop`, { method: "POST", body: {} }); toast("Stopping after the current step"); } }, "Stop") : null,
        copy, exp("md", ".md"), exp("txt", ".txt"), exp("docx", ".docx")),
      r.message ? h("p", { class: r.status === "failed" ? "down" : "small" }, r.message) : null,
      live ? h("p", { class: "small" }, "Claude and the detector are working; this updates by itself. A round takes about 1-3 minutes.") : null,
      r.rounds.length ? table([
        { label: "Round", get: (x) => x.label },
        { label: "Page AI", num: true, get: (x) => h("b", {}, pc(x.ai)) },
        { label: "Blocks under 20%", get: (x) => `${x.blocks.filter((b) => b.ai < LIMIT).length} of ${x.blocks.length}` },
        { label: "Blocks", get: (x) => h("span", { class: "small" }, x.blocks.map((b) => pc(b.ai)).join(" · ")) },
        { label: "Facts", get: (x) => (x.factFails ? (x.factFails.length ? h("span", { class: "down", title: x.factFails.join("\n") }, `✕ ${x.factFails.length} problem(s)`) : h("span", { class: "up" }, "✓ kept")) : "") },
        { label: "AI phrases", get: (x) => (x.phrases ? (x.phrases.length ? x.phrases.join(", ") : "none") : "") },
        { label: "Style", num: true, get: (x) => (x.style ?? "") },
      ], r.rounds) : null,
      last?.factFails?.length ? h("div", { class: "small down" }, h("b", {}, "Fact check: "), last.factFails.join(" · ")) : null,
      last?.warnings?.length ? h("div", { class: "small" }, h("b", {}, "Warnings: "), last.warnings.join(" · ")) : null,
      fin?.variant?.hits?.length ? h("p", { class: "small" }, "Spellings to check: ", fin.variant.hits.map((x) => `${x.word} → ${x.suggestion}${x.maybeName ? " (a name?)" : ""}`).join(", ")) : null,
      r.meaning ? h("div", { class: "small" }, h("b", {}, "Meaning check (Claude compared both texts): "),
        r.meaning.ok === true ? h("span", { class: "up" }, "✓ no meaning changed") : r.meaning.error ? h("span", {}, `not available (${r.meaning.error})`)
          : h("ul", {}, (r.meaning.issues || []).map((i) => h("li", {}, `${i.problem}${i.original ? ` — original: “${i.original}”` : ""}${i.rewrite ? `, rewrite: “${i.rewrite}”` : ""}`)))) : null,
      r.facts?.length ? h("details", {}, h("summary", { class: "small" }, `Facts list (${r.facts.length})`), h("ul", { class: "small" }, r.facts.map((x) => h("li", {}, x)))) : null,
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: "14px", marginTop: "10px" } },
        h("div", {}, h("h3", {}, `Before · ${pc(r.rounds[0]?.ai)}`), r.rounds[0] ? shaded(r.input, r.rounds[0].blocks) : h("pre", {}, r.input)),
        h("div", {}, h("h3", {}, `After · ${pc(r.rounds.length > 1 ? last.ai : null)}`), r.output && last ? shaded(r.output, last.blocks) : h("p", { class: "small muted" }, "Not written yet.")))));
    if (live) setTimeout(() => out.isConnected && showRun(id), 4000);
    else { loadHistory(); }
  };

  // ---------- history, batch, settings ----------
  const hist = h("div", {});
  const loadHistory = async () => {
    try {
      const d = await api("/api/writer/runs");
      spent.textContent = `Claude this month: ${usd(d.monthSpent)} of ${usd(d.settings.monthlyCapUsd)}${d.queue ? ` · ${d.queue} run(s) in progress` : ""}`;
      mount(hist, d.runs.length ? table([
        { label: "When", get: (x) => h("span", { class: "small" }, x.created_at) },
        { label: "Text", get: (x) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); showRun(x.id); window.scrollTo({ top: 0, behavior: "smooth" }); } }, x.name) },
        { label: "Purpose", get: (x) => opt.purposes[x.purpose] || x.purpose },
        { label: "English", get: (x) => opt.variants[x.variant] || x.variant },
        { label: "Before → after", get: (x) => `${pc(x.before)} → ${pc(x.after)}` },
        { label: "Rounds", num: true, get: (x) => x.rounds },
        { label: "Cost", num: true, get: (x) => usd(x.cost) },
        { label: "Status", get: (x) => STATUS[x.status] || x.status },
      ], d.runs) : h("p", { class: "small muted" }, "No runs yet."));
    } catch (e) { mount(hist, h("p", { class: "down" }, e.message)); }
  };
  const folder = h("input", { type: "text", placeholder: "Folder with .md or .txt files, e.g. C:\\Projects\\picturetolink.com\\content\\posts", style: { width: "460px", maxWidth: "100%" } });
  const batchBtn = h("button", { class: "btn", onclick: async () => {
    batchBtn.disabled = true;
    try { const r = await api("/api/writer/batch", { method: "POST", body: { ...values(), text: undefined, folder: folder.value, urls: urlsIn.value } });
      toast(`${r.runs} texts queued`);
      mount(batchOut, h("p", { class: "small" }, `${r.runs} texts queued as ${r.batch}. Results are saved to ${r.out}; your folder and pages are only read, never changed.`),
        r.skipped?.length ? h("p", { class: "small down" }, "Skipped: ", r.skipped.map((x) => `${x.url} (${x.why})`).join(", ")) : null);
      loadHistory(); }
    catch (e) { toast(e.message); }
    batchBtn.disabled = false;
  } }, "Queue them");
  const urlsIn = h("textarea", { rows: 3, style: { width: "100%" }, placeholder: "Or page URLs, one per line (main content is read as Markdown; robots.txt is obeyed)" });
  const batchOut = h("div", {});
  const cap = h("input", { type: "number", min: 0, step: 1, value: opt.settings.monthlyCapUsd, style: { width: "80px" } });
  const rounds = h("input", { type: "number", min: 1, max: 8, value: opt.settings.maxRounds, style: { width: "60px" } });
  const model = sel(opt.models, opt.settings.model);
  const saveSet = h("button", { class: "btn sm", onclick: async () => {
    try { await api("/api/writer/settings", { method: "POST", body: { monthlyCapUsd: Number(cap.value), maxRounds: Number(rounds.value), model: model.value } }); toast("Saved"); loadHistory(); }
    catch (e) { toast(e.message); }
  } }, "Save");

  loadHistory();
  return [
    h("div", { class: "card" },
      h("div", { class: "card-h" }, h("h2", {}, "Human Writer"), spent),
      h("p", { class: "hint" }, "Paste a text written anywhere. ", h("b", {}, "Check only"), " scores it with the local AI detector (every 150+ word block; under 20% reads human) and costs nothing. ",
        h("b", {}, "Humanize"), " lets Claude rewrite it with the human-voice skill, checks it again, rewrites only the blocks still at 20% or more, and repeats up to the round limit. Every round also checks that numbers, links, bold labels and code are unchanged, the chosen English spelling, and AI phrases; at the end Claude compares the meaning of both texts. ",
        "Scores are this tool's detector: other detectors (GPTZero, Originality) can disagree."),
      h("p", { class: "hint" }, h("b", {}, "What works (tested 15 Nov 2026): "), "a draft a person wrote, even a rough one, edited by Claude keeps reading human (0-18% even with most sentences changed), because the detector reads the shape of the writing: which points come first and which details were chosen. ",
        "A text an AI wrote from scratch scores 100% on this detector in any style, and rewriting it rarely gets it under 20%. So for pages that must pass, write the text yourself, in Roman Urdu or any language, as long as the final page should be, and use ",
        h("b", {}, "Translate my notes to English"), " (your own notes translated faithfully: 0%; the same notes polished: 64%; five short points expanded by Claude: 100%)."),
      input, reference,
      h("div", { class: "row", style: { flexWrap: "wrap", alignItems: "flex-end", marginTop: "8px" } },
        label("Purpose", f.purpose), label("English", f.variant), label("Tone", f.tone), label("Reader", f.level), label("Length", f.length),
        label("Mode", f.mode), label("Claude", f.model), label("Rounds", f.maxRounds)),
      h("div", { class: "row", style: { flexWrap: "wrap", marginTop: "6px" } }, f.keyword, f.notes),
      studyNote,
      h("div", { class: "row", style: { marginTop: "8px", flexWrap: "wrap" } }, check, factsBtn, goBtn),
      factsHint, factsBox),
    out,
    h("div", { class: "card" }, h("h2", {}, "History"), h("p", { class: "hint" }, "Every run with its scores and Claude cost (as Claude Code reports it, API-equivalent). Click a text to open it."), hist),
    h("div", { class: "card" }, h("h2", {}, "Batch"), h("p", { class: "hint" }, "Humanizes every .md and .txt file in a folder, or a list of pages, with the options above, one after another. The folder is only read; results go to the SEO Auditor's data/writer-out folder, so nothing goes live until you copy it."),
      h("div", { class: "row" }, folder), urlsIn, h("div", { class: "row", style: { marginTop: "6px" } }, batchBtn), batchOut),
    h("div", { class: "card" }, h("h2", {}, "Human Writer settings"),
      h("div", { class: "row", style: { flexWrap: "wrap", alignItems: "flex-end" } }, label("Monthly Claude limit (USD)", cap), label("Default rounds", rounds), label("Default Claude", model), saveSet),
      h("p", { class: "small muted" }, "Runs stop before a Claude call once this month's total reaches the limit.")),
  ];
};
