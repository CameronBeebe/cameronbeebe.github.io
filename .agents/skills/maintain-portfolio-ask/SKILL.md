---
name: maintain-portfolio-ask
description: Maintain Ask more and the Color/Generate portrait experiments on cameronbeebe.github.io. Use for changes to search, model comparisons, indexed sources, or the Cloudflare Worker, including testing and deployment.
---

# Maintain portfolio Ask

Work from the repository root. GitHub Pages serves the panel in `index.html` and `assets/ask-cameron.js`. The panel's `data-endpoint` points to the deployed `cameron-portfolio-ask` Cloudflare Worker. Its source and Wrangler configuration are in `ask-worker/`.

## Decide what to rebuild

- Panel copy, suggestions, and display changes are website changes. Verify them in the site preview.
- The Worker fetches the published CV and GitHub sources with a 15-minute cache. Publish CV and README edits at their sources. For changes to which GitHub sources the Worker fetches, edit `ask-worker/sources.mjs`.
- For new or changed PDFs, update `ask-worker/research-sources.json` and regenerate the index. The same command prepares a fresh checkout for Worker tests or deployment.

```sh
uv run --with pymupdf python ask-worker/index-research.py
```

This downloads the listed PDFs with curl and writes `ask-worker/research-index.generated.json`. Wrangler bundles that generated file into the Worker. Leave it out of Git. Worker code changes can reuse a current index. For local PDFs, the indexer accepts one `--pdf FILE PDF_URL LABEL TITLE` group per document.

## Test and deploy

Run the Worker tests after backend or corpus changes. Validate the build before deploying.

```sh
node --test ask-worker/*.test.mjs
npx wrangler deploy --config ask-worker/wrangler.toml --dry-run
```

Use the delivery target from the user's request. To publish a Worker change, deploy the existing `cameron-portfolio-ask` Worker on the account that owns the panel's endpoint.

```sh
npx wrangler deploy --config ask-worker/wrangler.toml
```

If Wrangler is unauthenticated and the Cloudflare connector is available, use Wrangler's dry run with `--outdir` in a temporary directory to build the module. Use the connector to upload it to the existing Worker. Apply the settings and rate limiter from `wrangler.toml`. On a direct API upload, use `keep_bindings: ["secret_text", "secret_key"]` to preserve existing secrets. `TYPESAFE_API_KEY` already lives in Cloudflare as a Worker secret.

After deployment, send a public example question to the URL from `data-endpoint` and verify that the result answers it and links to the expected source.

```sh
curl -fsS https://cameron-portfolio-ask.cameronbeebe.workers.dev/ask \
  -H 'Origin: https://cameronbeebe.github.io' \
  -H 'Content-Type: application/json' \
  --data '{"question":"What is fungi_chromatic?"}'
```

For a local live test, run `npx wrangler dev --config ask-worker/wrangler.toml --port 8787 --env-file /path/to/private/ask-worker.env` and open the local site with `?live-ask#ask-cameron`. Keep the environment file outside both the repository and the preview server's directory.

## Portrait palettes

The Color mode uses `assets/portrait-palette.js`, the portrait bridge in `assets/portrait.js`, and shared palette validation in `assets/palette-colors.mjs`. The same Worker serves `/palette` through `ask-worker/palette.mjs`. It needs `OPENROUTER_API_KEY` as a Cloudflare secret and the `PALETTE_LIMIT` binding from `wrangler.toml`. Never put the key into browser code or a public file. `TYPESAFE_API_KEY` remains the separate key for Ask more.

The endpoint streams three fixed, parallel model results as NDJSON. It limits moods to 120 characters, caps each call at 1,024 output tokens including reasoning (320 with reasoning off for Qwen), and excludes providers above $0.40/M input or $1/M output. It requires JSON Schema support and validates the JSON shape, then computes readable lightness from the generated hues. Inkling and GLM require reasoning; Qwen supports disabling it. Report those settings with timings. Preserve failures and missing cost as such; do not fabricate results or replace unsuccessful generations with preset palettes. First-token time excludes reasoning-only events and keepalives; usable-JSON latency is distinct from the later billing frame. These are live observations including provider/network time, not general benchmark rankings.

The server limits each IP to three comparisons per minute. There is no lifetime tab limit. Keep existing palettes available when a new comparison is rate-limited. Use an OpenRouter key budget for the owner's overall spend ceiling.

After backend changes, run `node --test ask-worker/*.test.mjs` and the Worker build. For a direct API deployment preserve existing secrets and include both `ASK_LIMIT` and `PALETTE_LIMIT` bindings. Verify a mood such as `moss after rain`, including actual provider, token count, and cost when reported. In the browser check comparison previews, progressive recoloring, another ASCII mode, Restore, and mobile layout. Recoloring changes the current cell colors while preserving glyphs, density, positions, missing cells, and colored mechanics' backdrops.

## Direct ASCII generation

Generate uses `assets/portrait-generate.js`, `assets/ascii-contract.mjs`, and the bridge in `assets/portrait.js`. `/ascii/generate` and `/ascii/judge` are implemented in `ask-worker/ascii.mjs`. Deployment needs `ASCII_LIMIT` alongside the other rate bindings and both existing API secrets. Generation permits three requests per minute; judging has a separate three-request key in the same limiter. There is no tab lifetime cap.

The model writes all 50 rows of 75 characters. Validate the exact alphabet and lengths; never pad, crop, substitute preset art, or convert a generated raster into the output. Preserve failed attempts and their raw output. Schema support does not imply visual quality. The allowlisted generation models have a 8,192-token output cap, the existing provider price ceiling, bounded streaming, and a request deadline. Inkling uses minimal reasoning, GLM low reasoning, and Qwen reasoning off; retain the actual settings in exported runs.

The browser renders validated rows into a 375 px PNG. Jev receives that rendering and the visitor brief, with parallel Score questions for brief match and visual coherence. Scores are positions on a 0–3 rubric, not correctness probabilities. Keep the generator's identity out of the judging state. Retain probability distributions, rubrics, prompts, raw output, and reported usage in the downloadable run. A failed judge must not invalidate a usable generated grid or acquire a fabricated score.

Refine is a feedback prompt using a previous grid and its Jev scores; it is not a DSPy or weight-space optimization run. Label it accordingly. Live attempts demonstrate behavior on those inputs; do not claim held-out improvement from one revision. Broader optimization needs separate practice and held-out briefs.

Run `node --test ask-worker/*.test.mjs assets/portrait-fire.test.mjs` and the Worker build after backend changes. Check generation, judging, refinement, loading prior attempts, Restore, and mobile layout. New grids must remain usable by the existing ASCII mechanics. Bump the portrait entry script version when imports change so cached modules do not leave new controls bound to old code.
