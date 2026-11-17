"""Per-paragraph check for the human-voice skill: AI likelihood of every prose paragraph (the SEO Auditor's
fine-tuned detector) plus the style meter for the whole text. This is the feedback loop: rewrite the paragraphs
marked REWRITE, run it again, stop when every paragraph is under 20%.

  detector/.venv-gpu/Scripts/python humanizer/voice_check.py <page.md|text.txt>     (GPU venv: fast)
  python humanizer/voice_check.py <file>                                             (CPU: slower)

Headings, lists, tables, images, code and front matter are skipped; links count as their anchor text.
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "detector"))
import detect  # noqa: E402

LIMIT = 0.20


def paragraphs(md):
    md = re.sub(r"(?s)^---\n.*?\n---\n", "", md.replace("\r\n", "\n"))
    md = re.sub(r"(?s)```.*?```", "", md)
    out = []
    for p in re.split(r"\n\s*\n", md):
        s = p.strip()
        if not s or re.match(r"^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||!\[|<|>)", s):
            continue
        s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s).replace("**", "")
        if len(s.split()) >= 8:
            out.append(s)
    return out


def main():
    src = sys.argv[1]
    text = open(src, encoding="utf-8").read()
    paras = paragraphs(text)
    tuned = detect.Tuned()
    flagged = 0
    total_w = sum(len(p.split()) for p in paras) or 1
    weighted = 0.0
    blocks = blocks_of(paras)
    print(f"{'paras':>7} {'AI':>5} {'words':>5}  starts with")
    for b in blocks:
        txt = " ".join(p for _, p in b)
        ai = tuned.score(" ".join(detect.normalize(txt).split()))
        w = len(txt.split())
        weighted += ai * w
        flagged += ai >= LIMIT
        ids = f"{b[0][0]}-{b[-1][0]}" if len(b) > 1 else str(b[0][0])
        print(f"{ids:>7} {ai:5.0%} {w:>5}  {txt[:80]}{'...' if len(txt) > 80 else ''}  {'REWRITE' if ai >= LIMIT else ''}")
    print(f"\npage (word-weighted): {weighted / total_w:.0%} AI; {flagged} of {len(blocks)} blocks to rewrite (limit {LIMIT:.0%})")
    print("paragraph numbers:")
    for i, p in enumerate(paras, 1):
        print(f"  {i:>2}. {p[:70]}...")
    print()
    sys.stdout.flush()
    subprocess.run([sys.executable, os.path.join(HERE, "style_meter.py"), src])


def blocks_of(paras, lo=150):
    """Consecutive paragraphs packed into blocks of at least ~150 words, the passage size the detector was trained on
    (150-260 words). A single short paragraph gives an unreliable score, so it is judged with its neighbours."""
    out, cur = [], []
    for i, p in enumerate(paras, 1):
        cur.append((i, p))
        if sum(len(x.split()) for _, x in cur) >= lo:
            out.append(cur)
            cur = []
    if cur:
        # A leftover under 150 words gives a noisy score (24% and 35% for two near-identical 110-word endings),
        # so it is judged together with the block before it.
        if out and sum(len(x.split()) for _, x in cur) < lo:
            out[-1] += cur
        else:
            out.append(cur)
    return out


if __name__ == "__main__":
    main()
