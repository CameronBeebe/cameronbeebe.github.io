# Ask about Cameron

The GitHub Pages panel sends free-form questions to the Worker URL in its `data-endpoint` attribute. The Suggestions dropdown fills the editable question field. With an empty endpoint the panel shows two labeled sample answers using the public `cv.md`.

The Worker reads the published CV on each lookup, subject to the source cache. It groups Markdown subheadings with their body text and splits top-level section content into paragraphs and bullets. All structured CV passages and the LMU dissertation abstract go to Jev.

GitHub metadata and README passages are grouped by repository, with the recent repository list in its own group. The Worker fetches default-branch README files directly and uses the README API to locate other names or paths. It selects prose from the introduction and later sections within the first 24,000 characters, up to seven passages per README.

Jev routes across repository previews and the complete extracted text of each PDF chapter. It receives each chapter as one question where it fits. Longer chapters are sent in consecutive parts, with the highest part score used for the chapter. The Worker keeps the four highest-scoring groups, splits the selected chapters into short passages, and ranks those alongside repository, CV, and LMU abstract passages. Independent judgments are batched within the context budget, with up to four requests running in parallel per pass. The page shows the top match and lets readers expand the next two.

## Research corpus

`research-sources.json` lists the public [LMU dissertation](https://edoc.ub.uni-muenchen.de/28655/), [arXiv quantum-circuits paper](https://arxiv.org/abs/1606.06799), [PhilSci-Archive Bayesian confirmation preprint](https://philsci-archive.pitt.edu/23020/), and [master’s thesis](https://github.com/CameronBeebe/analog_physics/blob/main/BeebeFMMPCC.pdf). The indexer uses bookmarks or numbered headings, records the page of each text fragment, and skips acknowledgements, marked tables of contents, and references while retaining abstracts. It expects selectable text. Figures and scanned pages require a separate extraction method.

Chapter 3 of the dissertation is the expanded version of Model-Based Computation. It provides an open source for that work.

From the repository root, run `uv run --with pymupdf python ask-worker/index-research.py` before testing or deploying. It downloads the listed PDFs with curl and writes `research-index.generated.json`, which Wrangler bundles into the Worker. The generated corpus stays out of Git and GitHub Pages. To build from local PDFs, pass one `--pdf FILE PDF_URL LABEL TITLE` argument group per document. Ranked PDF passages are capped at 750 characters and cite the page where each passage begins.

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
