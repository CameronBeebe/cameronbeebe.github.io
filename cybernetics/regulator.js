/**
 * Ashby's regulation game: a Pólya-urn regulator against a payoff matrix.
 *
 * Port of the 2021 toy in CameronBeebe/Cybernetics (cybernetics.py, train.py,
 * regulators.py). The original Ashby class uses one urn and never sees the
 * disturbance. This module also implements a disturbance-conditioned regulator
 * (one urn per row) and the two bounds measured in extracted-intent PR #4.
 *
 * Canonical copy: docs/ in https://github.com/CameronBeebe/Cybernetics
 * No DOM here — this file is safe to import from Node.
 */

/** Reference experiment from PROP-01 (extracted-intent PR #4). */
export const PROP01_REFERENCE = {
  meanSuccess: 0.249,
  blindOptimum: 0.301,
  requisiteVariety: 0.603,
  seeds: 10,
  size: [10, 10],
  goal: 3,
  epochs: 20000,
  last: 5000,
};

/**
 * Seeded PRNG (Mulberry32). Returns floats in [0, 1) and ints in [0, n).
 * @param {number} seed
 */
export function makeRng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  const random = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random,
    /** Uniform integer in [0, n). */
    int(n) {
      return Math.floor(random() * n);
    },
  };
}

/** Gamma(k, 1) for positive integer k, via k exponential(1) draws. */
function gammaInteger(k, rng) {
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const u = rng.random();
    sum += -Math.log(1 - u);
  }
  return sum;
}

/**
 * Dirichlet sample. `alpha` is a vector of positive integers (the 2021 toy
 * used α = 1..n, i.e. later rows more likely).
 * @param {number[]} alpha
 * @param {ReturnType<typeof makeRng>} rng
 */
export function dirichlet(alpha, rng) {
  const g = alpha.map((a) => gammaInteger(a, rng));
  const total = g.reduce((acc, x) => acc + x, 0);
  return g.map((x) => x / total);
}

export function uniformAlpha(n) {
  return Array.from({ length: n }, () => 1);
}

/** α = 1, 2, …, n — matches `np.random.dirichlet(alpha=game.index)` in train.py. */
export function toyAlpha(n) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * @param {number} nRows
 * @param {number} nCols
 * @param {number} range  entries are integers in [0, range)
 * @param {ReturnType<typeof makeRng>} rng
 * @returns {number[][]}
 */
export function createGame(nRows, nCols, range, rng) {
  const game = [];
  for (let d = 0; d < nRows; d++) {
    const row = [];
    for (let c = 0; c < nCols; c++) row.push(rng.int(range));
    game.push(row);
  }
  return game;
}

/**
 * @param {number[]} probs  assumed to sum to 1
 * @param {ReturnType<typeof makeRng>} rng
 */
export function sampleCategorical(probs, rng) {
  let u = rng.random();
  for (let i = 0; i < probs.length; i++) {
    u -= probs[i];
    if (u < 0) return i;
  }
  return probs.length - 1;
}

export function normalize(weights) {
  const total = weights.reduce((acc, x) => acc + x, 0);
  if (total <= 0) return weights.map(() => 1 / weights.length);
  return weights.map((x) => x / total);
}

/**
 * Blind optimum: the best success rate any single column can get.
 * Requisite-variety bound: the best success rate if the regulator sees D
 * and may pick a (possibly different) column per row.
 *
 * @param {number[][]} game
 * @param {Set<number>} goals
 * @param {number[]} dist
 */
export function bounds(game, goals, dist) {
  const nRows = game.length;
  const nCols = game[0].length;
  let blindOptimum = 0;
  let bestColumn = 0;
  for (let c = 0; c < nCols; c++) {
    let success = 0;
    for (let d = 0; d < nRows; d++) {
      if (goals.has(game[d][c])) success += dist[d];
    }
    if (success > blindOptimum) {
      blindOptimum = success;
      bestColumn = c;
    }
  }
  let requisiteVariety = 0;
  const rowSolvable = [];
  for (let d = 0; d < nRows; d++) {
    const ok = game[d].some((v) => goals.has(v));
    rowSolvable.push(ok);
    if (ok) requisiteVariety += dist[d];
  }
  return { blindOptimum, requisiteVariety, bestColumn, rowSolvable };
}

/**
 * Pólya-urn regulator. If `conditioned` is true, one urn per disturbance;
 * otherwise a single urn that never sees the row (the 2021 Ashby class).
 *
 * Reinforcement on success is +sqrt(nActions), matching update() in
 * cybernetics.py / regulators.py. The 2021 toy filled urns with
 * randint(0, 100), which converges slowly on rare disturbances. The
 * demo starts each action at `initialWeight` (default 1) so a short
 * run can reach the bound; the update rule is otherwise unchanged.
 */
export function createRegulator(nRows, nActions, rng, { conditioned, initialWeight = 1 } = {}) {
  const boost = Math.sqrt(nActions);
  const w0 = initialWeight;
  const freshUrn = () => {
    const urn = Array.from({ length: nActions }, () => w0);
    if (urn.every((w) => w === 0)) urn[0] = 1;
    return urn;
  };
  const urns = conditioned
    ? Array.from({ length: nRows }, freshUrn)
    : [freshUrn()];

  const urnFor = (d) => (conditioned ? urns[d] : urns[0]);

  return {
    conditioned,
    urns,
    probs(d) {
      return normalize(urnFor(d));
    },
    act(d, actionRng) {
      return sampleCategorical(normalize(urnFor(d)), actionRng);
    },
    /** @returns {0|1} */
    update(d, action, outcome, goals) {
      if (goals.has(outcome)) {
        urnFor(d)[action] += boost;
        return 1;
      }
      return 0;
    },
  };
}

/**
 * Run both regulators on one game, sharing the disturbance stream.
 *
 * @returns {{
 *   game: number[][],
 *   dist: number[],
 *   bounds: ReturnType<typeof bounds>,
 *   blindSuccesses: number,
 *   condSuccesses: number,
 *   lateBlind: number,
 *   lateCond: number,
 *   epochs: number,
 * }}
 */
export function simulate({
  seed = 2021,
  nRows = 10,
  nCols = 10,
  range = 10,
  goals = new Set([3]),
  epochs = 20000,
  late = 5000,
  alpha = null,
  game: givenGame = null,
  dist: givenDist = null,
  initialWeight = 1,
} = {}) {
  const rng = makeRng(seed);
  const game = givenGame ?? createGame(nRows, nCols, range, rng);
  const dist = givenDist ?? dirichlet(alpha ?? toyAlpha(game.length), rng);
  const b = bounds(game, goals, dist);
  const nR = game.length;
  const nC = game[0].length;
  const blind = createRegulator(nR, nC, rng, { conditioned: false, initialWeight });
  const cond = createRegulator(nR, nC, rng, { conditioned: true, initialWeight });

  let blindSuccesses = 0;
  let condSuccesses = 0;
  let lateBlind = 0;
  let lateCond = 0;
  const lateStart = Math.max(0, epochs - late);

  for (let t = 0; t < epochs; t++) {
    const d = sampleCategorical(dist, rng);
    const aBlind = blind.act(d, rng);
    const aCond = cond.act(d, rng);
    const sBlind = blind.update(d, aBlind, game[d][aBlind], goals);
    const sCond = cond.update(d, aCond, game[d][aCond], goals);
    blindSuccesses += sBlind;
    condSuccesses += sCond;
    if (t >= lateStart) {
      lateBlind += sBlind;
      lateCond += sCond;
    }
  }

  const lateN = epochs - lateStart;
  return {
    game,
    dist,
    bounds: b,
    blindSuccesses,
    condSuccesses,
    lateBlind: lateBlind / lateN,
    lateCond: lateCond / lateN,
    overallBlind: blindSuccesses / epochs,
    overallCond: condSuccesses / epochs,
    epochs,
    late,
  };
}

/**
 * Build the mutable state a UI (or test) steps through. Same RNG order as
 * `simulate`, so a given seed is reproducible.
 */
export function createWorld({
  seed = 2021,
  nRows = 10,
  nCols = 10,
  range = 10,
  goals = new Set([3]),
  alphaMode = "toy",
} = {}) {
  const rng = makeRng(seed);
  const game = createGame(nRows, nCols, range, rng);
  const alpha = alphaMode === "uniform" ? uniformAlpha(nRows) : toyAlpha(nRows);
  const dist = dirichlet(alpha, rng);
  const b = bounds(game, goals, dist);
  const blind = createRegulator(nRows, nCols, rng, { conditioned: false, initialWeight: 1 });
  const cond = createRegulator(nRows, nCols, rng, { conditioned: true, initialWeight: 1 });

  const state = {
    seed,
    nRows,
    nCols,
    range,
    goals,
    alphaMode,
    game,
    dist,
    bounds: b,
    blind,
    cond,
    epoch: 0,
    blindSuccesses: 0,
    condSuccesses: 0,
    lastD: 0,
    lastBlindAction: 0,
    lastCondAction: 0,
    lastBlindHit: 0,
    lastCondHit: 0,
    /** Ring buffer of recent {blind, cond} hits, for a sliding window. */
    recent: [],
    recentBlind: 0,
    recentCond: 0,
    window: 500,
  };

  const pushRecent = (sBlind, sCond) => {
    state.recent.push({ b: sBlind, c: sCond });
    state.recentBlind += sBlind;
    state.recentCond += sCond;
    if (state.recent.length > state.window) {
      const old = state.recent.shift();
      state.recentBlind -= old.b;
      state.recentCond -= old.c;
    }
  };

  const stepOnce = () => {
    const d = sampleCategorical(dist, rng);
    const aBlind = blind.act(d, rng);
    const aCond = cond.act(d, rng);
    const sBlind = blind.update(d, aBlind, game[d][aBlind], goals);
    const sCond = cond.update(d, aCond, game[d][aCond], goals);
    state.epoch += 1;
    state.blindSuccesses += sBlind;
    state.condSuccesses += sCond;
    state.lastD = d;
    state.lastBlindAction = aBlind;
    state.lastCondAction = aCond;
    state.lastBlindHit = sBlind;
    state.lastCondHit = sCond;
    pushRecent(sBlind, sCond);
  };

  return {
    state,
    step(n = 1) {
      const cap = Math.max(0, n | 0);
      for (let i = 0; i < cap; i++) stepOnce();
    },
    windowRates() {
      const n = state.recent.length;
      if (n === 0) return { blind: 0, cond: 0, n: 0 };
      return {
        blind: state.recentBlind / n,
        cond: state.recentCond / n,
        n,
      };
    },
    overallRates() {
      if (state.epoch === 0) return { blind: 0, cond: 0 };
      return {
        blind: state.blindSuccesses / state.epoch,
        cond: state.condSuccesses / state.epoch,
      };
    },
  };
}
