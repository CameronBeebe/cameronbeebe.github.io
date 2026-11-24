/**
 * Run frozen per-row policies on the same seeded disturbance stream
 * as the urn learners in regulator.js (same RNG order as createWorld).
 */
import {
  bounds,
  createGame,
  createRegulator,
  createWorld,
  dirichlet,
  makeRng,
  sampleCategorical,
  toyAlpha,
  uniformAlpha,
} from "../regulator.js";
import {
  argmax,
  brier,
  emptyTally,
  finishTally,
  klDivergence,
  logLoss,
  recordStep,
  targetDistribution,
} from "./score.mjs";

export function worldConfig(opts = {}) {
  return {
    seed: opts.seed ?? 2021,
    nRows: opts.nRows ?? 10,
    nCols: opts.nCols ?? 10,
    range: opts.range ?? 10,
    goals: opts.goals instanceof Set ? opts.goals : new Set(opts.goals ?? [3]),
    alphaMode: opts.alphaMode ?? "toy",
    epochs: opts.epochs ?? 5000,
    late: opts.late ?? 1000,
  };
}

/**
 * @param {Record<string, { rows: number[][] }>} policies
 *   Frozen policies keyed by name, each with a validated nRows x nCols
 *   distribution (already renormalized).
 */
export function runStream(opts = {}) {
  const cfg = worldConfig(opts);
  const { seed, nRows, nCols, range, goals, alphaMode, epochs, late } = cfg;
  const policies = opts.policies ?? {};
  const sampleSeed = opts.sampleSeed ?? ((seed ^ 0xa5a5a5a5) >>> 0);

  const rng = makeRng(seed);
  const game = createGame(nRows, nCols, range, rng);
  const alpha = alphaMode === "uniform" ? uniformAlpha(nRows) : toyAlpha(nRows);
  const dist = dirichlet(alpha, rng);
  const b = bounds(game, goals, dist);
  const blind = createRegulator(nRows, nCols, rng, {
    conditioned: false,
    initialWeight: 1,
  });
  const cond = createRegulator(nRows, nCols, rng, {
    conditioned: true,
    initialWeight: 1,
  });
  const sampleRng = makeRng(sampleSeed);

  const names = ["urn-blind", "urn-cond", ...Object.keys(policies)];
  const tallies = Object.fromEntries(names.map((n) => [n, emptyTally()]));

  const lateStart = Math.max(0, epochs - late);
  for (let t = 0; t < epochs; t++) {
    const d = sampleCategorical(dist, rng);
    const q = targetDistribution(game[d], goals);
    const isLate = t >= lateStart;

    const pBlind = blind.probs(d);
    const pCond = cond.probs(d);
    const aBlind = blind.act(d, rng);
    const aCond = cond.act(d, rng);
    const sBlind = blind.update(d, aBlind, game[d][aBlind], goals);
    const sCond = cond.update(d, aCond, game[d][aCond], goals);

    scorePolicy(tallies["urn-blind"], pBlind, q, goals, game[d], sampleRng, isLate, {
      forcedSampledHit: sBlind,
    });
    scorePolicy(tallies["urn-cond"], pCond, q, goals, game[d], sampleRng, isLate, {
      forcedSampledHit: sCond,
    });

    for (const [name, policy] of Object.entries(policies)) {
      const p = policy.rows[d];
      scorePolicy(tallies[name], p, q, goals, game[d], sampleRng, isLate, {});
    }
  }

  const results = {};
  for (const name of names) {
    results[name] = finishTally(tallies[name], epochs, b.requisiteVariety);
  }

  return {
    seed,
    sampleSeed,
    nRows,
    nCols,
    range,
    goals: [...goals].sort((a, b) => a - b),
    alphaMode,
    epochs,
    late,
    game,
    dist,
    bounds: {
      blindOptimum: b.blindOptimum,
      requisiteVariety: b.requisiteVariety,
      bestColumn: b.bestColumn,
      rowSolvable: b.rowSolvable,
    },
    policies: results,
  };
}

function scorePolicy(tally, p, q, goals, row, sampleRng, late, { forcedSampledHit }) {
  const aMax = argmax(p);
  const hitArgmax = goals.has(row[aMax]) ? 1 : 0;
  let hitSampled;
  if (forcedSampledHit != null) {
    hitSampled = forcedSampledHit;
  } else {
    const aSamp = sampleCategorical(p, sampleRng);
    hitSampled = goals.has(row[aSamp]) ? 1 : 0;
  }
  const ll = q ? logLoss(p, q) : null;
  const kl = q ? klDivergence(p, q) : null;
  const br = q ? brier(p, q) : null;
  recordStep(tally, {
    hitArgmax,
    hitSampled,
    logLoss: ll,
    kl,
    brier: br,
    late,
  });
}

/** Confirm this stream's urn counts match createWorld for the same seed. */
export function urnCountsMatchCreateWorld(seed = 2021, epochs = 400) {
  const streamed = runStream({ seed, epochs, late: Math.min(100, epochs), policies: {} });
  const world = createWorld({
    seed,
    nRows: streamed.nRows,
    nCols: streamed.nCols,
    range: streamed.range,
    goals: new Set(streamed.goals),
    alphaMode: streamed.alphaMode,
  });
  world.step(epochs);
  return {
    ok:
      world.state.blindSuccesses ===
        Math.round(streamed.policies["urn-blind"].sampledHit * epochs) &&
      world.state.condSuccesses ===
        Math.round(streamed.policies["urn-cond"].sampledHit * epochs),
    worldBlind: world.state.blindSuccesses,
    streamBlind: Math.round(streamed.policies["urn-blind"].sampledHit * epochs),
    worldCond: world.state.condSuccesses,
    streamCond: Math.round(streamed.policies["urn-cond"].sampledHit * epochs),
  };
}

export function oraclePolicy(game, goals) {
  const rows = game.map((row) => {
    const q = targetDistribution(row, goals);
    if (q) return q;
    return Array.from({ length: row.length }, () => 1 / row.length);
  });
  return { rows, valid: true, failures: [], renormalizedRows: [] };
}

export function uniformPolicy(nRows, nCols) {
  const row = Array.from({ length: nCols }, () => 1 / nCols);
  return {
    rows: Array.from({ length: nRows }, () => row.slice()),
    valid: true,
    failures: [],
    renormalizedRows: [],
  };
}
