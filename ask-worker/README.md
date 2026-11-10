# Ask about Cameron

The GitHub Pages panel shows two labeled sample answers using the public `cv.md`. Set the panel’s `data-endpoint` in `index.html` to a deployed Worker’s HTTPS `/ask` URL to enable free-form questions. The Worker uses Jev to rank CV passages and returns up to two excerpts. Questions with no passage above the relevance threshold get a no-answer result.

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

The endpoint accepts only short JSON questions and rate-limits calls using Cloudflare’s visitor IP header. Cloudflare’s limiter applies per location. The Worker fetches the published CV and forwards the question and candidate passages to TypeSafe.
