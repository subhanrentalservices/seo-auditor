"""AI-text detector for the SEO Auditor (owner asked 2026-11-11 for a GPTZero-style check), run locally.

Default signal, "tuned": desklib/ai-text-detector-v1.01 (DeBERTa-v3-large, RAID leaderboard #1 when published, MIT)
with its top 6 layers fine-tuned by finetune.py on dataset/ (unedited Claude drafts of blog posts and calculator
pages, ChatGPT answers, pre-2022 human web articles on image and calculator topics, pre-LLM essays). Held-out test,
481 passages from documents it never saw (finetuned/meta.json): AUC 1.000, accuracy 100%, no human passage flagged.
The published model on the same test: AUC 0.33 (it misses Claude's factual how-to writing).

Optional research signals (pass "signals"): "desklib" (published model), "fakespot" (Mozilla Fakespot RoBERTa,
Apache-2.0) and "binoculars" (Hans et al. 2024, Qwen2.5 base vs instruct). On this site's writing Binoculars scored
Claude drafts as *more* human than human text (AUC 0.20-0.34) and needs ~4-14 GB RAM, so it is off by default.

Long texts are normalised (normalize), split into chunks of about CHUNK_WORDS words on paragraph boundaries, and
each chunk is scored; the page score is the word-weighted mean, so the report shows which paragraphs read as
machine-written.

Input (stdin, JSON): {"texts": ["...", ...], "signals": ["tuned"], "whole": false}
Output (stdout, JSON): {"results": [{"ai": 0.0-1.0, "words": n, "signals": {...}, "chunks": [...]}, ...]}
No check can prove who wrote a text. It measures how close the writing is to the machine text it was trained on.
"""
import json
import os
import re
import sys

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
import torch  # noqa: E402
import torch.nn as nn  # noqa: E402
from transformers import AutoConfig, AutoModel, AutoModelForCausalLM, AutoModelForSequenceClassification, AutoTokenizer  # noqa: E402

torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
HERE = os.path.dirname(os.path.abspath(__file__))
CHUNK_WORDS = 220
MIN_WORDS = 40
BIN_MAX_TOKENS = 512


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------- normalising ----------
BRANDS = re.compile(r"\b(picture\s?to\s?link(\.com)?|ss automotive( group)?)\b", re.I)


def normalize(text):
    """One cleaning step for every source, in training and at inference, so the models judge the writing and not
    how the text was extracted (Markdown, a web page, plain text): list markers, Markdown emphasis and heading
    marks go, curly quotes become straight, and lines under 6 words (headings, menu items, list fragments) are
    dropped. Paragraphs stay one per line. Brand names of the sites whose drafts are in the training set are replaced
    with "Brand", so the model can't call a page AI just because it names the brand."""
    out = []
    text = re.sub("[\ud800-\udfff]", "", str(text or ""))  # lone surrogates (a split emoji) break the tokenizer
    for line in text.replace("\r", "").split("\n"):
        line = BRANDS.sub("Brand", line)
        line = re.sub(r"^\s*(?:[-*+•▪◦]|\d+[.)]|#{1,6})\s+", "", line)
        line = re.sub(r"(\*\*|__|`)", "", line)
        line = line.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace(" ", " ")
        line = re.sub(r"\s+", " ", line).strip()
        if len(line.split()) >= 6:
            out.append(line)
    return "\n".join(out)


# ---------- chunking ----------
def chunks_of(text):
    """Normalise, then pack paragraphs into ~CHUNK_WORDS-word chunks."""
    paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n|\n", normalize(text))]
    paras = [p for p in paras if p]
    out, cur, n = [], [], 0
    for p in paras:
        w = len(p.split())
        if cur and n + w > CHUNK_WORDS * 1.3:
            out.append(" ".join(cur))
            cur, n = [], 0
        if w > CHUNK_WORDS * 1.6:  # one huge paragraph: split by sentences
            sents = re.split(r"(?<=[.!?])\s+", p)
            buf, bn = [], 0
            for s in sents:
                sw = len(s.split())
                if buf and bn + sw > CHUNK_WORDS:
                    out.append(" ".join(buf))
                    buf, bn = [], 0
                buf.append(s)
                bn += sw
            if buf:
                cur, n = buf, bn
            continue
        cur.append(p)
        n += w
        if n >= CHUNK_WORDS:
            out.append(" ".join(cur))
            cur, n = [], 0
    if cur:
        if out and n < MIN_WORDS:
            out[-1] = out[-1] + " " + " ".join(cur)
        else:
            out.append(" ".join(cur))
    return out


# ---------- Binoculars ----------
class Binoculars:
    def __init__(self, size="0.5B"):
        base, inst = f"Qwen/Qwen2.5-{size}", f"Qwen/Qwen2.5-{size}-Instruct"
        log(f"loading {base} + {inst}")
        self.tok = AutoTokenizer.from_pretrained(base)
        self.observer = AutoModelForCausalLM.from_pretrained(base, dtype=torch.float32).eval()
        self.performer = AutoModelForCausalLM.from_pretrained(inst, dtype=torch.float32).eval()

    @torch.no_grad()
    def score(self, text):
        ids = self.tok(text, return_tensors="pt", truncation=True, max_length=BIN_MAX_TOKENS).input_ids
        if ids.shape[1] < 8:
            return None
        o = self.observer(ids).logits[0, :-1].float()
        p = self.performer(ids).logits[0, :-1].float()
        target = ids[0, 1:]
        # log-perplexity of the text under the performer
        nll = torch.nn.functional.cross_entropy(p, target, reduction="none")
        # cross-perplexity: observer's distribution scored by the performer's log-probs
        xent = -(torch.softmax(o, -1) * torch.log_softmax(p, -1)).sum(-1)
        return float(nll.mean() / xent.mean())


# ---------- classifiers ----------
class DesklibModel(nn.Module):
    """DeBERTa encoder + mean pooling + one-logit head (the model card's class, as a plain module: its
    PreTrainedModel subclass doesn't load under transformers 5, so the weights are read from safetensors directly)."""

    def __init__(self, config):
        super().__init__()
        self.model = AutoModel.from_config(config)
        self.classifier = nn.Linear(config.hidden_size, 1)

    @classmethod
    def load(cls, name):
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file
        m = cls(AutoConfig.from_pretrained(name))
        missing, unexpected = m.load_state_dict(load_file(hf_hub_download(name, "model.safetensors")), strict=False)
        missing = [k for k in missing if "position_ids" not in k]
        if missing:
            raise RuntimeError(f"desklib weights missing: {missing[:5]}")
        return m

    def forward(self, input_ids, attention_mask=None):
        h = self.model(input_ids, attention_mask=attention_mask)[0]
        m = attention_mask.unsqueeze(-1).float()
        pooled = (h * m).sum(1) / m.sum(1).clamp(min=1e-9)
        return self.classifier(pooled), pooled


def mask_years(text):
    """Years are replaced so the in-domain head can't learn "2026 = AI draft, 2019 = human" from dates alone."""
    return re.sub(r"\b(19|20)\d\d\b", "2020", text)


class Desklib:
    def __init__(self):
        name = "desklib/ai-text-detector-v1.01"
        log(f"loading {name}")
        self.tok = AutoTokenizer.from_pretrained(name)
        self.model = DesklibModel.load(name).eval()
        self.last_embedding = None

    @torch.no_grad()
    def score(self, text):
        """The published model's probability (year-masked text, like the fine-tuned one)."""
        enc = self.tok(mask_years(text), truncation=True, max_length=768, return_tensors="pt")
        logit, pooled = self.model(enc["input_ids"], enc["attention_mask"])
        self.last_embedding = pooled[0].tolist()
        return float(torch.sigmoid(logit).item())


TUNED_WEIGHTS = os.path.join(HERE, "finetuned", "trainable.safetensors")


class Tuned:
    """desklib with the layers trained by finetune.py loaded over it (finetuned/trainable.safetensors)."""

    def __init__(self):
        if not os.path.exists(TUNED_WEIGHTS):
            raise SystemExit("detector/finetuned/trainable.safetensors is missing: run detector/dataset/build.py, then "
                             "detector/finetune.py data/calset3.json (see detector/README.md)")
        from safetensors.torch import load_file
        name = "desklib/ai-text-detector-v1.01"
        log(f"loading {name} + fine-tuned layers")
        self.tok = AutoTokenizer.from_pretrained(name)
        self.model = DesklibModel.load(name)
        self.model.load_state_dict(load_file(TUNED_WEIGHTS), strict=False)
        # DETECT_DEVICE=cpu keeps the GPU free (the humanizer's llama-server uses it)
        self.device = torch.device(os.environ.get("DETECT_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.model.to(self.device).eval()

    @torch.no_grad()
    def score(self, text):
        enc = self.tok(mask_years(text), truncation=True, max_length=512, return_tensors="pt").to(self.device)
        logit, _ = self.model(enc["input_ids"], enc["attention_mask"])
        return float(torch.sigmoid(logit).item())


class Fakespot:
    def __init__(self):
        name = "fakespot-ai/roberta-base-ai-text-detection-v1"
        log(f"loading {name}")
        self.tok = AutoTokenizer.from_pretrained(name)
        self.model = AutoModelForSequenceClassification.from_pretrained(name).eval()
        labels = {v.lower(): int(k) for k, v in self.model.config.id2label.items()}
        self.ai_idx = next((i for l, i in labels.items() if "ai" in l or "machine" in l or "generated" in l or l == "label_1"), 1)

    @torch.no_grad()
    def score(self, text):
        enc = self.tok(text, truncation=True, max_length=512, return_tensors="pt")
        return float(torch.softmax(self.model(**enc).logits[0], -1)[self.ai_idx].item())


# ---------- running ----------
def ai_of(sig):
    """The chunk's AI probability: the fine-tuned model when it ran, else the mean of the published classifiers."""
    if sig.get("tuned") is not None:
        return sig["tuned"]
    vals = [sig[k] for k in ("desklib", "fakespot") if sig.get(k) is not None]
    return sum(vals) / len(vals) if vals else None


def main():
    # Node writes UTF-8. On Windows sys.stdin decodes with the locale code page (cp1252), which turned every
    # non-ASCII character ("·", curly quotes, dashes) into mojibake such as "Â·" before the model saw it.
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    texts = req.get("texts") or []
    want = set(req.get("signals") or ["tuned"])
    det = {}
    if "tuned" in want:
        det["tuned"] = Tuned()
    if "desklib" in want:
        det["desklib"] = Desklib()
    if "fakespot" in want:
        det["fakespot"] = Fakespot()
    if "binoculars" in want:
        det["binoculars"] = Binoculars(req.get("model") or "0.5B")
    results = []
    for i, text in enumerate(texts):
        chunks = chunks_of(text) if not req.get("whole") else [re.sub(r"\s+", " ", normalize(text)).strip()]
        chunks = [c for c in chunks if c]
        rows = []
        for c in chunks:
            sig = {}
            for k, d in det.items():
                try:
                    sig[k] = d.score(c)
                except Exception as e:  # one bad block must not stop a site scan
                    log(f"text {i + 1}: {k} failed on a block: {e}")
                    sig[k] = None
            rows.append({"text": c, "words": len(c.split()), "signals": sig, "ai": ai_of(sig)})
        tw = sum(r["words"] for r in rows)
        page = {k: sum(r["signals"][k] * r["words"] for r in rows if r["signals"].get(k) is not None) / (tw or 1) for k in det}
        scored = [(r["ai"], r["words"]) for r in rows if r["ai"] is not None]
        ai = sum(a * w for a, w in scored) / sum(w for _, w in scored) if scored else None
        results.append({"ai": ai, "words": tw, "signals": page, "chunks": rows})
        log(f"{i + 1}/{len(texts)} done")
    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
