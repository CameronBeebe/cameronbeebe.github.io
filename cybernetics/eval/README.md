# Ashby model-policy eval

This is an **eval**, not a change to the live demo. It asks a model once per
game for a structured per-row probability distribution over responses (the
same shape as a Pólya urn), freezes that policy, and scores it on the same
seeded disturbance stream as the urn learners in `../regulator.js`.

The page UI (`../index.html`, `../demo.js`, `../style.css`) is not used here
and should not be edited for this work.

## Run

From the repository root:

```bash
# Local only: mock + oracle, no API keys required
node cybernetics/eval/test-score.mjs
node cybernetics/eval/run.mjs --dry-run

# Paid providers, only if the matching env var is set. Hard cap $1.
#   TYPESAFE_API_KEY     Jev (TypeSafe System One Choice)
#   OPENROUTER_API_KEY   Haiku 5.5 via OpenRouter (preferred)
#   ANTHROPIC_API_KEY    Haiku 5.5 via Anthropic, if OpenRouter is unset
node cybernetics/eval/run.mjs --seeds 2021,1,7 --epochs 5000 --max-spend 1
```

Missing keys are skipped with a message. Keys are read from the environment
only and are never written to results or logs.

## What the model sees

Each paid model gets **one call per game**. The request includes:

- the payoff matrix (rows are disturbances, columns are responses);
- a short explanation of Ashby's game: D picks a row, R picks a column, the
  cell is the outcome, and R wins if that outcome is a listed goal value;
- the output requirement: a per-row probability distribution over response
  columns, like Jev's Choice `probabilities` (non-negative, each row sums to 1).

The request does **not** mark winning cells or list precomputed goal columns.
The model has to read the board.

## Scoring

On each step a disturbance row `d` occurs. A frozen policy is a distribution
`p[d]` over columns.

- **Argmax hit rate:** pick the highest-probability column (lowest index on
  ties); count a hit if that cell is a goal.
- **Sampled hit rate:** sample a column from `p[d]` with a dedicated seeded
  RNG (the urn learners use their own stream RNG, matching `createWorld`).
- **Target:** if the row has any goal cells, the target `q` is uniform over
  those columns; otherwise the row is skipped for proper scores (a hit is
  still impossible).
- **Log loss:** mean cross-entropy `-sum_c q_c log p_c` on solvable steps.
  This equals the target entropy when `p = q` (zero only for a single winner).
- **KL:** mean `KL(q || p) = log loss - H(q)`, which is 0 for a perfect match.
- **Brier:** mean of `sum_c (p_c - q_c)^2` on solvable steps.
- **Gap to RV:** requisite-variety bound minus argmax hit rate.

Baselines in the same table: the **blind** and **disturbance-conditioned**
urn learners (their pre-update distribution is scored each step; `sampledHit`
is their actual action), plus the **RV** and **blind-optimum** bounds, and a
local **oracle** that puts uniform mass on the winning columns.

The harness checks that each row is the right length, finite, non-negative,
and sums to 1 (within 1e-9). Rows that only fail the sum are renormalized
and listed in `renormalizedRows`. Invalid rows are listed in `failures` and
replaced with uniform so the stream can still be scored; they are not
fixed silently. A policy with any failure is marked `valid: false`.

## Spend

Jev is billed at $0.042 per million input tokens (output is free; see
[TypeSafe models](https://docs.typesafe.ai/models)). Haiku 5.5 is billed at
the published OpenRouter rates ($0.10 / $0.50 per million input / output) or
`usage.cost` when that field is a plausible USD amount. `--max-spend`
(default 1) stops further paid calls if the reserve would break the cap.
