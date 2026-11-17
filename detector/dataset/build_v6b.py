"""Dataset v6b (2026-11-15): dataset v6 with the AI side of the Wikipedia pairs written by current Claude models
(Sonnet and Haiku, gen_wiki_claude.py) instead of GPT-3 (2022) and 2022 ChatGPT. The owner pointed out that training on
old models' text was wrong; v4 and v4b, trained with the GPT-3 side, learned to flag the encyclopedic style itself.
Rows keep their document and split; GPT-3 rows without a Claude intro and the HC3 ChatGPT Wikipedia rows are dropped.
Writes data/calset6b.json.
"""
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
from detect import normalize  # noqa: E402

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
claude = {}
for line in open(os.path.join(D, "multi", "wiki_claude.jsonl"), encoding="utf-8"):
    r = json.loads(line)
    claude[r["id"]] = r

rows = json.load(open(os.path.join(D, "calset6.json"), encoding="utf-8"))
out, dropped = [], collections.Counter()
for r in rows:
    if r["src"] == "wikiai-chatgpt":
        dropped["hc3 chatgpt (2022)"] += 1
        continue
    if r["src"] == "wikiai-gpt3-curie":
        c = claude.get(int(r["doc"].split("-", 1)[1]))
        words = " ".join(normalize(c["text"]).split()).split() if c else []
        if len(words) < 90:
            dropped["gpt3 without a claude intro"] += 1
            continue
        r = {**r, "text": " ".join(words[:260]), "src": f"wikiai-{c['model']}"}
    out.append(r)
json.dump(out, open(os.path.join(D, "calset6b.json"), "w", encoding="utf-8"))
print(len(out), "passages; dropped", dict(dropped))
print(collections.Counter((r["split"], r["src"]) for r in out if r["group"] in ("wikih", "wikiai")))
