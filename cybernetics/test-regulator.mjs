/**
 * Node checks for the Ashby regulator port.
 * Run from this folder: node test-regulator.mjs
 */
import assert from "node:assert/strict";
import {
  bounds,
  simulate,
  createWorld,
  PROP01_REFERENCE,
} from "./regulator.js";

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

check("bounds on a hand-crafted game", () => {
  const game = [
    [3, 0, 0],
    [0, 3, 0],
    [0, 0, 0],
  ];
  const goals = new Set([3]);
  const dist = [0.5, 0.3, 0.2];
  const b = bounds(game, goals, dist);
  assert.equal(b.blindOptimum, 0.5);
  assert.equal(b.bestColumn, 0);
  assert.equal(b.requisiteVariety, 0.8);
  assert.deepEqual(b.rowSolvable, [true, true, false]);
});

check("createWorld steps and shares one disturbance stream", () => {
  const w = createWorld({ seed: 7, nRows: 4, nCols: 4 });
  w.step(1);
  assert.equal(w.state.epoch, 1);
  assert.ok(w.state.lastD >= 0 && w.state.lastD < 4);
  // Same step updates both regulators.
  assert.equal(w.state.blindSuccesses + (1 - w.state.lastBlindHit), 1);
  assert.equal(w.state.condSuccesses + (1 - w.state.lastCondHit), 1);
});

check("hand game: conditioned approaches RV; blind stays at or below blind opt", () => {
  const goals = new Set([1]);
  const game = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const dist = [1 / 3, 1 / 3, 1 / 3];
  const b = bounds(game, goals, dist);
  assert.ok(Math.abs(b.blindOptimum - 1 / 3) < 1e-12);
  assert.ok(Math.abs(b.requisiteVariety - 1) < 1e-12);
  const r = simulate({
    seed: 1,
    game,
    dist,
    goals,
    epochs: 8000,
    late: 2000,
  });
  assert.ok(
    r.lateCond >= 1 - 0.05,
    `conditioned ${r.lateCond.toFixed(3)} should approach RV bound 1`,
  );
  assert.ok(
    r.lateBlind <= 1 / 3 + 0.05,
    `blind ${r.lateBlind.toFixed(3)} should stay at or below 1/3`,
  );
});

const LATE_TOL = 0.06;
const SEEDS = [2021, 1, 2, 7, 11, 42, 99, 128, 256, 1024];
const results = [];

check("PROP-01 regime: conditioned near RV bound; blind at or below blind optimum", () => {
  for (const seed of SEEDS) {
    const r = simulate({
      seed,
      nRows: 10,
      nCols: 10,
      range: 10,
      goals: new Set([PROP01_REFERENCE.goal]),
      epochs: PROP01_REFERENCE.epochs,
      late: PROP01_REFERENCE.last,
    });
    results.push({ seed, ...r.bounds, lateBlind: r.lateBlind, lateCond: r.lateCond });
    // Sampling noise around a learned policy.
    assert.ok(
      r.lateCond >= r.bounds.requisiteVariety - LATE_TOL,
      `seed ${seed}: conditioned late success ${r.lateCond.toFixed(3)} ` +
        `should approach RV bound ${r.bounds.requisiteVariety.toFixed(3)}`,
    );
    assert.ok(
      r.lateBlind <= r.bounds.blindOptimum + LATE_TOL,
      `seed ${seed}: blind late success ${r.lateBlind.toFixed(3)} ` +
        `should stay at or below blind optimum ${r.bounds.blindOptimum.toFixed(3)}`,
    );
    const gap = r.bounds.requisiteVariety - r.bounds.blindOptimum;
    if (gap >= 0.15) {
      assert.ok(
        r.lateCond > r.lateBlind + 0.05,
        `seed ${seed}: expected a visible gap (cond ${r.lateCond.toFixed(3)} ` +
          `vs blind ${r.lateBlind.toFixed(3)}, bound gap ${gap.toFixed(3)})`,
      );
    }
  }
});

check("createWorld(seed) matches simulate(seed) overall counts for a short run", () => {
  const seed = 2021;
  const epochs = 2000;
  const sim = simulate({ seed, epochs, late: 500 });
  const w = createWorld({ seed });
  w.step(epochs);
  assert.equal(w.state.epoch, epochs);
  assert.equal(w.state.blindSuccesses, sim.blindSuccesses);
  assert.equal(w.state.condSuccesses, sim.condSuccesses);
});

console.log("\nLate-window results (last 5k of 20k, 10×10, goal {3}):");
console.log(
  "seed  blindOpt  RVbound  lateBlind  lateCond  gap",
);
for (const r of results) {
  console.log(
    String(r.seed).padStart(5),
    r.blindOptimum.toFixed(3).padStart(8),
    r.requisiteVariety.toFixed(3).padStart(8),
    r.lateBlind.toFixed(3).padStart(9),
    r.lateCond.toFixed(3).padStart(9),
    (r.requisiteVariety - r.blindOptimum).toFixed(3).padStart(6),
  );
}
if (results.length) {
  const mean = (key) => results.reduce((a, r) => a + r[key], 0) / results.length;
  console.log(
    "mean ",
    mean("blindOptimum").toFixed(3).padStart(8),
    mean("requisiteVariety").toFixed(3).padStart(8),
    mean("lateBlind").toFixed(3).padStart(9),
    mean("lateCond").toFixed(3).padStart(9),
  );
  console.log(
    "PROP-01 reference: Ashby 0.249, blind opt 0.301, RV 0.603 (numpy RNG; not expected to match exactly).",
  );
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
