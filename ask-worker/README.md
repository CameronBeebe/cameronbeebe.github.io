# Ask about Cameron

The GitHub Pages panel sends free-form questions to the Worker URL in its `data-endpoint` attribute. With an empty endpoint it shows two labeled sample answers using the public `cv.md`.

The Worker reads the published CV on each lookup, subject to the source cache. It groups Markdown subheadings with their body text and splits top-level section content into paragraphs and bullets. All structured CV passages and the LMU dissertation abstract go to Jev.

GitHub metadata and README passages are grouped by repository, with the recent repository list in its own group. The Worker fetches default-branch README files directly and uses the README API to locate other names or paths. It selects prose from the introduction and later sections within the first 24,000 characters, up to seven passages per README.

The search also includes page-linked PDF excerpts and short publication summaries with links. Jev routes among repository and research groups using their titles, section names, and short previews. The Worker keeps the four highest-scoring groups and ranks their passages alongside the CV and LMU abstract. The page shows the top match and lets readers expand the next two.

## Research corpus

`research-index.json` contains opening passages from chapters and sections of the public [LMU dissertation](https://edoc.ub.uni-muenchen.de/28655/), [arXiv quantum-circuits paper](https://arxiv.org/abs/1606.06799), and [PhilSci-Archive Bayesian confirmation preprint](https://philsci-archive.pitt.edu/23020/). Jev receives chapter previews for routing and excerpts from the selected chapters for ranking. Each excerpt links to the page where its section begins.

To rebuild, download the public PDFs and run `uv run --with pymupdf python ask-worker/index-research.py --output ask-worker/research-index.json`. Add one `--pdf FILE PDF_URL LABEL TITLE` argument group per document. The script uses bookmarks or numbered headings and expects selectable text. Review the generated excerpts and page links before deploying. Publication summaries in `sources.mjs` cover additional titles and link to their records.

## Local development

Run the tests from the repository root with `node --test ask-worker/worker.test.mjs`. The local homepage uses the deployed Worker by default when an endpoint is configured.

To test against a local Worker, put `TYPESAFE_API_KEY` in a private environment file outside the repository and the directory served by the preview. Run Wrangler and open the localhost page with `?live-ask#ask-cameron` to override the deployed endpoint.

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
