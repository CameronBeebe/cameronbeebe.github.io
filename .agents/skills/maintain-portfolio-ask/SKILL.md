---
name: maintain-portfolio-ask
description: Maintain Ask more and the Perceive portrait experiment on cameronbeebe.github.io. Use for changes to search, visual judgments, indexed sources, or the Cloudflare Worker, including testing and deployment.
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

## Portrait perception

The Perceive mode uses `assets/portrait-perception.js` and the portrait bridge in `assets/portrait.js`. The same Worker serves `/portrait` through `ask-worker/portrait.mjs`, using the existing secret and rate limiter. Run both Worker test files after changes.

The browser sends the current rendered ASCII or raw grid, optional reference/context, and bounded demo interactions only when the visitor requests a judgment. Human marks and model overlays stay out of the captured image. Patch scores represent regions, and image/Box judgments are experimental. Check comparison, crop, prediction/erasure/restore, next-action outlines, and mobile panel placement in the preview.
