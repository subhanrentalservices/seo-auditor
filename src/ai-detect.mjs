// Model-based AI-text detector (owner asked 2026-11-11 for a check that works like GPTZero / Originality).
// Runs detector/detect.py locally: the desklib DeBERTa-v3-large detector fine-tuned on this project's data
// (detector/finetune.py; v3, 15 Nov 2026: 23 models, 99.4% of held-out AI text caught, 2.0% of human passages flagged,
// more on formal reference prose; see detector/README.md).
// Nothing is sent anywhere. Python with torch + transformers is needed: detector/.venv-gpu (CUDA) when it exists,
// else "python"; SEO_AUDITOR_PYTHON overrides both.
// The phrase/style check in ai-check.mjs stays: it says *what* to rewrite; this says how machine-like the text reads.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "detector", "detect.py");
const GPU_PY = path.join(HERE, "..", "detector", ".venv-gpu", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const defaultPython = () => process.env.SEO_AUDITOR_PYTHON || (existsSync(GPU_PY) ? GPU_PY : "python");

/** Page probability at or above this is reported as AI-like. */
export const AI_LIKELY = 0.5;
/** ai-check --detect passes only below this page probability and with no paragraph block at AI_LIKELY or above. */
export const AI_PASS_BELOW = 0.2;

/** Readable text of a page in document order: headings, paragraphs, list items and table cells of the main content. */
export function textFromHtml(html) {
  const $ = cheerio.load(html);
  const scope = $("main").length ? $("main") : $("body").length ? $("body") : $.root();
  scope.find("script,style,nav,header,footer,noscript,svg,form,button,[aria-hidden=true]").remove();
  const out = [];
  scope.find("h1,h2,h3,h4,p,li,blockquote,td").each((_, e) => {
    if ($(e).find("p,li").length) return; // the inner element carries the text
    const t = $(e).text().replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  });
  return out.join("\n\n");
}

/** Markdown to plain prose: front matter, code, tables and image lines dropped; links keep their text. */
export function textFromMarkdown(md) {
  return String(md || "")
    .replace(/^---[\s\S]*?\n---\s*/, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\||!\[|<)/.test(l))
    .map((l) => l.replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, ""))
    .join("\n");
}

/** Score texts with the local models. Returns [{ ai, words, signals, chunks: [{ text, words, ai, signals }] }]. */
export function detectAi(texts, { python = defaultPython(), signals, model, whole } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      err += d;
      if (process.env.SEO_AUDITOR_DETECT_VERBOSE) process.stderr.write(d);
    });
    child.on("error", (e) => reject(new Error(`could not start ${python}: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`detector exited with ${code}: ${err.split("\n").filter(Boolean).slice(-5).join(" | ")}`));
      try {
        resolve(JSON.parse(out).results);
      } catch (e) {
        reject(new Error(`detector output unreadable: ${e.message}`));
      }
    });
    child.stdin.end(JSON.stringify({ texts, signals, model, whole }));
  });
}

/** Verdict for one result, shared by the CLI and ai-check --detect. */
export function detectVerdict(r) {
  const worst = Math.max(0, ...r.chunks.map((c) => c.ai ?? 0));
  const pass = r.ai != null && r.ai < AI_PASS_BELOW && worst < AI_LIKELY;
  const label = r.ai == null ? "no score" : r.ai >= AI_LIKELY ? "likely AI" : r.ai >= AI_PASS_BELOW ? "mixed" : "likely human";
  return { pass, label, percent: r.ai == null ? null : Math.round(r.ai * 100), worst: Math.round(worst * 100) };
}
