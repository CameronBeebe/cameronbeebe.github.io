# Ashby regulator demo

A static, self-contained page: a Pólya-urn regulator learns against disturbances in Ashby’s regulation game. A **blind** regulator (the 2021 toy: one urn, no view of the disturbance) runs next to a **disturbance-conditioned** regulator (one urn per row), so the law of requisite variety is visible as a gap between two bounds computed from the on-screen game.

**Canonical source:** this `docs/` folder in [CameronBeebe/Cybernetics](https://github.com/CameronBeebe/Cybernetics). The copy at [cameronbeebe.github.io/cybernetics](https://cameronbeebe.github.io/cybernetics/) is an identical mirror. Paths inside the folder are relative; there is no build step. The page can later be served from sciphi.pro without changes.

## Run locally

ES modules will not load from a `file://` URL in most browsers. From this folder:

```bash
python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/

## Logic tests

```bash
node test-regulator.mjs
```

The checks include a hand-crafted game and ten seeded 10×10 runs in the PROP-01 regime (goal `{3}`, last 5,000 of 20,000 epochs). The conditioned regulator should approach the requisite-variety bound; the blind regulator should stay at or below the blind optimum.

The on-page demo picks a random seed when a game starts and logs it to the console. Seed `2021` is one such game, with a large gap between the two bounds.

## Notes

- Reinforcement on success is \(+\sqrt{|R|}\), matching `update()` in the 2021 Python. Urns start at weight 1 rather than `randint(0, 100)`, so rare disturbances can reach the bound in a short run.
- Enabling GitHub Pages from `/docs` on `master` of this repository (so the demo is also at `https://cameronbeebe.github.io/Cybernetics/`) is a separate step and needs an explicit yes; opening a PR does not turn Pages on.

## Model policy eval

A separate, non-UI eval lives in [`eval/`](eval/). It asks a model for one
frozen per-row action distribution per game and scores it against the urn
learners and the requisite-variety bound. It does not change this page.

