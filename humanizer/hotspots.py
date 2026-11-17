"""Hotspot finder for the human-voice skill: which sentences make a block read as machine-written.

Scores the whole block with the SEO Auditor's fine-tuned detector, then scores it again with each sentence left out.
The sentences whose removal drops the score most are the ones to rewrite (from the facts, in new words).

  detector/.venv-gpu/Scripts/python humanizer/hotspots.py <file.txt|-> [--top 5]

Feed it one block of 150-260 words (what voice_check.py flags). Shorter text gives noisy scores.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "detector"))
import detect  # noqa: E402


def sentences(text):
    text = re.sub(r"\s+", " ", text).strip()
    return [s for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", text) if s]


def main():
    src = sys.argv[1]
    top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 5
    text = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text).replace("**", "")
    sents = sentences(text)
    tuned = detect.Tuned()
    score = lambda t: tuned.score(" ".join(detect.normalize(t).split()))  # noqa: E731
    base = score(" ".join(sents))
    rows = []
    for i, s in enumerate(sents):
        without = score(" ".join(sents[:i] + sents[i + 1:]))
        rows.append((base - without, i, s))
    print(f"block: {base:.0%} AI, {len(sents)} sentences, {len(text.split())} words\n")
    print("sentences that push the score up most (score drop when removed):")
    for d, i, s in sorted(rows, reverse=True)[:top]:
        print(f"  {d:+.0%}  #{i + 1}: {s[:150]}")
    print("\nsentences that read most human (score rise when removed):")
    for d, i, s in sorted(rows)[:3]:
        print(f"  {d:+.0%}  #{i + 1}: {s[:150]}")


if __name__ == "__main__":
    main()
