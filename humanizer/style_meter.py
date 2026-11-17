"""Style meter for the human-voice skill (owner, 14 Nov 2026: "make the skill so good it never needs training").

Measures a text on the features that separate pre-2022 human web writing from Claude drafts in the SEO Auditor's
detector dataset (detector/dataset/data/calset4.json), and says which ones are off target.

  python humanizer/style_meter.py <file.md|file.txt|->          # report for one text
  python humanizer/style_meter.py --profile                     # recompute and print the human vs Claude profile

Targets are the middle 50% (25th-75th percentile) of human passages, from --profile.
"""
import json
import os
import re
import statistics as st
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "detector", "dataset", "data", "calset4.json")
PROFILE = os.path.join(HERE, "style_profile.json")

HEDGES = {"probably", "maybe", "perhaps", "might", "just", "really", "pretty", "quite", "actually", "basically",
          "honestly", "usually", "often", "fairly", "simply", "generally", "though", "although", "anyway", "still"}
FIRST = {"i", "i'm", "i've", "i'd", "i'll", "me", "my", "we", "we've", "we're", "we'd", "our", "us"}
SECOND = {"you", "you're", "your", "you'll", "you've", "you'd", "yours"}
CONJ_START = {"and", "but", "so", "or", "because", "though"}
AI_START = {"a", "for", "how", "to", "our", "that", "each", "every", "when", "use", "pick", "choose", "check", "open"}


def sentences(text):
    text = re.sub(r"\s+", " ", re.sub(r"[*_`#>]", "", text)).strip()
    return [s for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", text) if len(s.split()) > 1]


def features(text):
    sents = sentences(text)
    words = re.findall(r"[A-Za-z']+", text.lower())
    n = max(1, len(words))
    lens = [len(s.split()) for s in sents] or [0]
    per1k = lambda c: 1000 * c / n  # noqa: E731
    first_words = [re.sub(r"[^a-z']", "", s.split()[0].lower()) for s in sents if s.split()]
    paras = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    return {
        "sentence_mean": st.mean(lens),
        "sentence_sd": st.pstdev(lens) if len(lens) > 1 else 0.0,
        "short_share": 100 * sum(l <= 6 for l in lens) / len(lens),
        "long_share": 100 * sum(l >= 30 for l in lens) / len(lens),
        "contractions": per1k(sum("'" in w for w in words)),
        "first_person": per1k(sum(w in FIRST for w in words)),
        "second_person": per1k(sum(w in SECOND for w in words)),
        "hedges": per1k(sum(w in HEDGES for w in words)),
        "colons": per1k(text.count(":")),
        "semicolons": per1k(text.count(";")),
        "brackets": per1k(text.count("(")),
        "or_rate": per1k(sum(w == "or" for w in words)),
        "so_rate": per1k(sum(w == "so" for w in words)),
        "conj_start": 100 * sum(w in CONJ_START for w in first_words) / max(1, len(first_words)),
        "ai_start": 100 * sum(w in AI_START for w in first_words) / max(1, len(first_words)),
    }


LABELS = {
    "sentence_mean": "average sentence length (words)",
    "sentence_sd": "spread of sentence lengths",
    "short_share": "% very short sentences (<=6 words)",
    "long_share": "% long sentences (>=30 words)",
    "contractions": "contractions per 1000 words (it's, you'd)",
    "first_person": "I / we / my / our per 1000 words",
    "second_person": "you / your per 1000 words",
    "hedges": "hedges per 1000 (probably, just, really, though)",
    "colons": "colons per 1000 words",
    "semicolons": "semicolons per 1000 words",
    "brackets": "brackets per 1000 words",
    "or_rate": "'or' per 1000 words",
    "so_rate": "'so' per 1000 words",
    "conj_start": "% sentences opening with And/But/So/Because",
    "ai_start": "% sentences opening with A/For/How/To/Our/That/Each/Use...",
}


def build_profile():
    rows = json.load(open(DATA, encoding="utf-8"))
    groups = {"human": [r["text"] for r in rows if r["group"] in ("web", "webcalc", "essay", "hc3hum")],
              "claude": [r["text"] for r in rows if r["group"] in ("draft", "calc")]}
    out = {}
    for g, texts in groups.items():
        fs = [features(t) for t in texts if len(t.split()) >= 120]
        out[g] = {}
        for k in LABELS:
            vals = sorted(f[k] for f in fs)
            q = lambda p: vals[int(p * (len(vals) - 1))]  # noqa: E731
            out[g][k] = {"p25": round(q(0.25), 1), "median": round(q(0.5), 1), "p75": round(q(0.75), 1)}
    json.dump(out, open(PROFILE, "w"), indent=1)
    return out


def main():
    if "--profile" in sys.argv:
        p = build_profile()
        print(f"{'feature':52s} {'human p25-p75 (median)':>26s} {'claude median':>14s}")
        for k, lab in LABELS.items():
            h, c = p["human"][k], p["claude"][k]
            print(f"{lab:52s} {h['p25']:>8} - {h['p75']:<6} ({h['median']:>5}) {c['median']:>12}")
        return
    src = sys.argv[1]
    text = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    text = re.sub(r"(?s)^---.*?\n---\n", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    prof = json.load(open(PROFILE)) if os.path.exists(PROFILE) else build_profile()
    f = features(text)
    off = 0
    for k, lab in LABELS.items():
        h, c = prof["human"][k], prof["claude"][k]
        v = f[k]
        ok = h["p25"] <= v <= h["p75"]
        toward_claude = abs(v - c["median"]) < abs(v - h["median"])
        flag = "ok " if ok else ("FIX" if toward_claude else "~  ")
        off += flag == "FIX"
        print(f"{flag} {lab:52s} {v:6.1f}   human {h['p25']}-{h['p75']}   claude ~{c['median']}")
    print(f"\n{off} feature(s) sit on the Claude side of the line.")


if __name__ == "__main__":
    main()
