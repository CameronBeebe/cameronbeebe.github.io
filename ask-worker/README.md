# Ask about Cameron

The GitHub Pages panel shows two labeled sample answers using the public `cv.md`. Set the panel’s `data-endpoint` in `index.html` to a deployed Worker’s HTTPS `/ask` URL to enable free-form questions.

The Worker reads the published CV on each lookup, subject to the source cache. It groups Markdown subheadings with their body text and splits top-level section content into paragraphs and bullets. All structured CV passages and the LMU dissertation abstract go to Jev.

GitHub metadata and README passages are grouped by repository, with the recent repository list in its own group. If more than four groups are available, Jev scores each group using its heading and short text previews. The Worker keeps the four highest-scoring groups, then asks Jev to rank their full passages alongside the CV and abstract. With four or fewer groups, the Worker goes directly to passage ranking.

The page shows the top three excerpts with links and their passage-level match probabilities, even when the scores are low. The displayed text comes from the sources.

## Local development

Run the tests from the repository root with `node --test ask-worker/worker.test.mjs`. The default local homepage shows the sample mode without a Worker or API key.

For live local testing, put `TYPESAFE_API_KEY` in a private environment file outside the repository and the directory served by the preview. Run Wrangler and open the localhost page with `?live-ask#ask-cameron`.

```sh
npx wrangler dev --config ask-worker/wrangler.toml --port 8787 --env-file /path/to/private/ask-worker.env
```

## Enable live questions on GitHub Pages

1. Create a dedicated TypeSafe API key. Use prepaid credits with auto-recharge off to bound inference spend.
2. Deploy the Worker from the repository root and add the key as a Worker secret. Wrangler prompts for the value.

   ```sh
   npx wrangler deploy --config ask-worker/wrangler.toml
   npx wrangler secret put TYPESAFE_API_KEY --config ask-worker/wrangler.toml
   ```

3. Set `data-endpoint` in `index.html` to the Worker URL with `/ask` appended, then publish the static page.

The endpoint accepts only short JSON questions and rate-limits calls using Cloudflare’s visitor IP header. Cloudflare’s limiter applies per location. The Worker forwards the question and selected public passages to TypeSafe. Source URLs are fixed in `sources.mjs`, which also defines the featured README list. Fetches use a 15-minute cache on Cloudflare. The Worker can rank available passages when a source fails to load or yields no passages.
