#!/usr/bin/env python3
"""Score short public texts with small open LMs. Writes measured numbers only."""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = Path(__file__).resolve().parent.parent  # perplexity/
OUT = HERE / "scores.json"

TEXTS = [
    {
        "id": "counting",
        "title": "A highly predictable sequence",
        "text": "one two three four five six seven eight nine ten",
        "note": "Original example text.",
    },
    {
        "id": "repetition",
        "title": "Repeated sentence (induction)",
        "text": (
            "The first time I write this sentence the model is unsure. "
            "The first time I write this sentence the model is unsure."
        ),
        "note": "Original example text, in the spirit of induction-head demos.",
    },
    {
        "id": "philosophy",
        "title": "A short philosophy-of-science sentence",
        "text": (
            "A strictly proper scoring rule is uniquely optimized by reporting "
            "one's true probabilities, which is why log loss remains the natural "
            "training objective for a probabilistic language model."
        ),
        "note": "Original example text.",
    },
    {
        "id": "code",
        "title": "A tiny Python function",
        "text": (
            "def bits_per_byte(total_nll_nats, n_bytes):\n"
            "    return total_nll_nats / (math.log(2) * n_bytes)\n"
        ),
        "note": "Original example text.",
    },
    {
        "id": "surprise",
        "title": "Fluent setup, then a rare word",
        "text": "The capital of France is Paris, but the capital of France is zucchini.",
        "note": "Original example text.",
    },
    {
        "id": "wikitext_excerpt",
        "title": "WikiText-2 raw test excerpt",
        "text": "",
        "note": (
            "A short prefix of the Salesforce/wikitext wikitext-2-raw-v1 test split "
            "(first completed word at or before 600 characters of the concatenated "
            "non-empty rows). This is a slice for the interactive demo, not a full "
            "WikiText-2 benchmark."
        ),
    },
]

MODELS = [
    {
        "id": "gpt2",
        "hf_id": "gpt2",
        "label": "GPT-2 small (124M)",
        "family": "GPT-2 BPE",
    },
    {
        "id": "distilgpt2",
        "hf_id": "distilgpt2",
        "label": "DistilGPT-2 (82M)",
        "family": "GPT-2 BPE",
    },
    {
        "id": "smollm2-135m",
        "hf_id": "HuggingFaceTB/SmolLM2-135M",
        "label": "SmolLM2-135M",
        "family": "SmolLM2 tokenizer",
    },
]


def load_wikitext_excerpt(n_chars: int = 600) -> str:
    from datasets import load_dataset

    ds = load_dataset("Salesforce/wikitext", "wikitext-2-raw-v1", split="test")
    parts = [row["text"] for row in ds if row["text"] and row["text"].strip()]
    blob = "".join(parts)
    excerpt = blob[:n_chars]
    if len(blob) > n_chars:
        sp = excerpt.rfind(" ")
        if sp > n_chars * 3 // 4:
            excerpt = excerpt[:sp]
    return excerpt


def score_text(model, tokenizer, text: str, top_k: int = 5) -> dict:
    # Uniform protocol: encode the raw text with add_special_tokens=False.
    # These three tokenizers do not prepend BOS, so the first token has no
    # context and is displayed but not scored. Each later token i is scored
    # from logits at position i-1 (standard teacher forcing).
    encoded = tokenizer(text, return_tensors="pt", add_special_tokens=False)
    input_ids = encoded["input_ids"]
    ids = input_ids[0].tolist()
    pieces = tokenizer.convert_ids_to_tokens(ids)
    device = next(model.parameters()).device
    input_ids = input_ids.to(device)
    with torch.no_grad():
        logits = model(input_ids=input_ids).logits[0]
        log_probs = torch.log_softmax(logits.float(), dim=-1)

    tokens_out = []
    nlls = []
    for i, tid in enumerate(ids):
        try:
            shown = tokenizer.decode([tid], skip_special_tokens=False)
        except Exception:
            shown = pieces[i]
        entry = {
            "id": int(tid),
            "piece": pieces[i],
            "text": shown,
            "scored": False,
        }
        if i >= 1:
            lp_row = log_probs[i - 1]
            lp = float(lp_row[tid])
            top = torch.topk(lp_row, k=top_k)
            entry.update(
                {
                    "scored": True,
                    "logp_nats": lp,
                    "p": math.exp(lp),
                    "surprisal_bits": -lp / math.log(2.0),
                    "top": [
                        {
                            "id": int(j),
                            "text": tokenizer.decode([int(j)], skip_special_tokens=False),
                            "p": float(math.exp(float(v))),
                        }
                        for v, j in zip(top.values.tolist(), top.indices.tolist())
                    ],
                }
            )
            nlls.append(-lp)
        tokens_out.append(entry)

    n_bytes = len(text.encode("utf-8"))
    scored_text = "".join(tok["text"] for tok in tokens_out if tok["scored"])
    n_bytes_scored = len(scored_text.encode("utf-8"))
    total_nll = float(sum(nlls))
    n_scored = len(nlls)
    ce = total_nll / n_scored if n_scored else float("nan")
    return {
        "n_tokens": len(ids),
        "n_scored": n_scored,
        "n_bytes": n_bytes,
        "n_bytes_text": n_bytes,
        "n_bytes_scored": n_bytes_scored,
        "total_nll_nats": total_nll,
        "cross_entropy_nats": ce,
        "bits_per_token": ce / math.log(2.0) if n_scored else float("nan"),
        "perplexity": math.exp(ce) if n_scored else float("nan"),
        "bits_per_byte": (total_nll / (math.log(2.0) * n_bytes_scored)) if n_bytes_scored and n_scored else float("nan"),
        "tokens": tokens_out,
    }


def main() -> None:
    print("Loading WikiText-2 raw test excerpt…", flush=True)
    excerpt = load_wikitext_excerpt(600)
    for t in TEXTS:
        if t["id"] == "wikitext_excerpt":
            t["text"] = excerpt

    report = {
        "computed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "device": "cpu",
        "dtype": "float32",
        "software": {
            "torch": torch.__version__,
            "transformers": __import__("transformers").__version__,
        },
        "protocol": {
            "description": (
                "Causal LM teacher forcing on each text independently. "
                "Single forward pass; each text fits in context. "
                "Encoding uses add_special_tokens=False (none of these three "
                "tokenizers prepends BOS). The first token is shown but not scored. "
                "Log-probabilities come from a float32 softmax of the logits. "
                "Bytes are the UTF-8 length of the raw text. "
                "cross_entropy_nats is the mean negative log-likelihood over scored "
                "tokens; perplexity is exp of that mean (token-level); "
                "bits_per_byte is total NLL in nats / (ln(2) * n_bytes_scored)."
            )
        },
        "models": {},
        "texts": [
            {"id": t["id"], "title": t["title"], "text": t["text"], "note": t["note"]}
            for t in TEXTS
        ],
        "scores": {},
    }

    for spec in MODELS:
        mid, hf = spec["id"], spec["hf_id"]
        print(f"Loading {hf}…", flush=True)
        t0 = time.time()
        tok = AutoTokenizer.from_pretrained(hf)
        model = AutoModelForCausalLM.from_pretrained(hf, torch_dtype=torch.float32)
        model.eval()
        n_params = sum(p.numel() for p in model.parameters())
        report["models"][mid] = {
            **spec,
            "parameter_count": n_params,
            "vocab_size": int(getattr(tok, "vocab_size", len(tok))),
            "bos_token_id": tok.bos_token_id,
            "eos_token_id": tok.eos_token_id,
            "load_seconds": round(time.time() - t0, 2),
        }
        report["scores"][mid] = {}
        for t in TEXTS:
            print(f"  scoring {t['id']} ({len(t['text'])} chars)…", flush=True)
            s0 = time.time()
            result = score_text(model, tok, t["text"])
            result["score_seconds"] = round(time.time() - s0, 3)
            report["scores"][mid][t["id"]] = result
            print(
                f"    PPL={result['perplexity']:.3f}  BPB={result['bits_per_byte']:.4f}  "
                f"tokens={result['n_tokens']} scored={result['n_scored']}  {result['score_seconds']}s",
                flush=True,
            )
        del model

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Wrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
