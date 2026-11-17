"""Fine-tune the desklib DeBERTa-v3-large detector on in-domain data (owner asked 2026-11-11 for "proper training").

Usage: python detector/finetune.py <dataset.json> [--layers 6] [--epochs 3] [--maxlen 512] [--lr 1e-5]
         [--init finetuned/trainable.safetensors] [--select auc|fp2] [--human-weight 1.0]
  --init: start from earlier fine-tuned layers instead of the published model (epoch 0 is then that model).
  --select fp2: keep the epoch with the best 1 - (2 * human flagged + AI missed) / 3 at the 0.5 line, i.e. false
    alarms on human text count double (owner: human false positives near 0%). Default auc.
  --human-weight: multiply the loss on human passages.
  --save-last DIR: also save every epoch's layers to DIR (kept even when the epoch isn't the best), for analysis.
Validation results are logged per group after every epoch (human groups: share flagged; AI groups: share caught).
Dataset rows: {"text", "label": 1 AI | 0 human, "doc", "split": "train" | "val" | "test", "src"}.
  - Starts from desklib/ai-text-detector-v1.01 (RAID leaderboard #1 when published), which already knows general
    machine text; only the top --layers encoder layers and the head are trained, so it runs on a laptop CPU.
  - Splits are by document, so validation and test passages come from articles the model never saw.
  - After each epoch it scores the validation split and keeps the best epoch (by AUC).
  - Saves detector/finetuned/trainable.safetensors (the trained layers only) + finetuned/meta.json (metrics).
Years are masked the same way as at inference (detect.mask_years).
"""
import json
import math
import os
import random
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "finetuned")


def arg(name, default, cast=str):
    return cast(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def auc(scores, labels):
    pos = np.array([s for s, l in zip(scores, labels) if l == 1])
    neg = np.array([s for s, l in zip(scores, labels) if l == 0])
    if not len(pos) or not len(neg):
        return float("nan")
    return float(((pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()) / (len(pos) * len(neg)))


DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


@torch.no_grad()
def predict(model, tok, texts, maxlen, bs=8):
    model.eval()
    out = []
    for i in range(0, len(texts), bs):
        enc = tok([detect.mask_years(t) for t in texts[i:i + bs]], truncation=True, max_length=maxlen, padding=True, return_tensors="pt").to(DEVICE)
        logit, _ = model(enc["input_ids"], enc["attention_mask"])
        out += torch.sigmoid(logit[:, 0]).tolist()
    return out


def report(name, p, y, srcs):
    p, y = np.array(p), np.array(y)
    acc = ((p >= 0.5) == y).mean()
    fp = ((p >= 0.5) & (y == 0)).sum() / max(1, (y == 0).sum())
    fn = ((p < 0.5) & (y == 1)).sum() / max(1, (y == 1).sum())
    line = f"{name}: AUC {auc(list(p), list(y)):.3f}  accuracy {acc:.1%}  human flagged {fp:.1%}  AI missed {fn:.1%}  (n={len(y)})"
    groups = {}
    for pi, s in zip(p, srcs):
        groups.setdefault(s, []).append(pi)
    detail = {g: {"n": len(v), "flagged": float(np.mean(np.array(v) >= 0.5)), "mean": float(np.mean(v))} for g, v in sorted(groups.items())}
    return line, {"auc": auc(list(p), list(y)), "accuracy": float(acc), "false_positive": float(fp), "false_negative": float(fn), "n": int(len(y)), "groups": detail}


def group_of(src):
    return src.rsplit("-", 1)[0] if src.startswith("hc3") else src.split("-")[0]


def main():
    path = sys.argv[1]
    n_layers = arg("--layers", 6, int)
    epochs = arg("--epochs", 3, int)
    maxlen = arg("--maxlen", 512, int)
    lr = arg("--lr", 1e-5, float)
    init = arg("--init", None)
    select = arg("--select", "auc")
    human_w = arg("--human-weight", 1.0, float)
    bs = arg("--bs", 2 if DEVICE.type == "cuda" else 4, int)
    accum = 16 // bs
    torch.manual_seed(0)
    random.seed(0)
    rows = json.load(open(path, encoding="utf-8"))
    tr = [r for r in rows if r["split"] == "train"]
    va = [r for r in rows if r["split"] == "val"]
    te = [r for r in rows if r["split"] == "test"]
    detect.log(f"train {len(tr)}  val {len(va)}  test {len(te)}  layers {n_layers}  epochs {epochs}  maxlen {maxlen}")

    d = detect.Desklib()
    model, tok = d.model.to(DEVICE), d.tok
    if init:
        from safetensors.torch import load_file
        missing = model.load_state_dict(load_file(init), strict=False)
        detect.log(f"started from {init} ({len(missing.unexpected_keys)} unexpected keys)")
    detect.log(f"device: {DEVICE}" + (f" ({torch.cuda.get_device_name(0)})" if DEVICE.type == "cuda" else ""))
    if "--checkpointing" in sys.argv:
        # recompute activations in the backward pass instead of storing them: more layers fit in 4 GB of VRAM
        model.model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    for p in model.parameters():
        p.requires_grad = False
    layers = model.model.encoder.layer
    train_params = []
    for layer in layers[-n_layers:]:
        for p in layer.parameters():
            p.requires_grad = True
            train_params.append(p)
    for p in model.classifier.parameters():
        p.requires_grad = True
    # DeBERTa's relative-position embeddings and final LayerNorm sit outside the layers; keep them frozen.
    trainable_names = [n for n, p in model.named_parameters() if p.requires_grad]
    opt = torch.optim.AdamW([
        {"params": train_params, "lr": lr},
        {"params": list(model.classifier.parameters()), "lr": lr * 10},
    ], weight_decay=0.01)
    pos_w = torch.tensor(float(len(tr) - sum(r["label"] for r in tr)) / max(1, sum(r["label"] for r in tr))).to(DEVICE)
    lossf_el = torch.nn.BCEWithLogitsLoss(pos_weight=pos_w, reduction="none")

    def lossf(logits, y):
        return (lossf_el(logits, y) * torch.where(y == 0, human_w, 1.0)).mean()

    def pick(p, y):
        if select == "fp2":
            p, y = np.array(p), np.array(y)
            fp = ((p >= 0.5) & (y == 0)).sum() / max(1, (y == 0).sum())
            fn = ((p < 0.5) & (y == 1)).sum() / max(1, (y == 1).sum())
            return 1 - (2 * fp + fn) / 3
        return auc(p, y)
    steps_total = epochs * math.ceil(len(tr) / (bs * accum))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / max(1, steps_total // 10)) * max(0.0, 1 - s / steps_total))

    yv = [r["label"] for r in va]
    base_val = predict(model, tok, [r["text"] for r in va], maxlen)
    vgroups = [(("H " if r["label"] == 0 else "A ") + (r.get("group") or group_of(r["src"]))) for r in va]
    line, m0 = report("epoch 0 (" + (f"from {os.path.basename(init)}" if init else "desklib as published") + "), val", base_val, yv, vgroups)
    detect.log(line)
    detect.log("  per group: " + "  ".join(f"{g} {v['flagged']:.0%}/{v['n']}" for g, v in m0["groups"].items()))
    best = (pick(base_val, yv), 0, None)
    detect.log(f"  selection score ({select}) {best[0]:.4f}")
    os.makedirs(OUT, exist_ok=True)
    step = 0
    for ep in range(1, epochs + 1):
        model.train()
        random.shuffle(tr)
        t0, run = time.time(), 0.0
        for i in range(0, len(tr), bs):
            batch = tr[i:i + bs]
            enc = tok([detect.mask_years(r["text"]) for r in batch], truncation=True, max_length=maxlen, padding=True, return_tensors="pt").to(DEVICE)
            logit, _ = model(enc["input_ids"], enc["attention_mask"])
            loss = lossf(logit[:, 0], torch.tensor([float(r["label"]) for r in batch], device=DEVICE)) / accum
            loss.backward()
            run += loss.item() * accum
            if (i // bs + 1) % accum == 0 or i + bs >= len(tr):
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
                opt.step()
                sched.step()
                opt.zero_grad()
                step += 1
            if (i // bs) % 25 == 0:
                done = i + len(batch)
                eta = (time.time() - t0) / done * (len(tr) - done)
                detect.log(f"epoch {ep}  {done}/{len(tr)}  loss {run / (i // bs + 1):.4f}  eta {eta / 60:.0f} min")
        pv = predict(model, tok, [r["text"] for r in va], maxlen)
        if DEVICE.type == "cuda":
            detect.log(f"  peak GPU memory {torch.cuda.max_memory_allocated() / 2**30:.2f} GB")
        line, me = report(f"epoch {ep}, val", pv, yv, vgroups)
        detect.log(line)
        detect.log("  per group: " + "  ".join(f"{g} {v['flagged']:.0%}/{v['n']}" for g, v in me["groups"].items()))
        if "--save-last" in sys.argv:
            from safetensors.torch import save_file
            last_dir = arg("--save-last", "")
            os.makedirs(last_dir, exist_ok=True)
            save_file({n: p.detach().cpu().contiguous() for n, p in model.state_dict().items() if n in trainable_names},
                      os.path.join(last_dir, f"epoch{ep}.safetensors"))
            detect.log(f"  epoch {ep} layers also saved to {last_dir}")
        a = pick(pv, yv)
        detect.log(f"  selection score ({select}) {a:.4f}")
        if a > best[0]:
            from safetensors.torch import save_file
            sd = {n: p.detach().cpu().contiguous() for n, p in model.state_dict().items() if n in trainable_names}
            save_file(sd, os.path.join(OUT, "trainable.safetensors"))
            best = (a, ep, None)
            detect.log(f"  saved epoch {ep}")

    # test the best epoch on the held-out test split
    if best[1] == 0:
        detect.log("fine-tuning did not beat the starting model on validation; nothing saved")
        return
    from safetensors.torch import load_file
    model.load_state_dict(load_file(os.path.join(OUT, "trainable.safetensors")), strict=False)
    pt = predict(model, tok, [r["text"] for r in te], maxlen)
    # free the 4 GB card before loading the published model: two large models at once spill into shared memory and
    # the test step crawled for 2.5 hours on 15 Nov
    model.cpu()
    del model, opt, d  # d.model is the same module: without dropping d the 4 GB card stays full and the test crawls
    if DEVICE.type == "cuda":
        torch.cuda.empty_cache()
    base_te = predict(detect.Desklib().model.to(DEVICE), tok, [r["text"] for r in te], maxlen)
    yt = [r["label"] for r in te]
    gt = [(r.get("group") or group_of(r["src"])) for r in te]
    l1, m1 = report("TEST published desklib", base_te, yt, gt)
    l2, m2 = report(f"TEST fine-tuned (epoch {best[1]})", pt, yt, gt)
    print(l1)
    print(l2)
    for g, v in m2["groups"].items():
        print(f"    {g:14s} n={v['n']:3d}  flagged {v['flagged']:.0%}  (published: {m1['groups'][g]['flagged']:.0%})")
    json.dump({"base": "desklib/ai-text-detector-v1.01", "layers": n_layers, "maxlen": maxlen, "epoch": best[1], "val_auc": best[0],
               "test": m2, "test_published": m1, "trained": time.strftime("%Y-%m-%d"), "dataset": os.path.basename(path),
               "init": init, "select": select, "human_weight": human_w,
               "train_n": len(tr)}, open(os.path.join(OUT, "meta.json"), "w"), indent=2)


if __name__ == "__main__":
    main()
