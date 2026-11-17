"""Score text variants with the detector, for training the human-voice skill.

  detector/.venv-gpu/Scripts/python humanizer/score_variants.py variants.txt [--hot]
The file holds variants separated by lines "=== name". Each variant is scored as one passage (normalised as at
inference). --hot also shows, for each variant, the sentences whose removal lowers the score most.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "detector"))
import detect  # noqa: E402


def main():
    src = open(sys.argv[1], encoding="utf-8").read().replace("\r\n", "\n")
    parts = re.split(r"(?m)^=== (.+)$", src)[1:]
    t = detect.Tuned()
    norm = lambda s: " ".join(detect.normalize(s).split())  # noqa: E731
    for name, body in zip(parts[0::2], parts[1::2]):
        body = body.strip()
        s = t.score(norm(body))
        print(f"{s:5.0%}  {len(body.split()):4d}w  {name.strip()}", flush=True)
        if "--hot" in sys.argv and s >= 0.2:
            sents = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", body))
            drops = []
            for i in range(len(sents)):
                drops.append((s - t.score(norm(" ".join(sents[:i] + sents[i + 1:]))), sents[i]))
            for d, x in sorted(drops, reverse=True)[:3]:
                print(f"         -{d * 100:3.0f}  {x[:110]}")


if __name__ == "__main__":
    main()
