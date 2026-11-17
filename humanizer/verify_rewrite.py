"""Fact check for a human-voice rewrite of a Markdown page (owner, 14 Nov 2026: "full verification ka sath").
Compares the rewrite with the original and fails if anything that must not change did change.

  python humanizer/verify_rewrite.py <original.md> <rewrite.md> [--allow-missing-number 2026 ...]
  python humanizer/verify_rewrite.py --git <post.md>    (original = the committed version, rewrite = working copy)

Fails (exit 1) on:
  - front matter changed (any key)
  - a link target dropped or added (internal and external)
  - an image dropped or its alt text changed
  - a table or code block changed (numbers in tables are facts)
  - a number, size, price or percentage from the original missing in the rewrite
  - an inline code span (`/image`, `.jpg`) missing
  - a bold UI label (**Upload**) missing
Warns on: headings changed, length outside 80-130% of the original, primaryKeyword used less often.
It checks facts that can be found mechanically. Meaning still has to be read: the report lists every sentence of the
original that holds a number, so they can be compared with the rewrite by eye.
"""
import re
import subprocess
import sys


def split_fm(md):
    md = md.replace("\r\n", "\n")
    m = re.match(r"(?s)^---\n(.*?)\n---\n", md)
    return (m.group(1), md[m.end():]) if m else ("", md)


def fm_dict(fm):
    return dict(re.findall(r"(?m)^([A-Za-z_]+):\s*(.*)$", fm))


def blocks(body, kind):
    if kind == "code":
        return re.findall(r"(?s)```.*?```", body)
    if kind == "table":
        out, cur = [], []
        for line in body.split("\n"):
            if line.lstrip().startswith("|"):
                cur.append(line.strip())
            elif cur:
                out.append("\n".join(cur)); cur = []
        if cur:
            out.append("\n".join(cur))
        return out
    return []


def prose(body):
    body = re.sub(r"(?s)```.*?```", " ", body)
    return "\n".join(l for l in body.split("\n") if not l.lstrip().startswith("|"))


NUM = re.compile(r"(?<![\w.])(?:[$£€₹]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|px|kb|mb|gb|tb|mp|dpi|ppi|x\d+|×\d+|k\b|m\b))?", re.I)


def numbers(text):
    text = re.sub(r"\]\([^)]*\)", "]", text)  # not the digits inside link URLs
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    out = []
    for n in NUM.findall(text):
        n = re.sub(r"\s+", "", n.lower()).replace(",", "")
        out.append(n)
    return out


def links(text):
    return re.findall(r"(?<!!)\[[^\]]*\]\(([^)\s]+)", text)


def images(text):
    return re.findall(r"!\[([^\]]*)\]\(([^)\s]+)", text)


def headings(text):
    return re.findall(r"(?m)^(#{2,4})\s+(.+?)\s*$", text)


def multiset_missing(a, b):
    from collections import Counter
    ca, cb = Counter(a), Counter(b)
    return sorted((k for k in ca if cb[k] < ca[k]), key=str)


def main():
    args = sys.argv[1:]
    allow = set()
    if "--allow-missing-number" in args:
        i = args.index("--allow-missing-number")
        allow = set(a.lower() for a in args[i + 1:])
        args = args[:i]
    if args[0] == "--git":
        path = args[1]
        orig = subprocess.run(["git", "show", f"HEAD:./{path}"], capture_output=True, text=True, encoding="utf-8",
                              cwd=None).stdout
        new = open(path, encoding="utf-8").read()
        if not orig:
            raise SystemExit(f"no committed version of {path}")
    else:
        orig, new = (open(p, encoding="utf-8").read() for p in args[:2])
    fo, bo = split_fm(orig)
    fn, bn = split_fm(new)
    fail, warn = [], []

    if fo.strip() != fn.strip():
        do, dn = fm_dict(fo), fm_dict(fn)
        for k in sorted(set(do) | set(dn)):
            if do.get(k) != dn.get(k):
                fail.append(f"front matter `{k}`: {do.get(k)!r} -> {dn.get(k)!r}")
    lo, ln = links(bo), links(bn)
    for u in multiset_missing(lo, ln):
        fail.append(f"link dropped: {u}")
    for u in sorted(set(ln) - set(lo)):
        fail.append(f"link added: {u}")
    io, in_ = images(bo), images(bn)
    for alt, src in io:
        if (alt, src) not in in_:
            fail.append(f"image dropped or alt changed: {src} ({alt!r})")
    for kind in ("table", "code"):
        bo_k, bn_k = blocks(bo, kind), blocks(bn, kind)
        for b in bo_k:
            if b not in bn_k:
                fail.append(f"{kind} changed or dropped:\n      " + b.split("\n")[0][:100] + " ...")
        for b in bn_k:
            if b not in bo_k:
                fail.append(f"{kind} added:\n      " + b.split("\n")[0][:100] + " ...")
    po, pn = prose(bo), prose(bn)
    miss = [n for n in multiset_missing(numbers(po), numbers(pn)) if n not in allow]
    for n in miss:
        fail.append(f"number missing in the prose: {n}")
    for c in multiset_missing(re.findall(r"`([^`\n]+)`", po), re.findall(r"`([^`\n]+)`", pn)):
        fail.append(f"code span missing: `{c}`")
    for b in sorted(set(re.findall(r"\*\*([^*\n]+)\*\*", po)) - set(re.findall(r"\*\*([^*\n]+)\*\*", pn))):
        fail.append(f"bold label missing: **{b}**")

    ho, hn = headings(bo), headings(bn)
    if ho != hn:
        for h in ho:
            if h not in hn:
                warn.append(f"heading changed or dropped: {h[0]} {h[1]}")
    wo, wn = len(po.split()), len(pn.split())
    if not 0.8 <= wn / max(1, wo) <= 1.3:
        warn.append(f"length {wn} words vs {wo} in the original ({wn / max(1, wo):.0%})")
    kw = fm_dict(fo).get("primaryKeyword", "").strip().strip('"').lower()
    if kw:
        ko, kn = po.lower().count(kw), pn.lower().count(kw)
        if kn < ko:
            warn.append(f"primaryKeyword '{kw}' used {kn}x, original {ko}x")

    print(f"verify_rewrite: {len(fail)} failure(s), {len(warn)} warning(s); {wo} -> {wn} words; "
          f"{len(lo)} links, {len(io)} images, {len(blocks(bo, 'table'))} tables, {len(numbers(po))} numbers checked")
    for f in fail:
        print("  FAIL", f)
    for w in warn:
        print("  warn", w)
    print("\nSentences of the original with numbers (compare their meaning with the rewrite):")
    for s in re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", re.sub(r"(?m)^#+.*$", "", po))):
        if NUM.search(re.sub(r"\]\([^)]*\)", "]", s)):
            print("  -", s.strip()[:200])
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
