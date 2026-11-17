"""Score a dataset split with the fine-tuned detector and report, per source, how many passages are flagged (>= 50%).
For AI sources that is the catch rate, for human sources the false-alarm rate.

  .venv-gpu/Scripts/python eval.py dataset/data/calset5.json [--splits test,ext] [--weights finetuned/trainable.safetensors] [--out file.json] [--scores rows.json]
"""
import json
import os
import sys
from collections import defaultdict

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import detect  # noqa: E402
from finetune import auc  # noqa: E402


MULTI = {"hapeh", "hapeai", "eli5h", "eli5ai", "arxivh", "arxivai", "tsh", "tsai", "aitaai"}


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    rows = json.load(open(sys.argv[1], encoding="utf-8"))
    splits = arg("--splits", "test,ext").split(",")
    weights = arg("--weights", None)
    if weights:
        detect.TUNED_WEIGHTS = os.path.abspath(weights)
    t = detect.Tuned()
    rows = [r for r in rows if r["split"] in splits]
    scores = []
    with torch.no_grad():
        for i in range(0, len(rows), 8):
            enc = t.tok([detect.mask_years(r["text"]) for r in rows[i:i + 8]], truncation=True, max_length=512,
                        padding=True, return_tensors="pt").to(t.device)
            logit, _ = t.model(enc["input_ids"], enc["attention_mask"])
            scores += torch.sigmoid(logit[:, 0]).tolist()
            if i % 400 == 0:
                detect.log(f"{i}/{len(rows)}")
    out = {}
    for s in splits:
        idx = [i for i, r in enumerate(rows) if r["split"] == s]
        p = np.array([scores[i] for i in idx]); y = np.array([rows[i]["label"] for i in idx])
        print(f"\n== {s}: n={len(idx)}  AUC {auc(list(p), list(y)):.3f}  accuracy {((p >= .5) == y).mean():.1%}  "
              f"human flagged {((p >= .5) & (y == 0)).sum() / max(1, (y == 0).sum()):.1%}  "
              f"AI caught {((p >= .5) & (y == 1)).sum() / max(1, (y == 1).sum()):.1%}")
        by = defaultdict(list)
        for i in idx:
            r = rows[i]
            # per model for the multi-model sources, per group for the per-file v4 sources
            key = r["src"] if r["group"] in MULTI else r["group"]
            by[(r["label"], key)].append(scores[i])
        for (lab, src), v in sorted(by.items()):
            v = np.array(v)
            print(f"  {'AI ' if lab else 'HUM'} {src:42s} n={len(v):4d}  flagged {(v >= .5).mean():5.0%}  mean {v.mean():.2f}")
            out[f"{s}|{lab}|{src}"] = {"n": len(v), "flagged": float((v >= .5).mean()), "mean": float(v.mean())}
    if "--out" in sys.argv:
        json.dump(out, open(arg("--out", ""), "w"), indent=1)
    if "--scores" in sys.argv:  # per-passage scores, for threshold and error analysis
        json.dump([{"split": r["split"], "label": r["label"], "src": r["src"], "doc": r["doc"], "score": sc, "text": r["text"]}
                   for r, sc in zip(rows, scores)], open(arg("--scores", ""), "w", encoding="utf-8"))


if __name__ == "__main__":
    main()
