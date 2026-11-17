"""Rewrite the prose of a Markdown page with a local humanizer model, keeping every fact, and check each rewrite with
the SEO Auditor's AI detector (owner asked 2026-11-11: "humanize text ke liye koi repo ya model dekh lo").

Model: jialinyyzz/humanizer (Gemma-4-12B fine-tune, Apache-2.0), GGUF run by llama.cpp's llama-server, partly on the
GPU (-ngl). Prompt and sampling exactly as its model card says (prompt_format.json; temperature 1.0, top-p 0.95,
top-k 0, min-p 0, no repetition penalty, stop on EOS only).

What is rewritten: runs of prose paragraphs between headings, up to ~MAX_WORDS words per request. Front matter,
headings, lists, tables, images, code, HTML and blockquotes are copied unchanged.

Each block gets SAMPLES candidates. A candidate is kept only if
  1. every number in the original is still there (with its unit nearby), every link's anchor text is still there
     (the link is put back on it), and every capitalised name and every quoted phrase survives;
  2. it has no phrase tells (SEO Auditor ai-check: em dashes, "it's not X, it's Y", hype words ...);
then the one with the lowest detector score wins. If none qualifies, the original block stays and is listed in the
report for a person to look at.

Usage: python humanizer/humanize.py <page.md> [--out <dir>] [--samples 3] [--ngl 18] [--model <gguf>] [--tag -x]
       [--style humanizer|smaug|rewrite] [--proof-model <gguf> [--proof-ngl N]]
Writes <out>/<name>.md and <out>/<name>.report.json; never touches the input file.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "detector"))
os.environ.setdefault("DETECT_DEVICE", "cpu")  # the GPU is the llama-server's
import detect  # noqa: E402

MODEL = os.path.join(HERE, "model", "humanizer-12b-Q8_0.gguf")
SERVER = os.path.join(HERE, "llama", "llama-server.exe")
PORT = 8091
MAX_WORDS = 320


def arg(name, default, cast=str):
    return cast(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


# ---------- llama-server ----------
CHAT = False  # --chat: abacusai/Smaug-Humanizer's chat format (one user turn with its prompt, from its model card)
SMAUG_PROMPT = """Rewrite the AI-written text below so that it reads as if a person wrote it, in a person's own voice, wording and rhythm.

Keep every fact, number, name and quote. Keep the structure and the language of the text. Output only the rewritten text.

Text:
{text}"""


def start_server(ngl, model):
    log = open(os.path.join(HERE, "llama-server.log"), "w")
    p = subprocess.Popen([SERVER, "-m", model, "-c", "8192", "-np", "1", "-ngl", str(ngl), "--host", "127.0.0.1",
                          "--port", str(PORT), "--jinja"], stdout=log, stderr=subprocess.STDOUT)
    for _ in range(600):
        try:
            if json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2)).get("status") == "ok":
                return p
        except Exception:
            pass
        if p.poll() is not None:
            raise SystemExit("llama-server stopped; see humanizer/llama-server.log")
        time.sleep(1)
    raise SystemExit("llama-server did not become ready")


# --style rewrite: a general instruct model (Gemma, Qwen, Mistral) rewrites the draft in its own words.
REWRITE_PROMPT = """Rewrite the text below for a how-to website. Write it the way an experienced human tech writer explains things to a reader: plain everyday words, sentences of different lengths (some very short), a direct and friendly tone, and no filler, hype or sales language. Do not use em dashes. Do not turn it into a list.

Keep every fact, number, unit, name, quoted phrase and the exact wording of these link texts: {links}. Do not add facts, examples, opinions or advice that are not in the text. Keep the same paragraph breaks. Output only the rewritten text.

Text:
{text}"""

# --proof-model: a second model corrects only grammar and meaning errors in the rewrite, keeping its voice.
PROOF_PROMPT = """You are a copy editor. Below is an ORIGINAL text and a REWRITE of it. Fix the REWRITE only where it has a grammar or spelling mistake, a broken or unclear sentence, or a meaning that differs from the ORIGINAL. Keep the rewrite's own wording, tone and sentence lengths everywhere else. Do not polish sentences that are already correct, do not add anything, do not use em dashes. Keep these link texts exactly: {links}. Output only the corrected REWRITE.

ORIGINAL:
{original}

REWRITE:
{text}"""

# --meaning-check (with --proof-model): the proof model lists statements whose meaning changed, then fixes only those.
JUDGE_PROMPT = """Compare the REWRITE with the ORIGINAL. List every statement in the REWRITE that says something different from the ORIGINAL: a reversed or changed fact, a wrong cause or effect, an added claim, or a lost condition. Ignore differences in wording, tone, order and sentence length. Write one problem per line, quoting the REWRITE's words and saying what the ORIGINAL says instead. If there are none, write exactly NONE.

ORIGINAL:
{original}

REWRITE:
{text}"""

FIX_PROMPT = """Below is an ORIGINAL text, a REWRITE of it and a list of PROBLEMS where the REWRITE changed the meaning. Correct only the sentences named in PROBLEMS so they say what the ORIGINAL says, keeping the REWRITE's wording and tone as far as possible. Leave every other sentence exactly as it is. Do not use em dashes. Keep these link texts exactly: {links}. Output only the corrected REWRITE.

ORIGINAL:
{original}

REWRITE:
{text}

PROBLEMS:
{problems}"""

STYLE = "humanizer"


def _chat(content, seed, temperature, top_k, stop=None):
    body = {"messages": [{"role": "user", "content": content}], "temperature": temperature, "top_p": 0.95, "top_k": top_k,
            "min_p": 0, "repeat_penalty": 1.0, "max_tokens": 2048, "seed": seed,
            "chat_template_kwargs": {"enable_thinking": False}}  # Qwen3: no thinking block
    if stop:
        body["stop"] = stop
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions", json.dumps(body).encode("utf-8"),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1800) as r:
        out = json.load(r)["choices"][0]["message"]["content"]
    return re.sub(r"(?s)<think>.*?</think>", "", out).strip()


def humanize(draft, seed, links=(), original=None, style=None, problems=None):
    style = style or STYLE
    link_list = ", ".join(f'"{a}"' for a, _ in links) or "(none)"
    if style == "proofread":
        return _chat(PROOF_PROMPT.format(text=draft.strip(), original=(original or "").strip(), links=link_list), seed, 0.2, 20)
    if style == "judge":
        return _chat(JUDGE_PROMPT.format(text=draft.strip(), original=(original or "").strip()), seed, 0.1, 10)
    if style == "fix":
        return _chat(FIX_PROMPT.format(text=draft.strip(), original=(original or "").strip(), links=link_list,
                                       problems=problems or ""), seed, 0.2, 20)
    if style == "smaug" or CHAT:
        return _chat(SMAUG_PROMPT.format(text=draft.strip()), seed, 1.0, 64, ["<end_of_turn>"])
    if style == "rewrite":
        return _chat(REWRITE_PROMPT.format(text=draft.strip(), links=link_list), seed, 0.8, 40)
    # jialinyyzz/humanizer: plain completion with its own prompt (model/prompt_format.json from its repo)
    PF = json.load(open(os.path.join(HERE, "model", "prompt_format.json"), encoding="utf-8"))
    body = {"prompt": PF["instr"] + "\n\n" + draft.strip() + PF["sep"], "temperature": 1.0, "top_p": 0.95, "top_k": 0,
            "min_p": 0, "repeat_penalty": 1.0, "n_predict": 2048, "seed": seed}
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/completion", json.dumps(body).encode("utf-8"), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1800) as r:
        return json.load(r)["content"].strip()


# ---------- Markdown blocks ----------
def split_blocks(md):
    """[(kind, text)]: kind "keep" (copied as is) or "prose" (rewritten). Prose paragraphs that follow each other are
    grouped up to MAX_WORDS words."""
    fm = ""
    m = re.match(r"(?s)^---\n.*?\n---\n", md)
    if m:
        fm, md = m.group(0), md[m.end():]
    blocks = [("keep", fm)] if fm else []
    paras = re.split(r"\n\s*\n", md)
    group = []

    def flush():
        if group:
            blocks.append(("prose", "\n\n".join(group)))
            group.clear()

    for p in paras:
        s = p.strip()
        if not s:
            continue
        is_prose = not re.match(r"^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||!\[|<|>|```|    )", s) and "\n|" not in s
        if is_prose:
            if group and sum(len(g.split()) for g in group) + len(s.split()) > MAX_WORDS:
                flush()
            group.append(s)
        else:
            flush()
            blocks.append(("keep", s))
    flush()
    return blocks


LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")


def plain(md):
    """Prose for the model: links become their anchor text, bold/italics marks go."""
    return re.sub(r"(\*\*|__)", "", LINK.sub(r"\1", md))


def _words(s):
    return re.findall(r"[a-z0-9]+", s.lower())


def relink(text, links):
    """Put each link back on its anchor text: the exact phrase if it survived, else the closest run of words in the
    rewrite (at least 60% of the anchor's words, same order not required, no longer than anchor + 3 words).
    Returns (text, anchors that could not be placed)."""
    missing = []
    for anchor, url in links:
        i = text.lower().find(anchor.lower())
        if i >= 0:
            text = text[:i] + f"[{text[i:i + len(anchor)]}]({url})" + text[i + len(anchor):]
            continue
        want = set(_words(anchor)) - {"the", "a", "an", "of", "to", "on", "in", "and", "for"}
        if not want:
            missing.append(anchor)
            continue
        best = None
        # candidate spans: runs of words outside existing links
        tokens = [(m.start(), m.end(), m.group(0).lower()) for m in re.finditer(r"[A-Za-z0-9][\w'-]*", text)]
        n = len(_words(anchor))
        for a in range(len(tokens)):
            for b in range(a, min(len(tokens), a + n + 3)):
                span = {re.sub(r"[^a-z0-9]", "", t[2]) for t in tokens[a:b + 1]}
                hit = len(want & span) / len(want)
                if hit >= 0.6 and (best is None or (hit, -(b - a)) > (best[0], -(best[2] - best[1]))):
                    best = (hit, a, b)
        if best is None:
            missing.append(anchor)
            continue
        s, e = tokens[best[1]][0], tokens[best[2]][1]
        if "[" in text[max(0, s - 1):e + 1] or "](" in text[s:e + 2]:
            missing.append(anchor)
            continue
        text = text[:s] + f"[{text[s:e]}]({url})" + text[e:]
    return text, missing


def clean_output(text, original):
    """Model slips that are not writing: stray HTML tags become paragraph breaks, and phrases that were bold in the
    original get their bold back where they survive."""
    text = re.sub(r"\s*</?p>\s*", "\n\n", text)
    text = re.sub(r"<[^>]{1,20}>", "", text).strip()
    for b in set(re.findall(r"\*\*([^*]{2,60})\*\*", original)):
        i = text.find(b)
        if i >= 0 and text[max(0, i - 2):i] != "**":
            text = text[:i] + f"**{b}**" + text[i + len(b):]
    return text


# ---------- fact check ----------
NUM = re.compile(r"\d[\d,.]*\s?(?:%|×|x\b|px|kb|mb|gb|tb|mp|ms|s\b|hz|fps|dpi|ppi|°|in\b|cm|mm|kg|lb)?", re.I)
STOP_CAPS = {"The", "A", "An", "It", "If", "In", "On", "Or", "And", "But", "So", "That", "This", "These", "Those", "You",
             "Your", "We", "Our", "They", "Their", "When", "What", "Why", "How", "For", "To", "With", "At", "As", "By",
             "From", "Most", "Some", "Each", "Every", "One", "Two", "Few", "Many", "Then", "There", "Here", "No", "Yes",
             "Not", "Also", "Even", "Only", "Next", "First", "Second", "Use", "Open", "Choose", "Pick", "Check", "Keep"}


def facts(text):
    """Numbers, names and quoted phrases. Names are runs of capitalised words that are not the first word of a
    sentence, taken one sentence at a time (so "DC-008. CIPA" is two things, and "Whether" at a sentence start is
    not a name)."""
    nums = {re.sub(r"\s", "", n.lower()).rstrip(".,") for n in NUM.findall(text)}
    names = set()
    for sent in re.split(r"(?<=[.!?:])\s+|\n+", text):
        toks = re.findall(r"[A-Za-z0-9][\w&+.'-]*", sent)
        run = []
        for k, t in enumerate(toks):
            t = t.rstrip(".'")
            cap = bool(re.match(r"[A-Z]", t)) or bool(re.match(r"[A-Za-z]*\d", t) and re.search(r"[A-Z]", t))
            if cap and k > 0 and t not in STOP_CAPS:
                run.append(t)
            else:
                if run:
                    names.add(" ".join(run))
                run = []
        if run:
            names.add(" ".join(run))
    quotes = set(re.findall(r'"([^"]{3,80})"', text))
    return nums, {n for n in names if len(n) > 1}, quotes


def lost_facts(orig, new):
    on, onames, oq = facts(orig)
    nn, _, _ = facts(new)
    low = new.lower()
    lost = [n for n in on if re.sub(r"[a-z%×°]+$", "", n) and re.sub(r"[a-z%×°]+$", "", n) not in "".join(nn)]
    new_tokens = set(_words(new))
    lost += [n for n in onames if not set(_words(n)) <= new_tokens]  # every word of the name still in the rewrite
    lost += [f'"{q}"' for q in oq if q.lower() not in low]
    return lost


def phrase_tells(text):
    r = subprocess.run(["node", os.path.join(ROOT, "src", "cli.mjs"), "ai-check", "-"], input=text, capture_output=True, text=True, encoding="utf-8")
    return [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("line ")]


# ---------- main ----------
def main():
    src = sys.argv[1]
    out_dir = arg("--out", os.path.join(HERE, "out"))
    samples = arg("--samples", 3, int)
    ngl = arg("--ngl", 18, int)
    model = arg("--model", MODEL)
    global CHAT, STYLE
    CHAT = "--chat" in sys.argv
    STYLE = arg("--style", "smaug" if CHAT else "humanizer")
    proof_model = arg("--proof-model", None)
    os.makedirs(out_dir, exist_ok=True)
    md = open(src, encoding="utf-8").read().replace("\r\n", "\n")
    blocks = split_blocks(md)
    prose = [i for i, (k, _) in enumerate(blocks) if k == "prose"]
    detect.log(f"{len(prose)} prose blocks to rewrite, {samples} samples each")
    name = os.path.splitext(os.path.basename(src))[0] + arg("--tag", "")
    # Phase 1: generate every candidate with only the language model in memory. Each finished block is saved to a
    # checkpoint, so a stopped run resumes where it left off.
    ckpt_path = os.path.join(out_dir, name + ".cands.json")
    ckpt = json.load(open(ckpt_path, encoding="utf-8")) if os.path.exists(ckpt_path) else {}
    todo = [i for i in prose if str(i) not in ckpt]
    if todo:
        server = start_server(ngl, model)
        try:
            for i in todo:
                text = blocks[i][1]
                links = LINK.findall(text)
                draft = plain(text)
                cands = []
                for s in range(samples):
                    t0 = time.time()
                    new = clean_output(humanize(draft, seed=1000 + 17 * i + s, links=links), text)
                    relinked, missing = relink(new, links)
                    cands.append({"text": relinked, "plain": new, "missing_links": missing, "lost": lost_facts(draft, new),
                                  "tells": phrase_tells(new), "secs": round(time.time() - t0)})
                    c = cands[-1]
                    detect.log(f"block {prose.index(i) + 1}/{len(prose)} sample {s + 1}: lost {len(c['lost'])}, "
                               f"links missing {len(missing)}, tells {len(c['tells'])}, {c['secs']} s")
                ckpt[str(i)] = cands
                json.dump(ckpt, open(ckpt_path, "w", encoding="utf-8"), ensure_ascii=False)
        finally:
            server.terminate()
            server.wait(timeout=60)
    # Phase 1b (--proof-model): a second model fixes grammar and meaning slips in every candidate, keeping its voice.
    if proof_model and any(not c.get("proofed") for cs in ckpt.values() for c in cs):
        server = start_server(arg("--proof-ngl", ngl, int), proof_model)
        try:
            for i in prose:
                text = blocks[i][1]
                links = LINK.findall(text)
                draft = plain(text)
                for c in ckpt[str(i)]:
                    if c.get("proofed"):
                        continue
                    t0 = time.time()
                    fixed = clean_output(humanize(c["plain"], seed=7, links=links, original=draft, style="proofread"), text)
                    problems = []
                    if "--meaning-check" in sys.argv:
                        # up to two rounds: list meaning changes, fix only those sentences, check again
                        for _ in range(2):
                            verdict = humanize(fixed, seed=11, original=draft, style="judge").strip()
                            if not verdict or verdict.upper().startswith("NONE"):
                                break
                            problems.append(verdict)
                            fixed = clean_output(humanize(fixed, seed=13, links=links, original=draft, style="fix",
                                                          problems=verdict), text)
                    relinked, missing = relink(fixed, links)
                    c.update({"before_proof": c["plain"], "plain": fixed, "text": relinked, "missing_links": missing,
                              "lost": lost_facts(draft, fixed), "tells": phrase_tells(fixed), "proofed": True,
                              "meaning_problems": problems})
                    detect.log(f"block {prose.index(i) + 1}/{len(prose)} proofread: lost {len(c['lost'])}, links missing "
                               f"{len(missing)}, tells {len(c['tells'])}, {round(time.time() - t0)} s")
                json.dump(ckpt, open(ckpt_path, "w", encoding="utf-8"), ensure_ascii=False)
        finally:
            server.terminate()
            server.wait(timeout=60)
    # Phase 2: the language model is out of memory; now load the detector and score.
    tuned = detect.Tuned()
    score = lambda t: tuned.score(" ".join(detect.normalize(t).split()))  # noqa: E731
    report = []
    out = []
    for i, (kind, text) in enumerate(blocks):
        if kind != "prose":
            out.append(text)
            continue
        cands = ckpt[str(i)]
        for c in cands:
            c["ai"] = score(c["plain"])
        before = score(plain(text))
        detect.log(f"block {prose.index(i) + 1}/{len(prose)}: AI before {before:.0%}, candidates "
                   + ", ".join(f"{c['ai']:.0%}" + ("" if not (c["lost"] or c["missing_links"] or c["tells"]) else "x") for c in cands))
        ok = [c for c in cands if not c["lost"] and not c["missing_links"] and not c["tells"]]
        best = min(ok, key=lambda c: c["ai"]) if ok else None
        out.append(best["text"] if best else text)
        report.append({"block": prose.index(i) + 1, "original": text, "ai_before": before,
                       "chosen": best["text"] if best else None, "ai_after": best["ai"] if best else before,
                       "kept_original": best is None, "candidates": cands})
    open(os.path.join(out_dir, name + ".md"), "w", encoding="utf-8").write("\n\n".join(out).replace("---\n\n", "---\n", 1) + "\n")
    json.dump(report, open(os.path.join(out_dir, name + ".report.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    rewritten = [r for r in report if not r["kept_original"]]
    words = lambda t: len(t.split())  # noqa: E731
    wb = sum(words(r["original"]) for r in report)
    print(f"{name}: {len(rewritten)}/{len(report)} prose blocks rewritten")
    print(f"  AI before (word-weighted): {sum(r['ai_before'] * words(r['original']) for r in report) / max(1, wb):.0%}")
    print(f"  AI after  (word-weighted): {sum(r['ai_after'] * words(r['original']) for r in report) / max(1, wb):.0%}")
    for r in report:
        if r["kept_original"]:
            c = min(r["candidates"], key=lambda c: len(c["lost"]) + len(c["missing_links"]) + len(c["tells"]))
            print(f"  block {r['block']} kept: lost {c['lost'][:4]} links {c['missing_links'][:3]} tells {c['tells'][:2]}")


if __name__ == "__main__":
    main()
