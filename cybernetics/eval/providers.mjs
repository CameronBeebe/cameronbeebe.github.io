/**
 * One structured-output call per game, returning a per-row distribution
 * over response columns. Keys are read only from the environment.
 */
import { validateAndRenormalize } from "./score.mjs";

export const JEV_INPUT_USD_PER_MTOK = 0.042;
export const HAIKU_INPUT_USD_PER_MTOK = 0.1;
export const HAIKU_OUTPUT_USD_PER_MTOK = 0.5;
export const HAIKU_OPENROUTER_MODEL = "anthropic/claude-haiku-5.5";
export const JEV_MODEL = "jev-latest";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function secretValues() {
  return [
    process.env.TYPESAFE_API_KEY,
    process.env.OPENROUTER_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ].filter((v) => v && v.length > 8);
}

export function redact(value) {
  if (value == null) return value;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secretValues()) {
    text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  text = text.replace(/x-api-key["'\s:=]+[^\s"']+/gi, "x-api-key=[redacted]");
  text = text.replace(/"user_id"\s*:\s*"[^"]*"/g, '"user_id":"[redacted]"');
  return text;
}

export class Budget {
  constructor(maxUsd = 1) {
    this.maxUsd = maxUsd;
    this.spentUsd = 0;
    this.entries = [];
    this.stopped = false;
    this.stopReason = null;
  }

  remaining() {
    return this.maxUsd - this.spentUsd;
  }

  canStart(reserveUsd) {
    if (this.stopped) return false;
    return this.spentUsd + reserveUsd <= this.maxUsd + 1e-12;
  }

  add(costUsd, meta) {
    const cost = Number(costUsd) || 0;
    this.spentUsd += cost;
    this.entries.push({ costUsd: cost, ...meta });
    if (this.spentUsd > this.maxUsd + 1e-9) {
      this.stopped = true;
      this.stopReason = `spend $${this.spentUsd.toFixed(6)} exceeded cap $${this.maxUsd}`;
    }
  }

  stop(reason) {
    this.stopped = true;
    this.stopReason = reason;
  }
}

export function describeProviders() {
  const listed = [];
  const skipped = [];

  listed.push({
    id: "mock",
    label: "mock (local, no API)",
    available: true,
    paid: false,
  });
  listed.push({
    id: "oracle",
    label: "oracle (local uniform-over-winners)",
    available: true,
    paid: false,
  });

  if (process.env.TYPESAFE_API_KEY) {
    listed.push({
      id: "jev",
      label: `Jev (${JEV_MODEL} via TypeSafe System One)`,
      available: true,
      paid: true,
    });
  } else {
    skipped.push({
      id: "jev",
      reason: "TYPESAFE_API_KEY is not set; skipping Jev",
    });
  }

  if (process.env.OPENROUTER_API_KEY) {
    listed.push({
      id: "haiku",
      label: `Haiku (${HAIKU_OPENROUTER_MODEL} via OpenRouter)`,
      available: true,
      paid: true,
      transport: "openrouter",
    });
  } else if (process.env.ANTHROPIC_API_KEY) {
    listed.push({
      id: "haiku",
      label: "Haiku (claude-haiku-5.5 via Anthropic Messages)",
      available: true,
      paid: true,
      transport: "anthropic",
    });
  } else {
    skipped.push({
      id: "haiku",
      reason:
        "OPENROUTER_API_KEY and ANTHROPIC_API_KEY are not set; skipping Haiku",
    });
  }

  return { listed, skipped };
}

function boardState(game, goals) {
  const goalList = [...goals].sort((a, b) => a - b);
  return {
    task:
      "For each disturbance, return a probability distribution over response columns. " +
      "Each distribution must be non-negative and sum to 1, like a Pólya urn over actions. " +
      "Put probability on goal_response_columns whenever that list is non-empty; " +
      "if it is empty, use a uniform distribution.",
    goal_payoff_values: goalList,
    disturbances: game.map((row, d) => ({
      disturbance: d + 1,
      payoffs: row,
      goal_response_columns: row
        .map((v, c) => (goals.has(v) ? c + 1 : null))
        .filter((c) => c != null),
    })),
  };
}

function boardPrompt(game, goals) {
  const goalList = [...goals].sort((a, b) => a - b).join(", ");
  const lines = game.map((row, d) => {
    const cells = row
      .map((v, c) => (goals.has(v) ? `${v}*` : String(v)))
      .join(", ");
    const wins = row
      .map((v, c) => (goals.has(v) ? c + 1 : null))
      .filter((c) => c != null);
    const winNote = wins.length ? ` goal columns: ${wins.join(", ")}` : " (no goal)";
    return `disturbance ${d + 1}: [${cells}]${winNote}`;
  });
  return [
    "This is Ashby's regulation game.",
    `Goal payoff values: ${goalList}.`,
    "For every disturbance row, give a probability distribution over the response columns.",
    "The distribution must be non-negative and sum to 1, like a Pólya urn over actions.",
    "Put probability on the goal columns listed for that row whenever the list is non-empty.",
    "If a row has no goal columns, use a uniform distribution.",
    "Return only the structured distribution; do not add commentary.",
    "",
    "Payoff matrix (row = disturbance, columns = responses 1..N). Goal cells are marked *:",
    ...lines,
  ].join("\n");
}

export function columnKeys(nCols) {
  return Array.from({ length: nCols }, (_, c) => `c${c + 1}`);
}

export function jevQuestions(nRows, nCols) {
  const criteria = {};
  for (let c = 0; c < nCols; c++) {
    criteria[`c${c + 1}`] = `Regulator response column ${c + 1}`;
  }
  const questions = {};
  for (let d = 0; d < nRows; d++) {
    questions[`row${d + 1}`] = {
      type: "choice",
      instructions:
        `Which response column should the regulator pick for disturbance row ${d + 1}? ` +
        "Prefer columns whose payoff is a goal value when any exist in this row.",
      criteria,
    };
  }
  return questions;
}

function parseJevAnswers(answers, nRows, nCols) {
  const raw = {};
  for (let d = 0; d < nRows; d++) {
    const ans = answers?.[`row${d + 1}`];
    raw[`row${d + 1}`] = ans?.probabilities ?? ans;
  }
  return validateAndRenormalize(raw, nRows, nCols);
}

function haikuSchema(nRows, nCols) {
  // Keep the grammar small: one array of rows, each a length-nCols vector.
  // A fully unrolled row1.c1.. object was rejected as "compiled grammar too large".
  return {
    type: "object",
    properties: {
      rows: {
        type: "array",
        description:
          `Exactly ${nRows} rows, each a distribution over ${nCols} response columns (c1..c${nCols} in order)`,
        minItems: nRows,
        maxItems: nRows,
        items: {
          type: "array",
          minItems: nCols,
          maxItems: nCols,
          items: { type: "number" },
        },
      },
    },
    required: ["rows"],
    additionalProperties: false,
  };
}

export async function requestJson(url, init, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 2000) };
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function jevCostUsd(usage) {
  const input = Number(usage?.input_tokens) || 0;
  return (input * JEV_INPUT_USD_PER_MTOK) / 1e6;
}

function openRouterCostUsd(usage) {
  const reported = usage?.cost;
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  const fallback =
    (prompt * HAIKU_INPUT_USD_PER_MTOK) / 1e6 +
    (completion * HAIKU_OUTPUT_USD_PER_MTOK) / 1e6;
  // OpenRouter `usage.cost` is in USD (typically a tiny float). Ignore
  // implausible placeholders and fall back to the published Haiku 5.5 rates.
  if (Number.isFinite(reported) && reported >= 0 && reported <= 0.5) {
    return reported;
  }
  return fallback;
}

function anthropicCostUsd(usage) {
  const prompt = Number(usage?.input_tokens) || 0;
  const completion = Number(usage?.output_tokens) || 0;
  return (
    (prompt * HAIKU_INPUT_USD_PER_MTOK) / 1e6 +
    (completion * HAIKU_OUTPUT_USD_PER_MTOK) / 1e6
  );
}

export async function fetchJevPolicy({ game, goals, budget, reserveUsd }) {
  const nRows = game.length;
  const nCols = game[0].length;
  if (!process.env.TYPESAFE_API_KEY) {
    return { skipped: true, reason: "TYPESAFE_API_KEY is not set; skipping Jev" };
  }
  if (budget && !budget.canStart(reserveUsd ?? 0.05)) {
    const reason = `Jev skipped: remaining budget $${budget.remaining().toFixed(4)} under reserve`;
    budget.stop(reason);
    return { skipped: true, reason };
  }
  const started = Date.now();
  const { ok, status, body } = await requestJson(JEV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: boardState(game, goals),
      questions: jevQuestions(nRows, nCols),
    }),
  });
  const latencyMs = Date.now() - started;
  const costUsd = jevCostUsd(body?.usage);
  if (budget) {
    budget.add(costUsd, {
      provider: "jev",
      model: body?.model ?? JEV_MODEL,
      inputTokens: body?.usage?.input_tokens ?? null,
      outputTokens: body?.usage?.output_tokens ?? null,
      latencyMs,
    });
  }
  if (!ok) {
    return {
      ok: false,
      provider: "jev",
      status,
      error: redact(body),
      costUsd,
      latencyMs,
      ...validateAndRenormalize(null, nRows, nCols),
    };
  }
  const parsed = parseJevAnswers(body.answers, nRows, nCols);
  return {
    ok: parsed.valid,
    provider: "jev",
    model: body.model ?? JEV_MODEL,
    costUsd,
    latencyMs,
    inputTokens: body.usage?.input_tokens ?? null,
    outputTokens: body.usage?.output_tokens ?? null,
    ...parsed,
  };
}

export async function fetchHaikuPolicy({ game, goals, budget, reserveUsd }) {
  const nRows = game.length;
  const nCols = game[0].length;
  if (process.env.OPENROUTER_API_KEY) {
    return fetchHaikuOpenRouter({ game, goals, budget, reserveUsd, nRows, nCols });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return fetchHaikuAnthropic({ game, goals, budget, reserveUsd, nRows, nCols });
  }
  return {
    skipped: true,
    reason:
      "OPENROUTER_API_KEY and ANTHROPIC_API_KEY are not set; skipping Haiku",
  };
}

async function fetchHaikuOpenRouter({ game, goals, budget, reserveUsd, nRows, nCols }) {
  if (budget && !budget.canStart(reserveUsd ?? 0.2)) {
    const reason = `Haiku skipped: remaining budget $${budget.remaining().toFixed(4)} under reserve`;
    budget.stop(reason);
    return { skipped: true, reason };
  }
  const schema = haikuSchema(nRows, nCols);
  const started = Date.now();
  const { ok, status, body } = await requestJson(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HAIKU_OPENROUTER_MODEL,
      messages: [
        {
          role: "user",
          content: boardPrompt(game, goals),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "urn_policy",
          strict: true,
          schema,
        },
      },
      provider: { require_parameters: true },
    }),
  });
  const latencyMs = Date.now() - started;
  const usage = body?.usage;
  const costUsd = openRouterCostUsd(usage);
  if (budget) {
    budget.add(costUsd, {
      provider: "haiku",
      transport: "openrouter",
      model: body?.model ?? HAIKU_OPENROUTER_MODEL,
      inputTokens: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
      reportedCost: usage?.cost ?? null,
      latencyMs,
    });
  }
  if (!ok) {
    return {
      ok: false,
      provider: "haiku",
      transport: "openrouter",
      status,
      error: redact(body),
      costUsd,
      latencyMs,
      ...validateAndRenormalize(null, nRows, nCols),
    };
  }
  const content = body?.choices?.[0]?.message?.content;
  let parsedJson;
  try {
    parsedJson = typeof content === "string" ? JSON.parse(content) : content;
  } catch (err) {
    return {
      ok: false,
      provider: "haiku",
      transport: "openrouter",
      error: redact(`JSON parse failed: ${err.message}`),
      costUsd,
      latencyMs,
      ...validateAndRenormalize(null, nRows, nCols),
    };
  }
  const parsed = validateAndRenormalize(parsedJson, nRows, nCols);
  return {
    ok: parsed.valid,
    provider: "haiku",
    transport: "openrouter",
    model: body?.model ?? HAIKU_OPENROUTER_MODEL,
    costUsd,
    latencyMs,
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? null,
    ...parsed,
  };
}

async function fetchHaikuAnthropic({ game, goals, budget, reserveUsd, nRows, nCols }) {
  if (budget && !budget.canStart(reserveUsd ?? 0.2)) {
    const reason = `Haiku skipped: remaining budget $${budget.remaining().toFixed(4)} under reserve`;
    budget.stop(reason);
    return { skipped: true, reason };
  }
  const schema = haikuSchema(nRows, nCols);
  const started = Date.now();
  // Official Anthropic structured-output field: output_format json_schema
  // (Messages API). If this shape is rejected, the failure is recorded and
  // no second paid guess is made.
  const { ok, status, body } = await requestJson(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-5.5",
      max_tokens: 2048,
      messages: [{ role: "user", content: boardPrompt(game, goals) }],
      output_format: {
        type: "json_schema",
        schema,
      },
    }),
  });
  const latencyMs = Date.now() - started;
  const usage = body?.usage;
  const costUsd = anthropicCostUsd(usage);
  if (budget) {
    budget.add(costUsd, {
      provider: "haiku",
      transport: "anthropic",
      model: body?.model ?? "claude-haiku-5.5",
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      latencyMs,
    });
  }
  if (!ok) {
    return {
      ok: false,
      provider: "haiku",
      transport: "anthropic",
      status,
      error: redact(body),
      costUsd,
      latencyMs,
      ...validateAndRenormalize(null, nRows, nCols),
    };
  }
  const textBlock = (body?.content ?? []).find((b) => b.type === "text" || b.type === "output_json" || b.json);
  const raw =
    textBlock?.json ??
    (typeof textBlock?.text === "string" ? JSON.parse(textBlock.text) : textBlock?.text);
  const parsed = validateAndRenormalize(raw, nRows, nCols);
  return {
    ok: parsed.valid,
    provider: "haiku",
    transport: "anthropic",
    model: body?.model ?? "claude-haiku-5.5",
    costUsd,
    latencyMs,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    ...parsed,
  };
}

/** Local mock: slightly noisy oracle, so scoring is exercised without an API. */
export function mockPolicy(game, goals, { noise = 0.15, rng } = {}) {
  const nCols = game[0].length;
  const raw = game.map((row) => {
    const winners = [];
    for (let c = 0; c < row.length; c++) if (goals.has(row[c])) winners.push(c);
    const weights = Array.from({ length: nCols }, () =>
      noise > 0 && rng ? noise * rng.random() : noise / nCols,
    );
    if (winners.length) {
      for (const c of winners) weights[c] += 1 / winners.length;
    } else {
      for (let c = 0; c < nCols; c++) weights[c] += 1 / nCols;
    }
    return weights;
  });
  return {
    provider: "mock",
    model: "mock-noisy-oracle",
    costUsd: 0,
    ...validateAndRenormalize(raw, game.length, nCols),
  };
}
