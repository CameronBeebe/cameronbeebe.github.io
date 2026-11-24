import { createWorld } from "./regulator.js";

const $ = (id) => document.getElementById(id);

const SPEED_STEPS = [0.5, 1, 2, 5, 10, 20];
const SPEED_LABELS = [
  "0.5 steps/sec",
  "1 step/sec",
  "2 steps/sec",
  "5 steps/sec",
  "10 steps/sec",
  "20 steps/sec",
];
const DEFAULT_SPEED_INDEX = 2; // 2 steps/sec
const CHART_MAX_POINTS = 360;

function parseGoals(text) {
  const goals = new Set();
  for (const part of String(text).split(/[, ]+/)) {
    if (part === "") continue;
    const n = Number(part);
    if (!Number.isInteger(n)) continue;
    goals.add(n);
  }
  return goals;
}

function fmt(x, digits = 3) {
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(digits);
}

function randomSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] >>> 0;
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

function settingsFromForm(seed) {
  const size = Math.max(2, Math.min(16, Number($("size").value) || 10));
  const goals = parseGoals($("goals").value);
  if (goals.size === 0) goals.add(3);
  const alphaMode = $("dist").value === "uniform" ? "uniform" : "toy";
  return {
    seed: seed >>> 0,
    nRows: size,
    nCols: size,
    range: 10,
    goals,
    alphaMode,
  };
}

function newSession() {
  const cfg = settingsFromForm(randomSeed());
  console.log("Ashby demo seed:", cfg.seed);
  $("size").value = String(cfg.nRows);
  $("goals").value = [...cfg.goals].sort((a, b) => a - b).join(", ");
  const world = createWorld(cfg);
  return {
    world,
    history: [],
    lastRecorded: 0,
  };
}

let session = null;
let selectedCondRow = 0;
let running = false;
let raf = 0;
let lastTs = 0;
let carry = 0;

function speedIndex() {
  const i = Number($("speed").value);
  if (!Number.isInteger(i)) return DEFAULT_SPEED_INDEX;
  return Math.max(0, Math.min(SPEED_STEPS.length - 1, i));
}

function stepsPerSecond() {
  return SPEED_STEPS[speedIndex()];
}

function recordHistory() {
  const { world, history } = session;
  const w = world.windowRates();
  const t = world.state.epoch;
  if (t === session.lastRecorded && history.length) return;
  history.push({ t, blind: w.blind, cond: w.cond, n: w.n });
  session.lastRecorded = t;
  if (history.length > CHART_MAX_POINTS) {
    const compact = [];
    for (let i = 0; i < history.length; i += 2) {
      compact.push(history[i]);
    }
    session.history = compact;
  }
}

function renderMatrix() {
  const svg = $("matrix");
  const { game, goals, lastD, lastBlindAction, lastCondAction, nRows, nCols, dist } =
    session.world.state;
  const left = 36;
  const top = 22;
  const cell = Math.max(16, Math.min(32, Math.floor(320 / Math.max(nRows, nCols))));
  const width = left + nCols * cell + 10;
  const height = top + nRows * cell + 10;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `${nRows} by ${nCols} payoff matrix. Goal values: ${[...goals].join(", ")}. Current disturbance row ${lastD + 1}.`,
  );

  let parts = [];
  for (let c = 0; c < nCols; c++) {
    const x = left + c * cell + cell / 2;
    parts.push(`<text x="${x}" y="14" text-anchor="middle" class="h">${c + 1}</text>`);
  }
  for (let d = 0; d < nRows; d++) {
    const y = top + d * cell;
    const barW = Math.max(2, dist[d] * 28);
    parts.push(`<rect class="pbar" x="${left - 8 - barW}" y="${y + cell * 0.25}" width="${barW}" height="${cell * 0.5}" />`);
    parts.push(`<text x="2" y="${y + cell * 0.7}" class="h">${d + 1}</text>`);
    if (d === lastD && session.world.state.epoch > 0) {
      parts.push(
        `<rect class="row-hl" x="${left - 1}" y="${y - 1}" width="${nCols * cell + 2}" height="${cell + 2}" />`,
      );
    }
    for (let c = 0; c < nCols; c++) {
      const x = left + c * cell;
      const v = game[d][c];
      const isGoal = goals.has(v);
      parts.push(
        `<rect class="cell${isGoal ? " goal" : ""}" x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" />`,
      );
      parts.push(
        `<text x="${x + cell / 2}" y="${y + cell * 0.68}" text-anchor="middle" class="v${isGoal ? " goal" : ""}">${v}</text>`,
      );
    }
  }
  if (session.world.state.epoch > 0) {
    const y = top + lastD * cell;
    const bx = left + lastBlindAction * cell;
    const cx = left + lastCondAction * cell;
    if (lastBlindAction === lastCondAction) {
      parts.push(
        `<rect class="pick both" x="${bx + 2}" y="${y + 2}" width="${cell - 4}" height="${cell - 4}" />`,
      );
    } else {
      parts.push(
        `<rect class="pick blind" x="${bx + 2}" y="${y + 2}" width="${cell - 4}" height="${cell - 4}" />`,
      );
      parts.push(
        `<rect class="pick cond" x="${cx + 2}" y="${y + 2}" width="${cell - 4}" height="${cell - 4}" />`,
      );
    }
  }
  svg.innerHTML = parts.join("");
}

function polyline(points, x0, y0, w, h, maxT) {
  if (!points.length) return "";
  const maxY = 1;
  const coords = points
    .map((p) => {
      const x = x0 + (p.t / Math.max(maxT, 1)) * w;
      const y = y0 + h - (p.y / maxY) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return coords;
}

function renderChart() {
  const svg = $("chart");
  const { bounds: b, epoch } = session.world.state;
  const hist = session.history;
  const x0 = 36,
    y0 = 10,
    w = 420,
    h = 170;
  const width = 580,
    height = 210;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const maxT = Math.max(epoch, 500);
  const yOf = (v) => y0 + h - v * h;

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  let grid = "";
  for (const t of ticks) {
    const y = yOf(t);
    grid += `<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" class="grid" />`;
    grid += `<text x="${x0 - 6}" y="${y + 3}" text-anchor="end" class="tick">${t.toFixed(2)}</text>`;
  }

  const boundLines = `
    <line x1="${x0}" y1="${yOf(b.blindOptimum)}" x2="${x0 + w}" y2="${yOf(b.blindOptimum)}" class="bound-blind" />
    <line x1="${x0}" y1="${yOf(b.requisiteVariety)}" x2="${x0 + w}" y2="${yOf(b.requisiteVariety)}" class="bound-rv" />
    <text x="${x0 + w + 4}" y="${yOf(b.blindOptimum) + 3}" class="bound-lbl">blind ${fmt(b.blindOptimum)}</text>
    <text x="${x0 + w + 4}" y="${yOf(b.requisiteVariety) + 3}" class="bound-lbl rv">RV ${fmt(b.requisiteVariety)}</text>
  `;

  const maxTUsed = maxT;
  const blindPts = polyline(
    hist.map((p) => ({ t: p.t, y: p.blind })),
    x0,
    y0,
    w,
    h,
    maxTUsed,
  );
  const condPts = polyline(
    hist.map((p) => ({ t: p.t, y: p.cond })),
    x0,
    y0,
    w,
    h,
    maxTUsed,
  );

  const xLabel = `<text x="${x0 + w / 2}" y="${height - 4}" text-anchor="middle" class="tick">epoch ${epoch.toLocaleString()}</text>`;

  svg.innerHTML = `
    ${grid}
    <rect class="frame" x="${x0}" y="${y0}" width="${w}" height="${h}" />
    ${boundLines}
    ${blindPts ? `<polyline class="line-blind" points="${blindPts}" />` : ""}
    ${condPts ? `<polyline class="line-cond" points="${condPts}" />` : ""}
    ${xLabel}
  `;
}

function showPickHighlight() {
  return !running || stepsPerSecond() <= 4;
}

function defaultCondRow() {
  const solvable = session?.world?.state?.bounds?.rowSolvable;
  if (!solvable) return 0;
  const i = solvable.findIndex(Boolean);
  return i >= 0 ? i : 0;
}

function renderUrn(el, urn, pick, nCols) {
  const max = Math.max(...urn, 1e-9);
  if (el.children.length !== nCols) {
    const rows = [];
    for (let c = 0; c < nCols; c++) {
      rows.push(`
      <div class="urn-row">
        <span class="col">${c + 1}</span>
        <div class="bar" aria-hidden="true"><span></span></div>
        <span class="wt">0</span>
      </div>`);
    }
    el.innerHTML = rows.join("");
  }
  const highlight = showPickHighlight();
  for (let c = 0; c < nCols; c++) {
    const row = el.children[c];
    const pct = (urn[c] / max) * 100;
    row.classList.toggle("is-pick", highlight && c === pick);
    row.querySelector(".bar > span").style.width = `${pct.toFixed(1)}%`;
    row.querySelector(".wt").textContent = fmt(urn[c], 1);
  }
}

function renderMinis() {
  const st = session.world.state;
  const el = $("mini-urns");
  if (selectedCondRow >= st.nRows) selectedCondRow = defaultCondRow();
  if (el.children.length !== st.nRows) {
    const parts = [];
    for (let i = 0; i < st.nRows; i++) {
      parts.push(`<button type="button" class="mini-urn" data-row="${i}"></button>`);
    }
    el.innerHTML = parts.join("");
  }
  for (let i = 0; i < st.nRows; i++) {
    const btn = el.children[i];
    const solvable = st.bounds.rowSolvable[i];
    const selected = i === selectedCondRow;
    btn.className = [
      "mini-urn",
      solvable ? "is-solvable" : "is-dead",
      selected ? "is-selected" : "",
    ].join(" ");
    btn.setAttribute("aria-pressed", selected ? "true" : "false");
    const note = solvable ? "" : ", no goal in this row";
    btn.setAttribute("aria-label", `Disturbance ${i + 1}${note}`);
    btn.title = `Row ${i + 1}${solvable ? "" : " (no goal in this row)"}`;
  }
}

function renderLearners() {
  const st = session.world.state;
  const win = session.world.windowRates();
  const all = session.world.overallRates();
  const b = st.bounds;

  $("blind-rate").textContent = fmt(win.blind);
  $("cond-rate").textContent = fmt(win.cond);
  $("blind-meta").textContent =
    `last ${win.n || st.window} · overall ${fmt(all.blind)} · bound ${fmt(b.blindOptimum)}`;
  $("cond-meta").textContent =
    `last ${win.n || st.window} · overall ${fmt(all.cond)} · bound ${fmt(b.requisiteVariety)}`;

  const pickB = st.epoch ? st.lastBlindAction : -1;
  renderUrn($("blind-urn"), st.blind.urns[0], pickB, st.nCols);

  const d = selectedCondRow;
  $("cond-urn-label").textContent = st.bounds.rowSolvable[d]
    ? `Urn for disturbance ${d + 1}. Click a square to inspect another.`
    : `Urn for disturbance ${d + 1} — this row has no goal, so it is never reinforced.`;
  const pickC = st.epoch && st.lastD === d ? st.lastCondAction : -1;
  renderUrn($("cond-urn"), st.cond.urns[d], pickC, st.nCols);
  renderMinis();
}

function renderAll() {
  renderMatrix();
  renderChart();
  renderLearners();
}

function stepAndDraw(n) {
  session.world.step(n);
  recordHistory();
  renderAll();
}

function setRunning(on) {
  running = on;
  const btn = $("play");
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.textContent = on ? "Pause" : "Play";
  btn.classList.toggle("primary", on);
  if (on) {
    lastTs = 0;
    carry = 0;
    if (!raf) raf = requestAnimationFrame(tick);
  }
}

function tick(ts) {
  raf = requestAnimationFrame(tick);
  if (!running) {
    lastTs = ts;
    return;
  }
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  carry += dt * stepsPerSecond();
  const n = Math.min(Math.floor(carry), 25000);
  if (n > 0) {
    carry -= n;
    stepAndDraw(n);
  }
}

function startRandomGame() {
  session = newSession();
  selectedCondRow = defaultCondRow();
  renderAll();
}

function syncSpeedLabel() {
  const label = SPEED_LABELS[speedIndex()];
  $("speed-read").textContent = label;
  $("speed").setAttribute("aria-valuetext", label);
}

function init() {
  $("size").value = "10";
  $("goals").value = "3";
  $("dist").value = "toy";
  $("speed").value = String(DEFAULT_SPEED_INDEX);
  $("speed").max = String(SPEED_STEPS.length - 1);
  syncSpeedLabel();

  session = newSession();
  selectedCondRow = defaultCondRow();
  renderAll();

  $("play").addEventListener("click", () => setRunning(!running));
  $("step").addEventListener("click", () => {
    setRunning(false);
    stepAndDraw(1);
  });
  $("newgame").addEventListener("click", () => {
    setRunning(false);
    startRandomGame();
  });
  $("mini-urns").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-row]");
    if (!btn) return;
    const i = Number(btn.dataset.row);
    if (!Number.isInteger(i)) return;
    selectedCondRow = i;
    renderLearners();
  });
  $("speed").addEventListener("input", syncSpeedLabel);
  for (const id of ["size", "goals", "dist"]) {
    $(id).addEventListener("change", () => {
      setRunning(false);
      startRandomGame();
    });
  }

  document.addEventListener("keydown", (ev) => {
    if (ev.target && ["INPUT", "SELECT", "TEXTAREA"].includes(ev.target.tagName)) return;
    if (ev.code === "Space") {
      ev.preventDefault();
      setRunning(!running);
    } else if (ev.key === ".") {
      ev.preventDefault();
      setRunning(false);
      stepAndDraw(1);
    }
  });

  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (!reduce) setRunning(true);

  raf = requestAnimationFrame(tick);
}


init();

// Headless / browser-test hook. Not used by the page UI.
window.__ashby = {
  getState() {
    const st = session.world.state;
    return {
      seed: st.seed,
      epoch: st.epoch,
      bounds: {
        blindOptimum: st.bounds.blindOptimum,
        requisiteVariety: st.bounds.requisiteVariety,
      },
      window: session.world.windowRates(),
      overall: session.world.overallRates(),
    };
  },
  pause() {
    setRunning(false);
  },
  step(n) {
    setRunning(false);
    stepAndDraw(n);
  },
};
