"""Wikipedia-style introductions written by current Claude models, to replace the GPT-3 (2022) side of the Wikipedia
pairs in dataset v6 (owner, 15 Nov 2026: train on latest models' text, not old ones). Uses the local Claude Code CLI
with no tools; resumable: titles already in the output file are skipped.

  python dataset/gen_wiki_claude.py [--limit N]
Writes data/multi/wiki_claude.jsonl: {"id", "title", "model", "text"} per line.
"""
import json
import os
import random
import subprocess
import sys
import time

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "data")
OUT = os.path.join(D, "multi", "wiki_claude.jsonl")
CLAUDE = os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
BATCH = 25

PROMPT = """Write a Wikipedia-style introduction for each title below: the opening section of an encyclopedia article,
180-230 words, plain encyclopedic prose in one to three paragraphs, no headings, lists, markdown or citations. Write
what an encyclopedia would say; if you don't know the subject, write a plausible introduction from the title.
Answer only with a JSON array of objects {"id": <id>, "text": "<introduction>"}, one per title, nothing else.

TITLES
"""


def main():
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    rows = json.load(open(os.path.join(D, "calset6.json"), encoding="utf-8"))
    ids = sorted({int(r["doc"].split("-", 1)[1]) for r in rows if r["src"] == "wikiai-gpt3-curie"})
    wi = pd.read_csv(os.path.join(D, "multi", "wikiintro", "GPT-wiki-intro.csv"), usecols=["id", "title"])
    title = dict(zip(wi.id, wi.title))
    done = set()
    if os.path.exists(OUT):
        done = {json.loads(l)["id"] for l in open(OUT, encoding="utf-8")}
    todo = [i for i in ids if i not in done][:limit]
    print(f"{len(ids)} titles, {len(done)} done, {len(todo)} to write", flush=True)
    random.seed(15)
    for k in range(0, len(todo), BATCH):
        batch = todo[k:k + BATCH]
        model = "sonnet" if (k // BATCH) % 3 == 0 else "haiku"  # one third Sonnet, two thirds Haiku (cost)
        prompt = PROMPT + "\n".join(f'{i}: {title[i]}' for i in batch)
        for attempt in range(3):
            try:
                p = subprocess.run([CLAUDE, "-p", "--model", model, "--tools", "", "--strict-mcp-config",
                                    "--no-session-persistence", "--output-format", "json"],
                                   input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=900)
                res = json.loads(p.stdout)
                txt = res["result"]
                arr = json.loads(txt[txt.index("["):txt.rindex("]") + 1])
                got = {int(a["id"]): a["text"] for a in arr if a.get("text")}
                with open(OUT, "a", encoding="utf-8") as f:
                    for i in batch:
                        if i in got:
                            f.write(json.dumps({"id": i, "title": title[i], "model": f"claude-{model}", "text": got[i]}) + "\n")
                print(f"batch {k // BATCH + 1}: {len(got)}/{len(batch)} ({model}, ${res.get('total_cost_usd', 0):.3f})", flush=True)
                break
            except Exception as e:  # one bad batch must not stop the run
                print(f"batch {k // BATCH + 1} attempt {attempt + 1} failed: {str(e)[:200]}", flush=True)
                time.sleep(10)


if __name__ == "__main__":
    main()
