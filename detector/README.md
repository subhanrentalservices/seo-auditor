# AI-text detector (local)

Added 2026-11-11 on the owner's request for a GPTZero-style check inside the SEO Auditor. Everything runs on this
computer; no text is sent anywhere.

## Use

```
node src/cli.mjs ai-detect <url|file.html|file.md|file.txt|-> [...] [--json]
node src/cli.mjs ai-check --detect <url|file> [...]     # phrase/style check + detector, both must pass
```

Output: the page's AI probability (word-weighted over blocks of about 220 words) and the most AI-like blocks.
A page passes below 20% with no block at 50% or more (`src/ai-detect.mjs`).

## Model

`detect.py` loads `desklib/ai-text-detector-v1.01` (DeBERTa-v3-large, MIT) and puts the fine-tuned top layers from
`finetuned/trainable.safetensors` over it. `finetuned/meta.json` holds the held-out test results.

Why fine-tuned: the published detectors (desklib, Mozilla Fakespot, Binoculars with Qwen) catch 2022 ChatGPT text
but missed the factual how-to writing Claude produces for this site (desklib AUC 0.33-0.42 on our test sets; Binoculars
rated Claude drafts *more* human than human articles). Trained on in-domain data the same model separates them.

Current model (v3, 15 Nov 2026, dataset v5): trained to catch every common AI, not only Claude (owner, 14 Nov:
"har ak ai ka text pakarne ka liya train karo"). Dataset v5 (`dataset/build_multi.py`, 17,940 passages) adds to v4:
HAP-E-2 (a human text continued by GPT-4o, GPT-4o-mini, GPT-5-mini, Claude Haiku 4.5, Gemma 2 9B/27B and Llama 3
8B/70B, instruct and base models, next to the human's real continuation), ELI5 answers from GPT-5.6, Gemini 3.7 Flash,
DeepSeek V4, Qwen 3.8, Grok 4.6, GLM 5.3 and Nemotron 3.5 against pre-2022 Reddit ELI5 answers, and arXiv abstracts
against paraphrases by Gemini 3 Flash, GPT-5-nano, gpt-oss-120b and Claude Haiku 4.5. Two epochs, top 6 layers.

| Held-out text | v2 (Claude-only) | v3 |
|---|---|---|
| Test (2,579 passages from unseen documents): AI caught | 49.6% | 99.4% |
| Test: human passages flagged | 0.1% | 2.0% |
| External, never trained on (TextSight 2026, AITA 2026): AI caught | 26.4% | 99.3% |
| External: human flagged (pre-2022 Wikipedia, PubMed Central) | 6.8% | 10.9% |

Per model on the test split (`eval.py`, `dataset/data/eval-v3-on-calset5.json`): every model 90-100% caught (Llama 3
70B base 90%, GPT-5-nano paraphrases 94%, the rest 96-100%). External: Claude Opus 5, Claude Haiku 4.5, GPT-4.1,
gpt-oss-120b, Qwen 3.8, GPT-5.6, Grok 4.6, Nemotron 100%; DeepSeek V4, Gemini 3.7, GLM 5.3 98%. Human false alarms
on the test split by genre: Reddit and spoken 0%, web articles 1%, news, blogs, academic 3-4%, fiction 6%.

Known weakness: formal encyclopedic and scientific prose. 15% of pre-2022 Wikipedia passages and 8% of PubMed Central
passages score 50% or more, some at 99-100% (the US Constitution intro, Ottoman history). Raising the line trades
catches for fewer false alarms (external set): 0.5: 10.9% human flagged, 99.3% AI caught; 0.9: 6.5%, 98.3%;
0.98: 2.7%, 97.5%. A v4 run (15 Nov: dataset v6 with 1,800 Wikipedia intros and HC3 Wikipedia answers paired with AI
text on the same titles, `dataset/build_v6.py`, one more epoch from v3 with human loss weighted 1.5) did not help:
validation human flagged 3.9% against v3's 3.2% (AI missed 0.3% against 1.2%), so it was not kept. A second try
(v4b, 15 Nov: learning rate 3e-6, human loss weighted 2.0, per-group validation logged) made it worse where it mattered:
Wikipedia human passages flagged 9% against v3's 5% on validation, all human 4.4% against 3.2%, while AI caught rose to
99.8%. Training on GPT-3 Wikipedia-style intros taught the model to treat the encyclopedic style itself as AI. Its
layers are in `finetuned-v4b-epochs/` for reference; v3 stays.
A third try (v4c, 15 Nov, after the owner pointed out that the GPT-3 text was too old): dataset v6b
(`gen_wiki_claude.py`, `build_v6b.py`) with the AI side of the Wikipedia pairs written by Claude Sonnet and Haiku
(600 titles, $1.57) and the 2022 ChatGPT rows dropped. Validation was level with v3 (human flagged 3.3% vs 3.2%), but
on the external set human false alarms rose to 12.7% (Wikipedia 16%, PubMed Central 10%) against v3's 10.9%, and on the
test split to 2.6% against 2.0% (arXiv 9% vs 4%), for 99.8% AI caught. Not kept (`finetuned-v4c/`). Three tries point
the same way: more training on this model buys a little recall and costs false alarms on formal human prose, so v3
stays and further fine-tuning was stopped.
So a high score on formal reference-style writing is weaker evidence than on blog or how-to text.

Earlier models: v2 (12 Nov, dataset v4, Claude drafts and ChatGPT only; backup `finetuned-v2/`) scored AUC 1.000 on
its own test but caught only 5% of Gemini 3.7 and 7% of GPT-5-mini text. v1 (11 Nov) in `finetuned-v1/`. v3 is also
backed up in `finetuned-v3/`.

First full scan of picturetolink.com (101 live pages, 12 Nov): every page 87-100% AI-like with both v1 and v2.
Re-scan with v3 (15 Nov): every page 88-100% (lowest: privacy 88%, imgur-uk-blocked-alternatives 90%, discord-image-sizes
94%), none under 50% (`data/ai-detect/site-scan-*.json`). The pages are Claude-written, and v3 scores Claude-written
text 100% in any style (see `../humanizer/train-v3/` and the human-voice skill).

## Training data (`dataset/`)

- AI: first committed versions of picturetolink.com blog posts and calculator pages (unedited Claude drafts,
  `git show <first commit>:<file>`), and ChatGPT answers from HC3.
- Human: pre-ChatGPT (snapshots up to mid-2021) web articles on the same topics from the Wayback Machine
  (`collect_human.py`, image topics and calculator topics), HC3 human answers, pre-LLM essays.
- `build.py` normalises every source the same way as inference (`detect.normalize`: list marks, Markdown, quotes,
  short lines, brand names), cuts 150-260-word passages, drops broken or non-English archive pages and splits
  70/15/15 by document.

Retrain: `python dataset/build.py` (v4), `python dataset/build_multi.py` (v5, needs the sources in `data/multi/`, see
its docstring), then `.venv-gpu/Scripts/python finetune.py dataset/data/calset5.json --epochs 2 --layers 6` (about
2.5 h per epoch on a Quadro P1000). Options: `--init <weights>` continues from earlier layers, `--select fp2` keeps the
epoch with the fewest human false alarms (counted double), `--human-weight`. Evaluate per source with
`.venv-gpu/Scripts/python eval.py dataset/data/calset5.json --splits test,ext [--scores rows.json]`.
`.venv-gpu` is a venv with `--system-site-packages` and `torch==2.14.1+cu126`. The 4 GB card holds one model at a
time: run one GPU job at a time.

## Humanizer test (12 Nov 2026)

`../humanizer/humanize.py` rewrote the EXIF post with jialinyyzz/humanizer (Gemma-4-12B, Q4_K_M, llama.cpp on the
GPU): page score 97% to 81%, 8 of 18 blocks accepted. The accepted rewrites scored 0-40%, but they read worse (a stray
`<p>`, "kinda stuff", a meaning change, bold lost). Once those rewrites were corrected for grammar and meaning, the
scores went back to 38-100%. Low scores here come from rough text, not from human writing.

Follow-up (12 Nov): general models rewriting the draft cleanly (Gemma 4 12B, Qwen3 14B) still scored 96-100%, so the
detector also catches non-Claude polished text. Best pipeline found: Smaug-Humanizer (Q4_K_M) rewrites, Gemma 4 12B
proofreads with the original beside it and runs a meaning check (`--proof-model ... --meaning-check`). On the first
900 words of the EXIF post: 100% to 66%, single blocks 0-12% with correct facts; one meaning drift slipped through,
so a human-style read against the original is still needed before anything is published.

## Limits

- It measures how close a text is to the machine writing of 23 models it was trained on (2023-2026 GPT, Claude,
  Gemini, Llama, Gemma, Qwen, DeepSeek, Grok, GLM, Nemotron). It cannot prove who wrote something. Mistral is not in
  the data, and new models may score differently.
- Formal reference prose (Wikipedia, scientific papers) gets false alarms more often (above).
- Human text on genres missing from the training data (legal pages, UI copy) is less certain.
- Data, venv and weights are not in git (`.gitignore`); the dataset folder is about 30 MB, the weights 300 MB.
