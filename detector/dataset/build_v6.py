"""Dataset v6 (2026-11-15): dataset v5 (calset5.json) plus formal, encyclopedic human text, because detector v3
flagged 15% of pre-2022 Wikipedia and 8% of PubMed Central passages in the external test (owner: human false
positives near 0%). Writes data/calset6.json; the v5 rows keep their splits, so v3 and v4 are compared on the same
test and ext rows.

Added (all pre-2022 human text, each paired with an AI text on the same topic so topic can't separate them):
  - GPT-wiki-intro (aadityaubhat/GPT-wiki-intro, CC): 150,000 Wikipedia introductions (human) and a GPT-3
    "200 word wikipedia style introduction" on the same title. One side per title.
  - HC3 wiki_csai (Hello-SimpleAI/HC3): Wikipedia answers on computer science and AI topics (human) and ChatGPT's
    answers to the same question. One side per question.
Human side is weighted 3:2 over AI, since the gap is false alarms on human text, not missed AI.
The ext rows (TextSight Wikipedia/PMC, AITA) are untouched and still never trained on.
"""
import collections
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
from detect import normalize  # noqa: E402
import pandas as pd  # noqa: E402

random.seed(15)
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
M = os.path.join(D, "multi")


def clean(text, lo, hi=260):
    t = " ".join(normalize(text).split())
    w = t.split()
    return " ".join(w[:hi]) if len(w) >= lo else None


rows = []


def add(text, label, group, src, doc):
    if text:
        rows.append({"text": text, "label": label, "group": group, "src": f"{group}-{src}", "doc": doc})


# ---------- GPT-wiki-intro ----------
# The title is cut from the start of both texts ("is a Japanese manga series ..."); put it back on both sides.
wi = pd.read_csv(os.path.join(M, "wikiintro", "GPT-wiki-intro.csv"), usecols=["id", "title", "wiki_intro", "generated_intro"])
idx = list(range(len(wi)))
random.shuffle(idx)
n_h = n_a = 0
for i in idx:
    r = wi.iloc[i]
    if n_h < 1800 and (n_a >= 1200 or random.random() < 0.6):
        t = clean(f"{r.title} {r.wiki_intro}", 120)
        if t:
            add(t, 0, "wikih", "wikipedia", f"wiki-{r.id}"); n_h += 1
    elif n_a < 1200:
        t = clean(f"{r.title} {r.generated_intro}", 90)
        if t:
            add(t, 1, "wikiai", "gpt3-curie", f"wiki-{r.id}"); n_a += 1
    if n_h >= 1800 and n_a >= 1200:
        break

# ---------- HC3 wiki_csai ----------
for i, line in enumerate(open(os.path.join(D, "wiki_csai.jsonl"), encoding="utf-8")):
    r = json.loads(line)
    hum, ai = (r.get("human_answers") or [None])[0], (r.get("chatgpt_answers") or [None])[0]
    if random.random() < 0.6:
        add(clean(hum or "", 90), 0, "wikih", "hc3-wiki_csai", f"hc3wiki-{i}")
    else:
        add(clean(ai or "", 90), 1, "wikiai", "chatgpt", f"hc3wiki-{i}")

# ---------- splits by document, 70/15/15 ----------
docs = sorted({r["doc"] for r in rows})
random.shuffle(docs)
split_of = {d: "test" if i < round(len(docs) * 0.15) else "val" if i < round(len(docs) * 0.30) else "train"
            for i, d in enumerate(docs)}
for r in rows:
    r["split"] = split_of[r["doc"]]

v5 = json.load(open(os.path.join(D, "calset5.json"), encoding="utf-8"))

# keep the external test clean: drop added rows that share an 8-word run with any ext passage
words = lambda t: re.findall(r"[a-z]+", t.lower())  # noqa: E731
ext_grams = set()
for r in v5:
    if r["split"] == "ext":
        w = words(r["text"])
        ext_grams.update(" ".join(w[i:i + 8]) for i in range(max(1, len(w) - 7)))
before = len(rows)
rows = [r for r in rows if not any(" ".join(w[i:i + 8]) in ext_grams
                                   for w in [words(r["text"])] for i in range(max(1, len(w) - 7)))]
print(f"dropped {before - len(rows)} added rows that overlap the ext test")
allrows = v5 + rows
random.shuffle(allrows)
json.dump(allrows, open(os.path.join(D, "calset6.json"), "w", encoding="utf-8"))
print(len(allrows), "passages;", collections.Counter((r["split"], r["label"]) for r in allrows))
print("added:", collections.Counter((r["split"], r["src"]) for r in rows))
