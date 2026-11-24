/**
 * Scoring and validation for a frozen per-row action distribution.
 *
 * Target, on a solvable row: uniform over columns whose payoff is a goal.
 * Unsolvable rows (no goal in the row) are skipped for log loss and Brier;
 * argmax / sampled hits are still counted (they cannot succeed).
 */

export const LOG_EPS = 1e-15;

/** Lowest index wins ties. */
export function argmax(weights) {
  let best = 0;
  for (let i = 1; i < weights.length; i++) {
    if (weights[i] > weights[best]) best = i;
  }
  return best;
}

export function winningColumns(row, goals) {
  const winners = [];
  for (let c = 0; c < row.length; c++) {
    if (goals.has(row[c])) winners.push(c);
  }
  return winners;
}

/** Uniform over winning columns, or null if the row has no goal. */
export function targetDistribution(row, goals) {
  const winners = winningColumns(row, goals);
  if (winners.length === 0) return null;
  const q = Array.from({ length: row.length }, () => 0);
  const mass = 1 / winners.length;
  for (const c of winners) q[c] = mass;
  return q;
}

/** Shannon entropy of q: -sum_c q_c log q_c. */
export function entropy(q) {
  let sum = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] > 0) sum -= q[i] * Math.log(q[i]);
  }
  return sum;
}

/** Cross-entropy of target q under forecast p: -sum_c q_c log p_c. */
export function logLoss(p, q) {
  if (!p || !q || p.length !== q.length) {
    throw new Error("logLoss: p and q must be equal-length vectors");
  }
  let sum = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] > 0) sum -= q[i] * Math.log(Math.max(p[i], LOG_EPS));
  }
  return sum;
}

/** KL(q || p) = logLoss(p, q) - H(q). Zero when p equals q. */
export function klDivergence(p, q) {
  return logLoss(p, q) - entropy(q);
}

/** Brier / quadratic score: sum_c (p_c - q_c)^2. */
export function brier(p, q) {
  if (!p || !q || p.length !== q.length) {
    throw new Error("brier: p and q must be equal-length vectors");
  }
  let sum = 0;
  for (let i = 0; i < q.length; i++) {
    const d = p[i] - q[i];
    sum += d * d;
  }
  return sum;
}

function asRows(raw, nRows, nCols) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.rows)) return raw.rows;
  if (raw && typeof raw === "object") {
    const rows = [];
    for (let d = 0; d < nRows; d++) {
      const key =
        raw[`row${d + 1}`] ??
        raw[`row_${d + 1}`] ??
        raw[`row_${d}`] ??
        raw[String(d)] ??
        raw[String(d + 1)];
      if (key === undefined) return null;
      rows.push(key);
    }
    return rows;
  }
  return null;
}

function asVector(raw, nCols) {
  if (Array.isArray(raw)) return raw.map(Number);
  if (raw && typeof raw === "object") {
    const vec = [];
    for (let c = 0; c < nCols; c++) {
      const v =
        raw[`c${c + 1}`] ??
        raw[`col${c + 1}`] ??
        raw[`column${c + 1}`] ??
        raw[String(c)] ??
        raw[String(c + 1)];
      if (v === undefined) return { error: `missing column ${c + 1}` };
      vec.push(Number(v));
    }
    return vec;
  }
  return { error: "not an array or column map" };
}

/**
 * Validate a per-row policy and renormalize each row to sum to 1.
 * Invalid rows fall back to uniform and are listed in `failures`.
 */
export function validateAndRenormalize(raw, nRows, nCols) {
  const failures = [];
  const renormalizedRows = [];
  const rows = [];
  const extracted = asRows(raw, nRows, nCols);
  if (!extracted || extracted.length !== nRows) {
    const uniform = Array.from({ length: nCols }, () => 1 / nCols);
    for (let d = 0; d < nRows; d++) {
      rows.push(uniform.slice());
      renormalizedRows.push(d);
      failures.push({
        row: d,
        reason: extracted
          ? `expected ${nRows} rows, got ${extracted.length}`
          : "could not parse a rows array or row_1.. map",
      });
    }
    return { rows, failures, renormalizedRows, valid: false };
  }

  for (let d = 0; d < nRows; d++) {
    const vec = asVector(extracted[d], nCols);
    if (!Array.isArray(vec)) {
      rows.push(Array.from({ length: nCols }, () => 1 / nCols));
      renormalizedRows.push(d);
      failures.push({ row: d, reason: vec.error || "invalid row" });
      continue;
    }
    if (vec.length !== nCols) {
      rows.push(Array.from({ length: nCols }, () => 1 / nCols));
      renormalizedRows.push(d);
      failures.push({
        row: d,
        reason: `expected ${nCols} columns, got ${vec.length}`,
      });
      continue;
    }
    if (vec.some((x) => !Number.isFinite(x))) {
      rows.push(Array.from({ length: nCols }, () => 1 / nCols));
      renormalizedRows.push(d);
      failures.push({ row: d, reason: "non-finite weight" });
      continue;
    }
    if (vec.some((x) => x < 0)) {
      rows.push(Array.from({ length: nCols }, () => 1 / nCols));
      renormalizedRows.push(d);
      failures.push({ row: d, reason: "negative weight" });
      continue;
    }
    const total = vec.reduce((a, x) => a + x, 0);
    if (total <= 0) {
      rows.push(Array.from({ length: nCols }, () => 1 / nCols));
      renormalizedRows.push(d);
      failures.push({ row: d, reason: "weights sum to 0" });
      continue;
    }
    const norm = vec.map((x) => x / total);
    rows.push(norm);
    if (Math.abs(total - 1) > 1e-9) renormalizedRows.push(d);
  }

  return {
    rows,
    failures,
    renormalizedRows,
    valid: failures.length === 0,
  };
}

export function emptyTally() {
  return {
    hitsArgmax: 0,
    hitsSampled: 0,
    logLossSum: 0,
    klSum: 0,
    brierSum: 0,
    scored: 0,
    lateHitsArgmax: 0,
    lateHitsSampled: 0,
    lateLogLossSum: 0,
    lateKlSum: 0,
    lateBrierSum: 0,
    lateScored: 0,
    lateN: 0,
  };
}

export function recordStep(tally, { hitArgmax, hitSampled, logLoss: ll, kl, brier: br, late }) {
  tally.hitsArgmax += hitArgmax;
  tally.hitsSampled += hitSampled;
  if (ll != null) {
    tally.logLossSum += ll;
    tally.klSum += kl;
    tally.brierSum += br;
    tally.scored += 1;
  }
  if (late) {
    tally.lateN += 1;
    tally.lateHitsArgmax += hitArgmax;
    tally.lateHitsSampled += hitSampled;
    if (ll != null) {
      tally.lateLogLossSum += ll;
      tally.lateKlSum += kl;
      tally.lateBrierSum += br;
      tally.lateScored += 1;
    }
  }
}

export function finishTally(tally, epochs, requisiteVariety) {
  const hitArgmax = tally.hitsArgmax / epochs;
  const hitSampled = tally.hitsSampled / epochs;
  return {
    argmaxHit: hitArgmax,
    sampledHit: hitSampled,
    logLoss: tally.scored ? tally.logLossSum / tally.scored : null,
    kl: tally.scored ? tally.klSum / tally.scored : null,
    brier: tally.scored ? tally.brierSum / tally.scored : null,
    scoredSteps: tally.scored,
    lateArgmaxHit: tally.lateN ? tally.lateHitsArgmax / tally.lateN : null,
    lateSampledHit: tally.lateN ? tally.lateHitsSampled / tally.lateN : null,
    lateLogLoss: tally.lateScored ? tally.lateLogLossSum / tally.lateScored : null,
    lateKl: tally.lateScored ? tally.lateKlSum / tally.lateScored : null,
    lateBrier: tally.lateScored ? tally.lateBrierSum / tally.lateScored : null,
    lateScoredSteps: tally.lateScored,
    gapToRv: requisiteVariety - hitArgmax,
    lateGapToRv:
      tally.lateN && requisiteVariety != null
        ? requisiteVariety - tally.lateHitsArgmax / tally.lateN
        : null,
  };
}
