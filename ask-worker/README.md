# Ask about Cameron

The GitHub Pages panel shows two labeled sample answers using the public `cv.md`. Set the panel’s `data-endpoint` in `index.html` to a deployed Worker’s HTTPS `/ask` URL to enable free-form questions.

The Worker reads the published CV on each lookup, subject to the source cache. It groups Markdown subheadings with their body text and splits top-level section content into paragraphs and bullets. All those passages go to Jev. The Worker also selects up to four passages from the LMU dissertation abstract and nine from GitHub repository metadata and README intros, using keyword overlap for those shortlists.

Jev judges each passage against the question in one batch. The page shows the top three excerpts with links and Jev’s estimated match probabilities, even when the scores are low. The displayed text comes from the sources.

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
