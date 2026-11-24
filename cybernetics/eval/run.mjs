#!/usr/bin/env node
/**
 * Ashby policy eval: one structured-output call per model per game,
 * then score frozen distributions on the urns' disturbance stream.
 *
 * Usage:
 *   node cybernetics/eval/run.mjs
 *   node cybernetics/eval/run.mjs --dry-run
 *   node cybernetics/eval/run.mjs --seeds 2021,1,7 --epochs 5000 --max-spend 1
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, dirichlet, makeRng, toyAlpha, uniformAlpha } from "../regulator.js";
import { oraclePolicy, runStream, uniformPolicy, worldConfig } from "./harness.mjs";
import { argmax } from "./score.mjs";
import {
  Budget,
  describeProviders,
  fetchHaikuPolicy,
  fetchJevPolicy,
  mockPolicy,
  redact,
} from "./providers.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    seeds: [2021, 1, 7],
    epochs: 5000,
    late: 1000,
    size: 10,
    goals: [3],
    alphaMode: "toy",
    maxSpend: 1,
    dryRun: false,
    models: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--seeds") out.seeds = next().split(",").map(Number);
    else if (a === "--epochs") out.epochs = Number(next());
    else if (a === "--late") out.late = Number(next());
    else if (a === "--size") out.size = Number(next());
    else if (a === "--goals") out.goals = next().split(",").map(Number);
    else if (a === "--dist") out.alphaMode = next();
    else if (a === "--max-spend") out.maxSpend = Number(next());
    else if (a === "--models") out.models = next().split(",").map((s) => s.trim());
    else if (a === "--out") out.out = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function peekBoard({ seed, nRows, nCols, range, alphaMode }) {
  const rng = makeRng(seed);
  const game = createGame(nRows, nCols, range, rng);
  const alpha = alphaMode === "uniform" ? uniformAlpha(nRows) : toyAlpha(nRows);
  const dist = dirichlet(alpha, rng);
  return { game, dist };
}

function mean(rows, key) {
  const xs = rows.map((r) => r[key]).filter((x) => x != null && Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(x, d = 3) {
  if (x == null || !Number.isFinite(x)) return "—";
  return x.toFixed(d);
}

export function formatTable(summary, boundsMean) {
  const names = Object.keys(summary);
  const header = [
    "policy",
    "argmax",
    "sampled",
    "logloss",
    "kl",
    "brier",
    "gapRV",
    "lateArgmax",
  ];
  const lines = [header.join("\t")];
  if (boundsMean) {
    lines.push(
      ["bound-RV", fmt(boundsMean.requisiteVariety), "—", "—", "—", "—", "0", "—"].join("\t"),
    );
    lines.push(
      ["bound-blind", fmt(boundsMean.blindOptimum), "—", "—", "—", "—", "—", "—"].join("\t"),
    );
  }
  for (const name of names) {
    const s = summary[name];
    lines.push(
      [
        name,
        fmt(s.argmaxHit),
        fmt(s.sampledHit),
        fmt(s.logLoss),
        fmt(s.kl),
        fmt(s.brier),
        fmt(s.gapToRv),
        fmt(s.lateArgmaxHit),
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

async function policyFor(id, ctx) {
  if (id === "oracle") {
    return { id, ...oraclePolicy(ctx.game, ctx.goals), costUsd: 0, model: "oracle" };
  }
  if (id === "uniform") {
    return {
      id,
      ...uniformPolicy(ctx.nRows, ctx.nCols),
      costUsd: 0,
      model: "uniform",
    };
  }
  if (id === "mock") {
    return { id, ...mockPolicy(ctx.game, ctx.goals, { noise: 0.15, rng: makeRng(ctx.seed) }) };
  }
  if (id === "jev") return { id, ...(await fetchJevPolicy(ctx)) };
  if (id === "haiku") return { id, ...(await fetchHaikuPolicy(ctx)) };
  throw new Error(`unknown model id: ${id}`);
}

export async function runEval(args) {
  const cfg = worldConfig({
    nRows: args.size,
    nCols: args.size,
    goals: args.goals,
    alphaMode: args.alphaMode,
    epochs: args.epochs,
    late: args.late,
  });
  const described = describeProviders();
  for (const s of described.skipped) console.log(s.reason);

  let requested;
  if (args.dryRun) {
    requested = args.models ?? ["mock", "oracle"];
  } else {
    const paid = described.listed.filter((p) => p.paid && p.available).map((p) => p.id);
    requested = args.models ?? [...paid, "oracle"];
    if (paid.length === 0 && !args.models) {
      console.log("No paid provider keys found; running a dry-run with the mock provider.");
      requested = ["mock", "oracle"];
      args.dryRun = true;
    }
  }

  const budget = new Budget(args.maxSpend);
  const games = [];
  const providersRun = new Set();
  const providersSkipped = [];
  const skipSeen = new Set();

  for (const seed of args.seeds) {
    const { game } = peekBoard({
      seed,
      nRows: cfg.nRows,
      nCols: cfg.nCols,
      range: cfg.range,
      alphaMode: cfg.alphaMode,
    });
    const paidRemaining = requested.filter((id) => id === "jev" || id === "haiku").length;
    const reserve = Math.min(0.2, Math.max(0.03, budget.remaining() / Math.max(1, paidRemaining * 2)));

    const fetched = {};
    for (const id of requested) {
      const result = await policyFor(id, {
        game,
        goals: cfg.goals,
        seed,
        nRows: cfg.nRows,
        nCols: cfg.nCols,
        budget,
        reserveUsd: reserve,
      });
      if (result.skipped) {
        if (!skipSeen.has(id)) {
          providersSkipped.push({ id, reason: result.reason });
          skipSeen.add(id);
          console.log(result.reason);
        }
        continue;
      }
      providersRun.add(id);
      fetched[id] = result;
      if (result.error) {
        console.log(`provider ${id} seed ${seed} failed: ${redact(result.error)}`);
      } else if (result.failures?.length) {
        console.log(
          `provider ${id} seed ${seed}: ${result.failures.length} row failure(s), renormalized where possible`,
        );
      }
    }

    const policies = {};
    const fetchMeta = {};
    for (const [id, result] of Object.entries(fetched)) {
      policies[id] = { rows: result.rows };
      fetchMeta[id] = {
        valid: result.valid,
        failures: result.failures,
        renormalizedRows: result.renormalizedRows,
        costUsd: result.costUsd ?? 0,
        latencyMs: result.latencyMs ?? null,
        model: result.model ?? id,
        transport: result.transport ?? null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        error: result.error ?? null,
        ok: result.ok ?? result.valid,
        rows: result.rows,
        argmaxPerRow: result.rows.map((row) => argmax(row)),
      };
    }

    const streamed = runStream({
      seed,
      nRows: cfg.nRows,
      nCols: cfg.nCols,
      range: cfg.range,
      goals: cfg.goals,
      alphaMode: cfg.alphaMode,
      epochs: cfg.epochs,
      late: cfg.late,
      policies,
    });

    for (const [id, meta] of Object.entries(fetchMeta)) {
      Object.assign(streamed.policies[id], meta);
    }
    // Don't persist the raw matrix in the committed results unless useful;
    // keep bounds and config. The matrix can be rebuilt from the seed.
    delete streamed.game;
    delete streamed.dist;
    games.push(streamed);
  }

  const policyNames = new Set();
  for (const g of games) {
    for (const name of Object.keys(g.policies)) policyNames.add(name);
  }
  const summary = {};
  for (const name of policyNames) {
    const rows = games.map((g) => g.policies[name]).filter(Boolean);
    summary[name] = {
      argmaxHit: mean(rows, "argmaxHit"),
      sampledHit: mean(rows, "sampledHit"),
      logLoss: mean(rows, "logLoss"),
      kl: mean(rows, "kl"),
      brier: mean(rows, "brier"),
      gapToRv: mean(rows, "gapToRv"),
      lateArgmaxHit: mean(rows, "lateArgmaxHit"),
      lateSampledHit: mean(rows, "lateSampledHit"),
      costUsd: rows.reduce((a, r) => a + (r.costUsd || 0), 0),
    };
  }
  const boundsMean = {
    requisiteVariety: mean(games.map((g) => g.bounds), "requisiteVariety"),
    blindOptimum: mean(games.map((g) => g.bounds), "blindOptimum"),
  };

  const result = {
    created: new Date().toISOString(),
    dryRun: Boolean(args.dryRun),
    config: {
      seeds: args.seeds,
      epochs: cfg.epochs,
      late: cfg.late,
      size: [cfg.nRows, cfg.nCols],
      goals: [...cfg.goals].sort((a, b) => a - b),
      alphaMode: cfg.alphaMode,
      maxSpendUsd: args.maxSpend,
    },
    spendUsd: budget.spentUsd,
    budgetStop: budget.stopReason,
    providersRequested: requested,
    providersRun: [...providersRun],
    providersSkipped: [
      ...described.skipped,
      ...providersSkipped,
    ],
    boundsMean,
    summary,
    games,
    spendLog: budget.entries,
  };
  return result;
}

function defaultOutPath(dryRun) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
  const name = dryRun ? `dry-run-${stamp}.json` : `eval-${stamp}.json`;
  return path.join(DIR, "results", name);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node cybernetics/eval/run.mjs [options]
  --dry-run          local mock + oracle only (no API calls)
  --seeds 2021,1,7
  --epochs 5000
  --late 1000
  --size 10
  --goals 3
  --max-spend 1
  --models jev,haiku,oracle
  --out path.json`);
    return;
  }
  const result = await runEval(args);
  const outPath = args.out
    ? path.resolve(args.out)
    : defaultOutPath(result.dryRun);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log("");
  console.log(formatTable(result.summary, result.boundsMean));
  console.log("");
  console.log(`dryRun=${result.dryRun}  spendUsd=${result.spendUsd.toFixed(6)}  cap=${result.config.maxSpendUsd}`);
  console.log(`providersRun=${result.providersRun.join(",") || "(none)"}`);
  console.log(`wrote ${outPath}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(redact(err.stack || err.message));
    process.exit(1);
  });
}
