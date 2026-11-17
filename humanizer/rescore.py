"""Score many files' 150+ word blocks with one detector load (same blocks as voice_check.py). Used on 15 Nov 2026 to
re-check the human-voice skill's training rewrites against detector v3 (23 models).

  detector/.venv-gpu/Scripts/python humanizer/rescore.py <file> [...] [--weights detector/finetuned-v2/trainable.safetensors]
Prints one line per file: page score (word-weighted) and every block's score.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "detector"))
sys.path.insert(0, HERE)
import detect  # noqa: E402
from voice_check import paragraphs, blocks_of  # noqa: E402


def main():
    args = sys.argv[1:]
    if "--weights" in args:
        i = args.index("--weights")
        detect.TUNED_WEIGHTS = os.path.abspath(args[i + 1])
        args = args[:i] + args[i + 2:]
    tuned = detect.Tuned()
    for f in args:
        paras = paragraphs(open(f, encoding="utf-8").read())
        blocks = blocks_of(paras)
        scores, words = [], []
        for b in blocks:
            txt = " ".join(p for _, p in b)
            scores.append(tuned.score(" ".join(detect.normalize(txt).split())))
            words.append(len(txt.split()))
        page = sum(s * w for s, w in zip(scores, words)) / max(1, sum(words))
        print(f"{os.path.basename(f):32s} page {page:4.0%}  blocks " + " ".join(f"{s:.0%}" for s in scores), flush=True)


if __name__ == "__main__":
    main()
