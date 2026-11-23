#!/usr/bin/env python3
"""Train a byte-level interpolated trigram on WikiText-2 raw train and export it."""
from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path

from datasets import load_dataset

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "char_trigram.json"
# Keep the shipped model small: prune rare trigrams; back off to bigram/unigram.
MIN_TRIGRAM = 3
MIN_BIGRAM = 2


def main() -> None:
    ds = load_dataset("Salesforce/wikitext", "wikitext-2-raw-v1", split="train")
    texts = [row["text"] for row in ds if row["text"]]
    data = "".join(texts).encode("utf-8")
    print(f"Train bytes: {len(data)}", flush=True)

    uni = Counter()
    bi = Counter()
    tri = Counter()
    # Use a start-of-text byte context of 0x02 (STX) twice, not a valid common pair in text.
    # Simpler: no wrap; score from byte 2 onward, same as neural first-token skip in spirit.
    for b in data:
        uni[b] += 1
    for i in range(len(data) - 1):
        bi[(data[i], data[i + 1])] += 1
    for i in range(len(data) - 2):
        tri[(data[i], data[i + 1], data[i + 2])] += 1

    uni = {str(k): v for k, v in uni.items() if v > 0}
    bi = {f"{a},{b}": c for (a, b), c in bi.items() if c >= MIN_BIGRAM}
    tri = {f"{a},{b},{c}": n for (a, b, c), n in tri.items() if n >= MIN_TRIGRAM}
    print(f"unigrams {len(uni)} bigrams {len(bi)} trigrams {len(tri)}", flush=True)

    total_uni = sum(uni.values())
    out = {
        "source": "Salesforce/wikitext wikitext-2-raw-v1 train split",
        "unit": "utf-8-bytes",
        "train_bytes": len(data),
        "min_trigram_count": MIN_TRIGRAM,
        "min_bigram_count": MIN_BIGRAM,
        "smoothing": {
            "kind": "interpolation",
            "lambda_tri": 0.4,
            "lambda_bi": 0.4,
            "lambda_uni": 0.2,
            "note": (
                "P(b3|b1,b2) = 0.4 * P_ml(b3|b1,b2) + 0.4 * P_ml(b3|b2) + 0.2 * P_ml(b3), "
                "with add-1 (Laplace) over a 256-byte alphabet for the unigram term, "
                "and maximum-likelihood (0 if unseen) for the higher-order terms. "
                "Rare n-grams below the count cutoffs are treated as unseen. "
                "This is a toy model, clearly labeled as such in the demo."
            ),
        },
        "alphabet": 256,
        "unigram_total": total_uni,
        "unigram": uni,
        "bigram": bi,
        "trigram": tri,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KiB)", flush=True)


if __name__ == "__main__":
    main()
