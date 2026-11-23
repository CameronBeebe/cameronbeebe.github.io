# Perplexity, cross-entropy, and bits per byte

A static, no-build explainer at `/perplexity/`. Open `index.html` over HTTP (the page fetches JSON).

- `scores.json` — measured teacher-forcing scores from GPT-2, DistilGPT-2, and SmolLM2-135M on six short passages. Computed with `scripts/compute_scores.py`.
- `char_trigram.json` — toy byte-level interpolated trigram trained on WikiText-2 raw train (`scripts/train_char_trigram.py`).
- `char_scores.json` — Python reference scores used to check the in-browser trigram.
- `demo.js` — sliders, tokenizer unit conversion, and the token visualization.

Do not treat the short-passage numbers as a WikiText or C4 leaderboard.
