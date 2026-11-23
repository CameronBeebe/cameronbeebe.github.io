#!/usr/bin/env python3
"""Score the demo texts with the shipped byte trigram, and emit a compact JS-ready model."""
from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
MODEL = json.loads((HERE / "char_trigram.json").read_text())
# Reuse texts after neural run if scores.json exists; otherwise the same originals.
TEXTS_FALLBACK = [
    ("counting", "one two three four five six seven eight nine ten"),
    ("repetition", "The first time I write this sentence the model is unsure. The first time I write this sentence the model is unsure."),
    ("philosophy", "A strictly proper scoring rule is uniquely optimized by reporting one's true probabilities, which is why log loss remains the natural training objective for a probabilistic language model."),
    ("code", "def bits_per_byte(total_nll_nats, n_bytes):\n    return total_nll_nats / (math.log(2) * n_bytes)\n"),
    ("surprise", "The capital of France is Paris, but the capital of France is zucchini."),
]

LAM_TRI = MODEL["smoothing"]["lambda_tri"]
LAM_BI = MODEL["smoothing"]["lambda_bi"]
LAM_UNI = MODEL["smoothing"]["lambda_uni"]
UNI = {int(k): v for k, v in MODEL["unigram"].items()}
UNI_TOTAL = MODEL["unigram_total"]
BI = {}
for k, v in MODEL["bigram"].items():
    a, b = k.split(",")
    BI[(int(a), int(b))] = v
TRI = {}
for k, v in MODEL["trigram"].items():
    a, b, c = k.split(",")
    TRI[(int(a), int(b), int(c))] = v
# Bigram context totals from kept bigrams plus we need context counts.
# Reconstruct context counts from bigram entries (pruned). For ML of bigram
# we also need total count for context byte. Approximate with sum of kept
# successors; also keep unigram as context total fallback.
BI_CTX = {}
for (a, b), c in BI.items():
    BI_CTX[a] = BI_CTX.get(a, 0) + c
TRI_CTX = {}
for (a, b, c), n in TRI.items():
    TRI_CTX[(a, b)] = TRI_CTX.get((a, b), 0) + n


def p_byte(b1, b2, b3) -> float:
    p_uni = (UNI.get(b3, 0) + 1) / (UNI_TOTAL + 256)
    ctx1 = BI_CTX.get(b2, 0)
    p_bi = (BI.get((b2, b3), 0) / ctx1) if ctx1 else 0.0
    ctx2 = TRI_CTX.get((b1, b2), 0)
    p_tri = (TRI.get((b1, b2, b3), 0) / ctx2) if ctx2 else 0.0
    return LAM_TRI * p_tri + LAM_BI * p_bi + LAM_UNI * p_uni


def score(text: str) -> dict:
    data = text.encode("utf-8")
    tokens = []
    nlls = []
    for i, b in enumerate(data):
        entry = {"byte": b, "text": bytes([b]).decode("utf-8", "replace"), "scored": False}
        if i >= 2:
            p = p_byte(data[i - 2], data[i - 1], b)
            p = max(p, 1e-15)
            lp = math.log(p)
            entry.update(
                {
                    "scored": True,
                    "p": p,
                    "logp_nats": lp,
                    "surprisal_bits": -lp / math.log(2.0),
                }
            )
            nlls.append(-lp)
        tokens.append(entry)
    n_bytes = len(data)
    total = float(sum(nlls))
    n_scored = len(nlls)
    ce = total / n_scored if n_scored else float("nan")
    return {
        "n_bytes": n_bytes,
        "n_scored": n_scored,
        "total_nll_nats": total,
        "cross_entropy_nats": ce,
        "bits_per_token": ce / math.log(2.0) if n_scored else float("nan"),
        "perplexity": math.exp(ce) if n_scored else float("nan"),
        "bits_per_byte": total / (math.log(2.0) * n_bytes) if n_bytes and n_scored else float("nan"),
        # Don't ship every byte token in the summary; the live JS rescores.
    }


def main() -> None:
    texts = list(TEXTS_FALLBACK)
    scores_path = HERE / "scores.json"
    if scores_path.exists():
        blob = json.loads(scores_path.read_text())
        texts = [(t["id"], t["text"]) for t in blob["texts"]]
    out = {}
    for tid, text in texts:
        s = score(text)
        print(f"{tid}: PPL={s['perplexity']:.3f} BPB={s['bits_per_byte']:.4f} bytes={s['n_bytes']} scored={s['n_scored']}")
        out[tid] = {k: v for k, v in s.items() if k != "tokens"}
    Path(HERE / "char_scores.json").write_text(json.dumps(out, indent=2))
    print("wrote char_scores.json")


if __name__ == "__main__":
    main()
