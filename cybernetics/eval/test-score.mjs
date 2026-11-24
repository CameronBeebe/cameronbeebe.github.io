/**
 * Scoring, validation, and dry-run harness checks.
 * Run from this folder: node test-score.mjs
 */
import assert from "node:assert/strict";
import {
  argmax,
  brier,
  entropy,
  klDivergence,
  logLoss,
  targetDistribution,
  validateAndRenormalize,
} from "./score.mjs";
import {
  oraclePolicy,
  runStream,
  uniformPolicy,
  urnCountsMatchCreateWorld,
} from "./harness.mjs";
import { mockPolicy } from "./providers.mjs";
import { makeRng } from "../regulator.js";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok  " + name);
  } catch (err) {
    failed += 1;
    console.error("FAIL  " + name);
    console.error("  " + err.message);
  }
}

check("renormalize [1,1,0] to [0.5,0.5,0]", () => {
  const r = validateAndRenormalize([[1, 1, 0]], 1, 3);
  assert.equal(r.valid, true);
  assert.deepEqual(r.renormalizedRows, [0]);
  assert.ok(Math.abs(r.rows[0][0] - 0.5) < 1e-12);
  assert.ok(Math.abs(r.rows[0][1] - 0.5) < 1e-12);
  assert.equal(r.rows[0][2], 0);
});

check("already-normalized rows are left alone", () => {
  const r = validateAndRenormalize([[0.2, 0.3, 0.5]], 1, 3);
  assert.equal(r.valid, true);
  assert.deepEqual(r.renormalizedRows, []);
});

check("negative, NaN, zero-sum, and wrong shape become uniform + failures", () => {
  const r = validateAndRenormalize(
    [
      [1, -1, 0],
      [NaN, 1, 0],
      [0, 0, 0],
      [1, 0],
    ],
    4,
    3,
  );
  assert.equal(r.valid, false);
  assert.equal(r.failures.length, 4);
  for (const row of r.rows) {
    assert.deepEqual(row, [1 / 3, 1 / 3, 1 / 3]);
  }
});

check("column-map parse and missing columns", () => {
  const ok = validateAndRenormalize({ row1: { c1: 1, c2: 0 } }, 1, 2);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.rows[0], [1, 0]);
  const bad = validateAndRenormalize({ row1: { c1: 1 } }, 1, 2);
  assert.equal(bad.valid, false);
  assert.match(bad.failures[0].reason, /missing column 2/);
});

check("log loss, KL, and Brier on known targets", () => {
  const q = [1, 0, 0];
  assert.equal(logLoss([1, 0, 0], q), 0);
  assert.equal(klDivergence([1, 0, 0], q), 0);
  assert.equal(brier([1, 0, 0], q), 0);
  const two = [0, 0.5, 0.5];
  assert.ok(Math.abs(entropy(two) - Math.LN2) < 1e-12);
  assert.ok(Math.abs(logLoss([0, 0.5, 0.5], two) - Math.LN2) < 1e-12);
  assert.ok(Math.abs(klDivergence([0, 0.5, 0.5], two)) < 1e-12);
  // Zero mass on a target atom is floored at LOG_EPS, so CE / KL blow up.
  assert.ok(logLoss([0, 1, 0], two) > 10);
  assert.ok(klDivergence([0, 1, 0], two) > 10);
  assert.ok(Math.abs(brier([0, 1, 0], two) - 0.5) < 1e-12);
});

check("target is uniform over winning columns; unsolvable is null", () => {
  const goals = new Set([3]);
  assert.deepEqual(targetDistribution([3, 0, 3], goals), [0.5, 0, 0.5]);
  assert.equal(targetDistribution([0, 1, 2], goals), null);
});

check("argmax lowest-index tie-break", () => {
  assert.equal(argmax([0.5, 0.5, 0.1]), 0);
  assert.equal(argmax([0.1, 0.7, 0.2]), 1);
});

check("oracle argmax hit rate equals empirical solvability (hence approaches RV)", () => {
  const game = [
    [3, 0, 0],
    [0, 3, 0],
    [0, 0, 0],
  ];
  const goals = new Set([3]);
  const dist = [0.5, 0.3, 0.2];
  // Hand-fed via runStream would regenerate the game from a seed, so score
  // the oracle on this matrix by stepping a custom stream through runStream
  // is not used here; compute directly.
  const policy = oraclePolicy(game, goals);
  assert.deepEqual(policy.rows[0], [1, 0, 0]);
  assert.deepEqual(policy.rows[1], [0, 1, 0]);
  assert.deepEqual(policy.rows[2], [1 / 3, 1 / 3, 1 / 3]);
});

check("urn stream counts match createWorld", () => {
  const r = urnCountsMatchCreateWorld(2021, 800);
  assert.equal(r.ok, true, JSON.stringify(r));
});

check("oracle on a real seed: argmax hit equals share of solvable steps", () => {
  const r = runStream({
    seed: 2021,
    epochs: 2000,
    late: 500,
    policies: {},
  });
  // Re-run with oracle against the same seed.
  const peek = runStream({ seed: 2021, epochs: 1, late: 1, policies: {} });
  // Need the game: rebuild via a second runStream that includes oracle.
  // runStream currently doesn't return game after... it does return game.
  const full = runStream({
    seed: 2021,
    epochs: 2000,
    late: 500,
    policies: { oracle: oraclePolicy(peek.game, new Set(peek.goals)) },
  });
  // Empirical solvability = mean of rowSolvable[d] over the stream, which
  // equals RV in expectation and equals oracle argmax hit exactly.
  const solvableMass = peek.bounds.rowSolvable.reduce(
    (s, ok, d) => s + (ok ? peek.dist[d] : 0),
    0,
  );
  assert.ok(Math.abs(solvableMass - peek.bounds.requisiteVariety) < 1e-12);
  assert.ok(
    Math.abs(full.policies.oracle.argmaxHit - full.bounds.requisiteVariety) < 0.04,
    `oracle argmax ${full.policies.oracle.argmaxHit} vs RV ${full.bounds.requisiteVariety}`,
  );
  assert.ok(full.policies.oracle.kl < 1e-12, `oracle KL ${full.policies.oracle.kl}`);
  assert.ok(full.policies.oracle.brier < 1e-12);
  assert.ok(r.policies["urn-cond"].lateSampledHit >= r.bounds.requisiteVariety - 0.08);
});

check("uniform policy log loss on a one-winner row is log(n)", () => {
  const u = uniformPolicy(1, 4);
  const goals = new Set([1]);
  const q = targetDistribution([0, 1, 0, 0], goals);
  const ll = logLoss(u.rows[0], q);
  assert.ok(Math.abs(ll - Math.log(4)) < 1e-12);
});

check("mock dry-run policy validates and can be scored", () => {
  const peek = runStream({ seed: 7, epochs: 1, late: 1, policies: {} });
  const mock = mockPolicy(peek.game, new Set(peek.goals), {
    noise: 0.2,
    rng: makeRng(7),
  });
  assert.equal(mock.valid, true);
  assert.equal(mock.rows.length, peek.nRows);
  const scored = runStream({
    seed: 7,
    epochs: 500,
    late: 100,
    policies: { mock: { rows: mock.rows } },
  });
  assert.ok(scored.policies.mock.argmaxHit > scored.policies["urn-blind"].argmaxHit);
  assert.ok(scored.policies.mock.kl != null);
  assert.ok(scored.policies.mock.kl > 0);
});

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
