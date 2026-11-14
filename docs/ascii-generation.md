# ASCII harness experiment

Generate exposes four switches: detailed error feedback, workspace tools, tool guidance, and a DSPy prompt candidate. These are separate inputs to the run, not bundled presets. Tool guidance requires tools; switching tools off also turns guidance off.

## Fixed task and runtime

The displayed grid has 75 columns and 50 rows and uses ` .,:;*oxO%#@`. Direct output must contain all 50 exact-width strings. It is never padded, cropped, converted from an image, or replaced with preset artwork.

With tools enabled, the model gets a persistent workspace:

- `create_grid(width, height, rows)` initializes spaces and optionally writes up to 50 literal row prefixes. It can place a whole picture in one call. Initial prefixes may contain 0–75 allowed glyphs.
- `write_rows(updates)` and `write_columns(updates)` batch edits. Each write changes only its supplied cells from column 1 or row 1; shorter text leaves the remaining cells untouched. No cropping, character substitution, or drawing primitives are involved.
- `submit_grid()` publishes the current state without another full-grid output.

Indices start at 1. Calls in one response execute in listed order. An invalid grid creation leaves the previous state unchanged; an invalid incremental write leaves those cells unchanged while valid sibling writes apply. Editing clears the submitted flag. Unknown functions and out-of-bounds writes are rejected. A model response with incomplete or truncated tool framing is never executed.

The interface previews workspace snapshots after each model turn and distinguishes work in progress from submission. Validly shaped but unfinished work is not judged as a completed result. Restoring rewinds those previews through the existing portrait history.

All new switch combinations have the same ceiling of eight model turns, 32,768 output tokens per turn, fixed provider price limits, and a five-minute run deadline. Tool runs need time to create, edit, and submit; eight turns replaces the earlier three-draft UI budget. Successful submission/direct-format success stops early. The existing IP limiter permits three runs per minute, so a run can make eight model calls and an IP could make 24 per minute; use the owner's OpenRouter spend ceiling for total billing. Legacy `single`, `repair`, and `retry` evaluation modes retain their one/three-turn budgets.

## What each switch changes

**Error feedback** controls model-visible detail, not validation. On supplies exact errors; off supplies generic rejections. Basic accepted/rejected status and workspace snapshots remain available. The exported human record always retains detailed observations and the actual feedback sent to the model.

**ASCII tools** changes the output protocol from full-grid JSON to native function calls. Function schemas and minimal descriptions are always included when tools are enabled.

**Tool guidance** adds the visible workflow advice in `assets/ascii-workspace.mjs`: batch writes, preserve successful sections, inspect results, and submit when ready. It does not silently enable additional tools.

**DSPy prompt** selects composition instructions from `assets/ascii-prompts.json`. The mandatory output/tool contract and manual guidance remain separate. It does not optimize on each visitor request or alter model weights. The artifact is a small Qwen pilot; cross-model transfer and all switch combinations are untested. A changed GEPA candidate is not guaranteed to outperform baseline.

A submitted rendering is judged separately by Jev with the existing parallel 0–3 brief-match and visual-coherence rubrics. These are fallible descriptive scores, not correctness probabilities or format acceptance gates. The generator does not currently receive its rendered image or Jev's scores during a public run.

## Actual DSPy optimization

`ask-worker/optimize-ascii.py` runs DSPy 3.5 GEPA over the practice and validation splits in `ask-worker/dspy-briefs.json`, then evaluates baseline and the selected changed candidate on a separate held-out split. A custom DSPy adapter calls the same JavaScript generation/tool engine through a private stdin/stdout bridge (`ascii-offline.mjs`). This avoids optimizing against a different DSPy text-output wrapper. The bridge has no HTTP route. Keys remain in the local process environment and the existing Cloudflare secrets; they are never exported.

The metric gives invalid/blank output zero, otherwise `(0.8 × Jev brief match + 0.2 × visual coherence) / 3`. It supplies exact validation/tool failures and fallible visual rubric feedback to GEPA. A custom proposal predictor receives compact trial evidence and is constrained to visual composition advice, keeping it from copying tool guidance or redefining other switches. Repeated scoring of the identical generated trace reuses its judgment rather than re-querying Jev. Offline images use approximate Pillow/Menlo rasterization at the browser's 375 px dimensions, glyph ramp and colors. They are not exact browser screenshots. On other platforms set `ASCII_EVAL_FONT` to a monospace TTF/OTF font.

```sh
uv run ask-worker/optimize-ascii.py --out /private/tmp/ascii-gepa --budget 14 --publish
```

The script pins its dependencies. Set `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY` privately in the environment, not in arguments or public files. Generation traces, metrics, and DSPy state stay in the chosen output directory. `--publish` exports only the prompt/evaluation artifact to the site. Do not publish an empty/no-candidate run or handwrite an allegedly optimized prompt. The selected artifact is the best validation-scored changed candidate; rejected practice proposals can also receive explicit validation after the search, recorded separately. it records the optimizer's overall winner too, which may still be baseline. This makes the toggle usable for comparison without implying an improvement when the data doesn't support it.

The exported record includes candidate instructions, lineage, validation scores, held-out cases, model, versions, dataset/engine hashes, budget and limitations. Public requests cannot supply arbitrary replacement instructions. Frontend/Worker prompt ID mismatches are rejected rather than silently using another version.

## Evaluation and maintenance

Run:

```sh
node --test ask-worker/*.test.mjs assets/portrait-fire.test.mjs
npx wrangler deploy --config ask-worker/wrangler.toml --dry-run
```

Browser-check each switch, tool-guidance dependency, live workspace updates, tool trace, export, prior workspace previews, another ASCII mode, Restore, and mobile fit. Preserve failures, partial output, unavailable judgments, and unreported costs. Inspect actual prompts to verify that turning a switch off removes that additional context/capability.

`evaluate-ascii.mjs` remains the earlier direct-output comparison runner for single drafts, feedback repair and fresh retries. Its randomized order and failure-inclusive metrics do not establish broad superiority. The pilot cases are excluded from GEPA prompt search, but have been reused during development; they are exploratory rather than a blind confirmation set. The GEPA pilot is also small and noisy: use repeated independent held-out runs and matched budgets before making reliability or quality claims. Never tune on held-out cases after examining their results and continue to call them untouched tests.

Primary references: [GEPA](https://dspy.ai/current/getting-started/gepa-optimization/), [DSPy 3.5](https://github.com/stanfordnlp/dspy/releases/tag/3.5.0), [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling).
