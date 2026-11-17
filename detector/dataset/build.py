"""Training set for detector/finetune.py (dataset v4, 2026-11-11). Inputs in dataset/data/: drafts/ and
calc_drafts/ (first committed versions of picturetolink.com posts and calculator pages, i.e. unedited Claude
drafts: `git show <first commit>:<file>`), HC3 jsonl files (Hello-SimpleAI/HC3), pre-LLM essays (*.html) and
human_web/ (collect_human.py). Writes data/calset4.json.

Dataset v4: every source goes through detect.normalize, passages of 150-260 words, split 70/15/15 by document
within each source group. label 1 = AI, 0 = human."""
import glob, html, json, os, random, re, sys
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
from detect import normalize  # noqa: E402

random.seed(11)
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def passages(text, lo=150, hi=260):
    paras = normalize(text).split("\n")
    out, cur = [], []
    for p in paras:
        cur.append(p)
        words = " ".join(cur).split()
        if len(words) >= lo:
            out.append(" ".join(words[:hi]))
            cur = []
    return out


def strip_html(h):
    h = re.sub(r"(?is)<(script|style|nav|header|footer|aside|form)[^>]*>.*?</\1>", " ", h)
    h = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h\d>", "\n", h)
    return html.unescape(re.sub(r"<[^>]+>", " ", h))


def strip_md(md):
    md = re.sub(r"(?s)^---.*?\n---", "", md)
    md = re.sub(r"(?s)```.*?```", "", md)
    lines = [l for l in md.split("\n") if not l.lstrip().startswith(("|", "!", "<"))]
    return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", "\n".join(lines))


STOP = set("the a an and or of to in is it that for on with as are this be you your by at from can not".split())


def clean_english(text):
    """Skip archive pages that are not real English articles: broken encodings (mojibake) or mostly another
    language (few common English words)."""
    if len(re.findall(r"Ã.|â€", text)) > 2:
        return False
    words = re.findall(r"[a-z']+", text.lower())
    return len(words) > 100 and sum(w in STOP for w in words) / len(words) > 0.18


rows = []
def add(texts, label, group, doc, cap):
    random.shuffle(texts)
    for t in texts[:cap]:
        rows.append({"text": t, "label": label, "src": f"{group}-{os.path.basename(doc)}", "group": group, "doc": doc})

# AI: first drafts of the blog posts and of the calculator pages (Claude, Oct-Nov 2026), ChatGPT answers (HC3)
for p in glob.glob(os.path.join(D, "drafts", "*.md")):
    add(passages(strip_md(open(p, encoding="utf-8").read())), 1, "draft", p, 4)
calc = glob.glob(os.path.join(D, "calc_drafts", "*.md"))
random.shuffle(calc)
for p in calc[:600]:
    add(passages(strip_md(open(p, encoding="utf-8").read())), 1, "calc", p, 1)
for f in ("wiki_csai", "open_qa", "finance"):
    hum, ai = [], []
    for line in open(os.path.join(D, f + ".jsonl"), encoding="utf-8"):
        r = json.loads(line)
        hum += [t for t in r.get("human_answers") or [] if 100 <= len(t.split()) <= 450]
        ai += [t for t in r.get("chatgpt_answers") or [] if 100 <= len(t.split()) <= 450]
    random.shuffle(hum); random.shuffle(ai)
    for i, t in enumerate(ai[:30]):
        add([" ".join(normalize(t).split())], 1, "hc3ai", f"hc3a-{f}-{i}", 1)
    for i, t in enumerate(hum[:45]):
        add([" ".join(normalize(t).split())], 0, "hc3hum", f"hc3h-{f}-{i}", 1)
# Human: pre-2022 web articles on image topics (Wayback), pre-LLM essays
skipped = 0
for sub, group in (("human_web", "web"), ("human_calc", "webcalc")):
    for p in glob.glob(os.path.join(D, sub, "*.txt")):
        body = open(p, encoding="utf-8").read().split("\n", 1)[1]
        if not clean_english(body):
            skipped += 1
            continue
        add(passages(body), 0, group, p, 4)
print("skipped archive pages (not clean English):", skipped)
for p in glob.glob(os.path.join(D, "*.html")):
    add(passages(strip_html(open(p, encoding="utf-8", errors="ignore").read())), 0, "essay", p, 6)

# split by document, per group
by_group = defaultdict(set)
for r in rows:
    by_group[r["group"]].add(r["doc"])
split_of = {}
for g, docs in by_group.items():
    docs = sorted(docs)
    random.shuffle(docs)
    n = len(docs)
    for i, d in enumerate(docs):
        split_of[d] = "test" if i < round(n * 0.15) else "val" if i < round(n * 0.30) else "train"
for r in rows:
    r["split"] = split_of[r["doc"]]
random.shuffle(rows)
json.dump(rows, open(os.path.join(D, "calset4.json"), "w", encoding="utf-8"))
print(len(rows), "passages", Counter(r["label"] for r in rows))
for s in ("train", "val", "test"):
    print(s, Counter((r["group"]) for r in rows if r["split"] == s))
