"""Dataset v5 (2026-11-14): dataset v4 (calset4.json, Claude drafts vs pre-2022 human articles) plus text from many
other models, so the detector catches every common AI and not only Claude (owner: "har ak ai ka text pakarne ka liya
train karo"). Writes data/calset5.json. Rows: {"text", "label": 1 AI | 0 human, "group", "src", "doc", "split"}.

Sources in data/multi/ (all public on Hugging Face):
  - HAP-E-2 (browndw/human-ai-parallel-corpus-2, MIT): a model was given 500 words of a human text and wrote the next
    500; the human's real next 500 words (chunk_2) are the human side. Academic, news, fiction, spoken, blogs, TV.
    Models: GPT-4o, GPT-4o-mini, GPT-5-mini, Claude Haiku 4.5, Gemma 2 9B/27B, Llama 3 8B/70B (instruct and base).
    One document gives a human passage and one AI passage from a randomly chosen model, so topic can't separate them.
  - ELI5 2026 (mild-rgb/eli5-human-vs-ai, CC BY 4.0): answers from GPT-5.6, Gemini 3.7 Flash, DeepSeek V4, Qwen 3.8,
    Grok 4.6, GLM 5.3, Nemotron 3.5, prompted to sound like a Reddit answer (em dashes and curly quotes removed).
    Human side: HC3 reddit_eli5 human answers (pre-2022), same subreddit.
  - coai (coai/ai-text-detection-training): arXiv abstracts (human) and the same abstracts paraphrased by Gemini 3
    Flash, GPT-5-nano, gpt-oss-120b and Claude Haiku 4.5, i.e. AI-rewritten text.
External tests, never trained on (split "ext"):
  - TextSight 2026 benchmark (textsightai/ai-text-detection-benchmark-2026, CC BY-SA 4.0): Claude Opus 5, Claude
    Haiku 4.5, GPT-4.1, gpt-oss-120b, Qwen 3.8 vs pre-2022 Wikipedia and PubMed Central papers.
  - AITA 2026 (mild-rgb/aita-human-vs-ai): the same 2026 models writing Reddit "Am I the asshole" stories (AI only;
    the human posts are not redistributed).
Splits are by source document (HAP-E doc, ELI5 question, arXiv id), 70/15/15 within each group.
"""
import collections, glob, json, os, random, re, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
from detect import normalize  # noqa: E402
import pandas as pd  # noqa: E402

random.seed(14)
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
M = os.path.join(D, "multi")


def passage(text, lo=150, hi=260, start=0):
    """One passage of lo-hi words from normalised text, starting at a paragraph boundary near `start` words in."""
    paras = [p for p in normalize(text).split("\n") if p]
    words, out, n = [], [], 0
    for p in paras:
        n += len(p.split())
        if n < start:
            continue
        words += p.split()
        if len(words) >= hi:
            break
    return " ".join(words[:hi]) if len(words) >= lo else None


rows = []


def add(text, label, group, src, doc):
    if text:
        rows.append({"text": text, "label": label, "group": group, "src": f"{group}-{src}", "doc": doc})


# ---------- HAP-E-2 ----------
INSTRUCT = ["gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18", "gpt-5-mini-2025-08-07", "claude-haiku-4-5-20251001",
            "gemma-2-27b-it", "gemma-2-9b-it", "Meta-Llama-3-70B-Instruct", "Meta-Llama-3-8B-Instruct"]
BASE = ["gemma-2-27b", "gemma-2-9b", "Meta-Llama-3-70B", "Meta-Llama-3-8B"]
human = pd.read_parquet(os.path.join(M, "hape2_chunk_2.parquet"))
human["d"] = human.doc_id.str.split("@").str[0]
hmap = dict(zip(human.d, human.text))
gen = {}
for m in INSTRUCT + BASE:
    df = pd.read_parquet(os.path.join(M, f"hape2_{m}.parquet"))
    gen[m] = dict(zip(df.doc_id.str.split("@").str[0], df.text))
docs = sorted(hmap)
random.shuffle(docs)
docs = docs[:3200]
# 3 of 4 documents get an instruct model, 1 of 4 a base model (base models continue the text, no chat tone)
for i, d in enumerate(docs):
    add(passage(hmap[d]), 0, "hapeh", d.split("_")[0], f"hape-{d}")
    m = random.choice(BASE if i % 4 == 3 else INSTRUCT)
    if d in gen[m]:
        add(passage(gen[m][d]), 1, "hapeai", m, f"hape-{d}")

# ---------- ELI5 2026 (AI) + HC3 reddit_eli5 (human) ----------
eli = [json.loads(l) for l in open(os.path.join(M, "eli5_2026.jsonl"), encoding="utf-8")]
for r in eli:
    if r["label"] == "ai":
        add(passage(r["text"], lo=120), 1, "eli5ai", r["model"].split("/")[-1], f"eli5-{r['question_id']}")
hum = []
for i, line in enumerate(open(os.path.join(D, "reddit_eli5.jsonl"), encoding="utf-8")):
    r = json.loads(line)
    for j, t in enumerate(r.get("human_answers") or []):
        t = re.sub(r"_URL_\d+_", "", t)
        if 150 <= len(t.split()) <= 700:
            hum.append((f"hc3eli5-{i}", t))
            break
random.shuffle(hum)
for d, t in hum[:2600]:
    add(passage(t), 0, "eli5h", "reddit", d)

# ---------- coai arXiv abstracts and their AI paraphrases ----------
# arxiv_id is empty in this release; each abstract is followed by its paraphrase (checked: 94% of 1,000 pairs share
# >20% of their words), so the row pair is the document.
pairs = []
for s in ("train", "test"):
    co = pd.read_parquet(os.path.join(M, f"coai_{s}.parquet")).reset_index(drop=True)
    for i in range(0, len(co) - 1, 2):
        hu, ai = co.iloc[i], co.iloc[i + 1]
        if hu.label == 0 and ai.label == 1 and ai.model_name != "openai/gpt-oss-20b":
            pairs.append((f"arxiv-{s}-{i // 2}", hu.text, ai.text, ai.model_name.split("/")[-1]))
random.shuffle(pairs)
# one side per abstract, so the model never sees an abstract and its own paraphrase together
for k, (d, ht, at, m) in enumerate(pairs[:2600]):
    if k % 2:
        add(passage(ht, lo=90), 0, "arxivh", "arxiv", d)
    else:
        add(passage(at, lo=90), 1, "arxivai", m, d)

# ---------- splits by document within each group family ----------
fam = lambda g: {"hapeh": "hape", "hapeai": "hape", "arxivh": "arxiv", "arxivai": "arxiv"}.get(g, g)  # noqa: E731
by = collections.defaultdict(set)
for r in rows:
    by[fam(r["group"])].add(r["doc"])
split_of = {}
for g, ds in by.items():
    ds = sorted(ds)
    random.shuffle(ds)
    for i, d in enumerate(ds):
        split_of[d] = "test" if i < round(len(ds) * 0.15) else "val" if i < round(len(ds) * 0.30) else "train"
for r in rows:
    r["split"] = split_of[r["doc"]]

# ---------- external tests ----------
for f, label in (("ts_ai_generated_2026-09-29", 1), ("ts_human_wikipedia_pre2022", 0), ("ts_human_pmc_ccby_nonanglophone", 0)):
    for i, line in enumerate(open(os.path.join(M, f + ".jsonl"), encoding="utf-8")):
        r = json.loads(line)
        t = " ".join(normalize(r["text"]).split())
        if len(t.split()) >= 60:
            src = r.get("source") if label else ("wikipedia" if "wiki" in f else "pmc")
            rows.append({"text": " ".join(t.split()[:260]), "label": label, "group": "ts" + ("ai" if label else "h"),
                         "src": f"ts-{src}", "doc": f"{f}-{i}", "split": "ext"})
aita = [json.loads(l) for l in open(os.path.join(M, "aita_2026.jsonl"), encoding="utf-8")]
aita = [r for r in aita if r["label"] == "ai" and r.get("text")]
random.shuffle(aita)
for r in aita[:350]:
    t = passage(r["text"], lo=100)
    if t:
        rows.append({"text": t, "label": 1, "group": "aitaai", "src": f"aita-{r['generator'].split('/')[-1]}",
                     "doc": r["doc_id"], "split": "ext"})

# ---------- merge with dataset v4 ----------
v4 = json.load(open(os.path.join(D, "calset4.json"), encoding="utf-8"))
allrows = v4 + rows
random.shuffle(allrows)
json.dump(allrows, open(os.path.join(D, "calset5.json"), "w", encoding="utf-8"))
print(len(allrows), "passages;", collections.Counter((r["split"], r["label"]) for r in allrows))
for s in ("train", "val", "test", "ext"):
    print(s, dict(collections.Counter(r["group"] for r in allrows if r["split"] == s)))
print("AI sources:", dict(collections.Counter(r["src"] for r in rows if r["label"] == 1 and r["split"] != "ext")))
