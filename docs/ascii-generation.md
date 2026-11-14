# Direct ASCII generation experiment

The generator writes a JSON object containing 50 rows of 75 characters. Every cell is model-authored. The renderer displays those characters; it does not convert a generated image, pad rows, crop rows, or supply replacement artwork.

## Runtime feedback

Generate defaults to validation repair. The Worker checks the complete draft and returns all format errors, including actual versus expected row widths and forbidden glyph coordinates. A failed draft and these exact errors enter the next model call. The model returns the full grid again, with instructions to preserve valid rows and composition where possible.

A run stops on structural success, after three drafts, on a provider/output-budget failure, on cancellation, or at its five-minute deadline. Every call retains the existing 32,768-token cap and provider price ceiling. The request rate is three runs per minute, so repair can make up to nine generation calls per minute per IP. These limits bound work; they do not promise success.

The UI streams each completed draft, links repairs to their parents, and exports prompts, raw outputs, validation errors, IDs, timings, provider, and reported usage. Invalid drafts are inspectable without replacing the displayed artwork. Interrupted streams preserve the started call, available partial text, and unreported billing instead of disappearing. Turning feedback off requests one draft. A valid final draft is rendered and judged separately by Jev; its visual scores never decide whether the structure passes or trigger another generation call.

This is an explicit JavaScript repair harness. It is not DSPy `Refine`, GEPA optimization, learning across visitors, or weight editing. The generator currently receives text feedback, not the rendered preview. Visual feedback and prompt optimization require their own evaluation before being presented as improvements.

## Compare feedback with fresh retries

The endpoint accepts `mode: "single"`, `"repair"`, or `"retry"`. Repair and retry share identical initial prompts, model settings, maximum calls, token caps, deadlines, and structural stopping rules. Retry starts each call from the original brief, without the failed output or validator feedback. Actual calls and cost differ when one succeeds sooner. Provider routing remains a source of variation.

Create a JSON array of briefs outside the repository, then run:

```sh
node ask-worker/evaluate-ascii.mjs /private/tmp/briefs.json /private/tmp/ascii-evaluation.json qwen/qwen3.6-35b-a3b 3
```

This makes paid requests through the existing Worker, randomizes strategy order, and paces starts to respect its rate limit. It preserves started calls, stream events, errors, and incomplete runs, counts missing billing, and stops on a request failure. It measures format reliability, calls, reported cost, and elapsed time. It does not measure visual quality, and one successful repair is not evidence of general improvement. Treat small live smoke tests only as integration checks.

For broader evaluation, freeze separate practice and held-out briefs spanning subjects, compositions, and shading, use repeated runs, and compare visual quality independently of format validity. Keep failures in the denominator. Compare a feedback loop with a fresh-retry control before attributing improvements to feedback. Record model/provider/settings and both reported costs and missing billing.

## DSPy optimization stage

After establishing this baseline, use actual DSPy GEPA offline with practice/validation cases and actionable failure feedback. Freeze the final prompt before evaluating held-out cases; export the selected instructions/configuration to the Worker. The current implementation does not claim a completed optimization run. Useful primary references:

- [DSPy 3.5 structured histories and rich tool results](https://github.com/stanfordnlp/dspy/releases/tag/3.5.0)
- [GEPA optimization and text feedback](https://dspy.ai/current/getting-started/gepa-optimization/)
- [DSPy Refine implementation](https://github.com/stanfordnlp/dspy/blob/3.5.0/dspy/predict/refine.py)
