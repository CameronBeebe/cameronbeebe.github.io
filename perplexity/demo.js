const LN2 = Math.log(2);
const TEST = {
  ready: false,
  errors: [],
  charChecks: [],
  gptTokenizer: "pending",
};

window.addEventListener("error", (event) => {
  TEST.errors.push(String(event.message || event.error || "error"));
});
window.addEventListener("unhandledrejection", (event) => {
  TEST.errors.push(String(event.reason || "unhandledrejection"));
});
window.__pplTest = TEST;

const MODEL_META = {
  gpt2: { label: "GPT-2 small", detail: "124.4M · GPT-2 BPE · vocab 50,257" },
  distilgpt2: { label: "DistilGPT-2", detail: "81.9M · GPT-2 BPE · vocab 50,257" },
  "smollm2-135m": { label: "SmolLM2-135M", detail: "134.5M · SmolLM2 tokenizer · vocab 49,152" },
  toy: { label: "Toy byte trigram", detail: "WikiText-2 raw train · interpolated 3-gram over UTF-8 bytes" },
};

function fmt(n, d = 3) {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === false || value == null) continue;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

function surprisalStyle(bits) {
  if (!Number.isFinite(bits)) return { color: "var(--muted)", background: "var(--well)", border: "var(--line)" };
  if (bits < 1) return { color: "#39ff14", background: "#0d3d0d", border: "#39ff14" };
  if (bits < 3) return { color: "#b8ff8a", background: "#1a3a12", border: "#7bcf4a" };
  if (bits < 6) return { color: "#c4b48a", background: "#2a2a10", border: "#8a7a4a" };
  if (bits < 10) return { color: "#e0a15a", background: "#3a2410", border: "#c4843a" };
  return { color: "#f0ae88", background: "#3a1610", border: "#f0ae88" };
}

function visibleToken(text) {
  if (text === "\n") return "↵\n";
  if (text === "\t") return "→";
  return text.replace(/ /g, "·");
}

function wordCount(text) {
  const parts = text.trim().match(/\S+/g);
  return parts ? parts.length : 0;
}

function bytesOf(text) {
  return new TextEncoder().encode(text).length;
}

function metric(label, value) {
  return el("div", { class: "metric" }, [
    el("b", { text: value }),
    el("span", { text: label }),
  ]);
}

function buildCharModel(raw) {
  const uni = new Map();
  for (const [key, value] of Object.entries(raw.unigram)) uni.set(Number(key), value);
  const bi = new Map();
  const biCtx = new Map();
  for (const [key, value] of Object.entries(raw.bigram)) {
    bi.set(key, value);
    const a = Number(key.split(",")[0]);
    biCtx.set(a, (biCtx.get(a) || 0) + value);
  }
  const tri = new Map();
  const triCtx = new Map();
  for (const [key, value] of Object.entries(raw.trigram)) {
    tri.set(key, value);
    const parts = key.split(",");
    const ctx = `${parts[0]},${parts[1]}`;
    triCtx.set(ctx, (triCtx.get(ctx) || 0) + value);
  }
  const lamTri = raw.smoothing.lambda_tri;
  const lamBi = raw.smoothing.lambda_bi;
  const lamUni = raw.smoothing.lambda_uni;
  const uniTotal = raw.unigram_total;

  function pByte(b1, b2, b3) {
    const pUni = ((uni.get(b3) || 0) + 1) / (uniTotal + 256);
    const ctx1 = biCtx.get(b2) || 0;
    const pBi = ctx1 ? (bi.get(`${b2},${b3}`) || 0) / ctx1 : 0;
    const ctx2 = triCtx.get(`${b1},${b2}`) || 0;
    const pTri = ctx2 ? (tri.get(`${b1},${b2},${b3}`) || 0) / ctx2 : 0;
    return lamTri * pTri + lamBi * pBi + lamUni * pUni;
  }

  function score(text) {
    const data = new TextEncoder().encode(text);
    const tokens = [];
    const nlls = [];
    for (let i = 0; i < data.length; i += 1) {
      const b = data[i];
      const ch = new TextDecoder("utf-8", { fatal: false }).decode(data.slice(i, i + 1));
      const entry = { text: ch, byte: b, scored: false };
      if (i >= 2) {
        const p = Math.max(pByte(data[i - 2], data[i - 1], b), 1e-15);
        const logp = Math.log(p);
        entry.scored = true;
        entry.p = p;
        entry.logp_nats = logp;
        entry.surprisal_bits = -logp / LN2;
        nlls.push(-logp);
      }
      tokens.push(entry);
    }
    const nBytes = data.length;
    const nScored = nlls.length;
    const nBytesScored = Math.max(0, nBytes - 2);
    const total = nlls.reduce((a, b) => a + b, 0);
    const ce = nScored ? total / nScored : NaN;
    return {
      n_tokens: nBytes,
      n_scored: nScored,
      n_bytes_text: nBytes,
      n_bytes_scored: nBytesScored,
      total_nll_nats: total,
      cross_entropy_nats: ce,
      bits_per_token: nScored ? ce / LN2 : NaN,
      perplexity: nScored ? Math.exp(ce) : NaN,
      bits_per_byte: nScored && nBytesScored ? total / (LN2 * nBytesScored) : NaN,
      tokens,
    };
  }

  return { score, pByte };
}

function renderK() {
  const k = Number(document.getElementById("k-slider").value);
  const bits = Math.log2(k);
  document.getElementById("k-readout").innerHTML = `k = <b>${k}</b>`;
  const box = document.getElementById("k-metrics");
  box.replaceChildren(
    metric("Perplexity", String(k)),
    metric("Bits per prediction", fmt(bits, 3)),
    metric("Cross-entropy (nats)", fmt(bits * LN2, 3)),
    metric("Average probability", fmt(1 / k, 4)),
  );
  document.getElementById("k-gloss").textContent =
    k === 1
      ? "Perplexity 1 is perfect prediction: the next token is certain, and it costs 0 bits."
      : `A uniform choice among ${k} tokens costs ${fmt(bits, 2)} bits each time. A language model with this perplexity is as uncertain, on average, as that uniform guess.`;
}

function renderScores() {
  const q = Number(document.getElementById("q-slider").value);
  const p = Number(document.getElementById("p-slider").value);
  const y = Number(document.getElementById("y-select").value);
  document.getElementById("q-out").textContent = q.toFixed(2);
  document.getElementById("p-out").textContent = p.toFixed(2);
  const logLossY = y === 1 ? -Math.log(p) : -Math.log(1 - p);
  const logLossBits = logLossY / LN2;
  const brier = (p - y) ** 2;
  const expectedLog = -q * Math.log(p) - (1 - q) * Math.log(1 - p);
  const expectedHonest = -q * Math.log(q) - (1 - q) * Math.log(1 - q);
  const regret = expectedLog - expectedHonest;
  document.getElementById("score-metrics").replaceChildren(
    metric("Log loss on the outcome (nats)", fmt(logLossY, 3)),
    metric("Log loss (bits)", fmt(logLossBits, 3)),
    metric("Brier score", fmt(brier, 4)),
    metric("Expected log loss if q is true", fmt(expectedLog, 3)),
    metric("Expected log loss if you report q", fmt(expectedHonest, 3)),
    metric("Regret for reporting p ≠ q", fmt(regret, 4)),
  );
  const honest = Math.abs(p - q) < 1e-9;
  document.getElementById("score-gloss").textContent = honest
    ? "You are reporting your true belief, so the expected log loss is as small as it can be for this q. That is what “strictly proper” means."
    : `Reporting p = ${p.toFixed(2)} while believing q = ${q.toFixed(2)} raises your expected log loss by ${fmt(regret, 4)} nats. A sharper report is not automatically better: if the event goes the other way, log loss punishes overconfidence hard.`;
}

async function loadGptTokenizer() {
  try {
    // r50k_base is the GPT-2 / GPT-3 tokenizer. The package default is o200k_base.
    const mod = await import("https://cdn.jsdelivr.net/npm/gpt-tokenizer@3.2.0/esm/encoding/r50k_base.js");
    const encode = mod.encode || (mod.default && mod.default.encode);
    if (typeof encode !== "function") throw new Error("r50k_base encode missing");
    const encodeGpt2 = (text) => encode(text);
    // Probe.
    const probe = encodeGpt2("hello world");
    if (!Array.isArray(probe) && !(probe && probe.length >= 0)) throw new Error("unexpected encode result");
    TEST.gptTokenizer = "ok";
    return (text) => {
      const ids = encodeGpt2(text);
      return ids.length;
    };
  } catch (err) {
    TEST.gptTokenizer = `unavailable: ${err}`;
    return null;
  }
}

function renderUnits(state) {
  const text = document.getElementById("text-input").value;
  const toy = state.charModel.score(text);
  const nBytes = toy.n_bytes_scored;
  const total = toy.total_nll_nats;
  const jointOk = toy.n_scored > 0;
  const presetId = state.currentId;
  const preset = presetId && state.scores.texts.find((t) => t.id === presetId);
  const isPreset = preset && preset.text === text;

  const gptTokensLive = state.gptTokenCount ? state.gptTokenCount(text) : null;
  let gptTokens = gptTokensLive;
  let smolTokens = null;
  if (isPreset) {
    const g = state.scores.scores.gpt2[presetId];
    const s = state.scores.scores["smollm2-135m"][presetId];
    if (g) gptTokens = g.n_scored; // scored tokens, matching the joint's "after the first unit" spirit? For unit conversion we want full token count of the text or scored?
    // For the bookkeeping demo we should use the full tokenizer token count of the text, or scored? The joint is over scored bytes (all but first 2). Using full token counts is a bit inconsistent. Better: use full token counts of the whole text, and use total NLL of the toy model over scored bytes, and also show byte count of scored bytes. The teaching point is the same. I'll use:
    // - scored bytes for BPB
    // - word count of full text
    // - GPT-2 token count of full text (from HF when preset, else live)
    if (g) gptTokens = g.n_tokens;
    if (s) smolTokens = s.n_tokens;
  }

  const words = wordCount(text);
  document.getElementById("unit-source").textContent = jointOk
    ? `Joint surprise is ${fmt(total, 3)} nats from the toy byte trigram on ${nBytes} scored bytes of the current text (${fmt(toy.bits_per_byte, 4)} bits per byte). The table only changes the denominator. The large per-token and per-word perplexities are this weak toy joint expressed in fewer units — not GPT-2’s own perplexity.`
    : "Type at least three bytes to obtain a joint probability from the toy trigram.";

  const rows = [
    ["UTF-8 bytes (scored)", nBytes, true],
    ["Whitespace words (full text)", words, false],
  ];
  if (gptTokens) rows.push(["GPT-2 BPE tokens (full text)", gptTokens, false]);
  if (smolTokens) rows.push(["SmolLM2 tokens (full text, this passage)", smolTokens, false]);

  const tbody = document.getElementById("unit-table");
  tbody.replaceChildren();
  const metrics = [];
  if (jointOk) {
    metrics.push(metric("Joint NLL (nats)", fmt(total, 3)));
    metrics.push(metric("Bits per byte", fmt(toy.bits_per_byte, 4)));
  }
  for (const [name, count, isByte] of rows) {
    const ppl = jointOk && count ? Math.exp(total / count) : NaN;
    const bits = jointOk && count ? total / (LN2 * count) : NaN;
    const tr = el("tr", {}, [
      el("td", { text: name }),
      el("td", { class: "num", text: String(count) }),
      el("td", { class: "num", text: fmt(ppl, 2) }),
      el("td", { class: "num", text: isByte ? fmt(toy.bits_per_byte, 4) : fmt(bits, 4) }),
    ]);
    tbody.append(tr);
    if (name.startsWith("GPT-2")) metrics.push(metric("PPL if divided by GPT-2 tokens", fmt(ppl, 2)));
    if (name.startsWith("SmolLM2")) metrics.push(metric("PPL if divided by SmolLM2 tokens", fmt(ppl, 2)));
  }
  document.getElementById("unit-metrics").replaceChildren(...metrics);
}

function tokenChip(tok) {
  const bits = tok.scored ? tok.surprisal_bits : null;
  const style = surprisalStyle(bits);
  const chip = el("span", {
    class: tok.scored ? "tok" : "tok unscored",
    tabindex: "0",
  }, [visibleToken(tok.text)]);
  chip.style.color = style.color;
  chip.style.background = style.background;
  chip.style.borderColor = style.border;
  const lines = [];
  lines.push(tok.scored
    ? `p = ${fmt(tok.p, 4)} · ${fmt(tok.surprisal_bits, 2)} bits`
    : "Not scored (no context)");
  if (tok.top && tok.top.length) {
    lines.push("Model’s top alternatives:");
    for (const alt of tok.top) {
      const mark = alt.text === tok.text ? " ← actual" : "";
      lines.push(`${JSON.stringify(alt.text)}  ${fmt(alt.p, 3)}${mark}`);
    }
  }
  chip.append(el("span", { class: "tooltip" }, lines.map((line, i) => {
    const div = el("div", { text: line });
    if (i === 0) div.style.color = "var(--accent)";
    return div;
  })));
  return chip;
}

function renderPanel(title, detail, result, disclaimer) {
  const panel = el("div", { class: "panel" });
  panel.style.boxShadow = "none";
  panel.style.margin = "0";
  panel.append(el("h3", { text: title, style: "margin-top:0" }));
  if (detail) panel.append(el("p", { class: "note", text: detail }));
  if (!result) {
    panel.append(el("p", { class: "note", text: disclaimer || "No precomputed neural scores for this text. Choose a measured passage, or use the toy byte trigram." }));
    return panel;
  }
  panel.append(el("div", { class: "metrics" }, [
    metric("Perplexity (per token)", fmt(result.perplexity, 2)),
    metric("Bits per byte", fmt(result.bits_per_byte, 4)),
    metric("Bits per token", fmt(result.bits_per_token, 3)),
    metric("Cross-entropy (nats)", fmt(result.cross_entropy_nats, 3)),
    metric("Scored tokens", String(result.n_scored)),
    metric("Scored UTF-8 bytes", String(result.n_bytes_scored)),
  ]));
  const strip = el("div", { class: "token-strip" });
  for (const tok of result.tokens) strip.append(tokenChip(tok));
  panel.append(strip);
  if (disclaimer) panel.append(el("p", { class: "note", text: disclaimer }));
  return panel;
}

function currentMode(state) {
  if (state.mode === "same") return ["gpt2", "distilgpt2"];
  if (state.mode === "diff") return ["gpt2", "smollm2-135m"];
  return ["toy"];
}

function renderPlay(state) {
  const text = document.getElementById("text-input").value;
  const status = document.getElementById("play-status");
  const presetId = state.currentId;
  const preset = presetId && state.scores.texts.find((t) => t.id === presetId);
  const isPreset = !!(preset && preset.text === text);
  const ids = currentMode(state);
  const panels = document.getElementById("play-panels");
  panels.className = ids.length > 1 ? "compare" : "compare";
  if (ids.length === 1) panels.style.gridTemplateColumns = "1fr";
  else panels.style.gridTemplateColumns = "";

  const nodes = [];
  if (ids[0] === "toy") {
    const result = state.charModel.score(text);
    nodes.push(renderPanel(MODEL_META.toy.label, MODEL_META.toy.detail, result,
      "Toy model. Useful for any text and for the unit-conversion table; not a substitute for the neural measurements."));
    status.textContent = "Scoring with the toy byte trigram (live, in the browser).";
  } else if (isPreset) {
    for (const mid of ids) {
      const result = state.scores.scores[mid][presetId];
      const meta = MODEL_META[mid];
      nodes.push(renderPanel(meta.label, meta.detail, result));
    }
    const a = state.scores.scores[ids[0]][presetId];
    const b = state.scores.scores[ids[1]][presetId];
    if (state.mode === "diff") {
      const pplABetter = a.perplexity < b.perplexity;
      const bpbABetter = a.bits_per_byte < b.bits_per_byte;
      const pplRank = pplABetter
        ? `${MODEL_META[ids[0]].label} looks ahead on PPL (${fmt(a.perplexity, 2)} vs ${fmt(b.perplexity, 2)})`
        : `${MODEL_META[ids[1]].label} looks ahead on PPL (${fmt(b.perplexity, 2)} vs ${fmt(a.perplexity, 2)})`;
      const bpbRank = bpbABetter
        ? `${MODEL_META[ids[0]].label} is ahead on bits per byte (${fmt(a.bits_per_byte, 4)} vs ${fmt(b.bits_per_byte, 4)})`
        : `${MODEL_META[ids[1]].label} is ahead on bits per byte (${fmt(b.bits_per_byte, 4)} vs ${fmt(a.bits_per_byte, 4)})`;
      const artifact = pplABetter !== bpbABetter
        ? " The two metrics disagree; that is the tokenizer artifact."
        : ` Token-level PPL differs by a factor of ${fmt(a.perplexity / b.perplexity, 2)}; bits per byte differs by a factor of ${fmt(a.bits_per_byte / b.bits_per_byte, 2)}.`;
      status.textContent = `These two models use different tokenizers (${a.n_tokens} vs ${b.n_tokens} tokens on this text). ${pplRank}; ${bpbRank}.${artifact}`;
    } else {
      status.textContent = "Same tokenizer, so both perplexity and bits per byte are comparable. DistilGPT-2 is a distilled, weaker model.";
    }
  } else {
    status.textContent = "Custom text: neural per-token probabilities were not precomputed. Showing the toy byte trigram, and you can still use the unit-conversion table above.";
    const result = state.charModel.score(text);
    nodes.push(renderPanel(MODEL_META.toy.label, MODEL_META.toy.detail, result,
      "Switch back to a measured passage to see GPT-2, DistilGPT-2, or SmolLM2-135M."));
    panels.style.gridTemplateColumns = "1fr";
  }
  panels.replaceChildren(...nodes);
  renderUnits(state);
}

function fillSelect(state) {
  const select = document.getElementById("text-select");
  select.replaceChildren(el("option", { value: "custom", text: "Type your own…" }));
  for (const t of state.scores.texts) {
    select.append(el("option", { value: t.id, text: t.title }));
  }
}

async function main() {
  renderK();
  renderScores();
  document.getElementById("k-slider").addEventListener("input", renderK);
  document.getElementById("q-slider").addEventListener("input", renderScores);
  document.getElementById("p-slider").addEventListener("input", renderScores);
  document.getElementById("y-select").addEventListener("change", renderScores);

  const [scores, charRaw, charScores] = await Promise.all([
    fetch("scores.json").then((r) => r.json()),
    fetch("char_trigram.json").then((r) => r.json()),
    fetch("char_scores.json").then((r) => r.json()),
  ]);
  const charModel = buildCharModel(charRaw);

  // Verify the JS trigram against the Python scores.
  for (const t of scores.texts) {
    const js = charModel.score(t.text);
    const py = charScores[t.id];
    const dPpl = Math.abs(js.perplexity - py.perplexity);
    const dBpb = Math.abs(js.bits_per_byte - py.bits_per_byte);
    TEST.charChecks.push({ id: t.id, dPpl, dBpb, ok: dPpl < 1e-6 && dBpb < 1e-6 });
  }

  const state = {
    scores,
    charModel,
    currentId: "surprise",
    mode: "diff",
    gptTokenCount: null,
  };

  fillSelect(state);
  document.getElementById("text-select").value = "surprise";
  document.getElementById("text-input").value = scores.texts.find((t) => t.id === "surprise").text;

  const setMode = (mode) => {
    state.mode = mode;
    document.getElementById("mode-same").setAttribute("aria-pressed", String(mode === "same"));
    document.getElementById("mode-diff").setAttribute("aria-pressed", String(mode === "diff"));
    document.getElementById("mode-toy").setAttribute("aria-pressed", String(mode === "toy"));
    renderPlay(state);
  };
  document.getElementById("mode-same").addEventListener("click", () => setMode("same"));
  document.getElementById("mode-diff").addEventListener("click", () => setMode("diff"));
  document.getElementById("mode-toy").addEventListener("click", () => setMode("toy"));

  document.getElementById("text-select").addEventListener("change", (event) => {
    const id = event.target.value;
    if (id === "custom") {
      state.currentId = null;
    } else {
      state.currentId = id;
      document.getElementById("text-input").value = scores.texts.find((t) => t.id === id).text;
    }
    renderPlay(state);
  });
  document.getElementById("text-input").addEventListener("input", () => {
    const text = document.getElementById("text-input").value;
    const match = scores.texts.find((t) => t.text === text);
    state.currentId = match ? match.id : null;
    document.getElementById("text-select").value = match ? match.id : "custom";
    renderPlay(state);
  });

  setMode("diff");

  state.gptTokenCount = await loadGptTokenizer();
  renderUnits(state);

  TEST.ready = true;
  TEST.failedChecks = TEST.charChecks.filter((c) => !c.ok);
  window.__pplReady = true;
  const dump = document.createElement("script");
  dump.id = "ppl-test-json";
  dump.type = "application/json";
  dump.textContent = JSON.stringify({
    ready: true,
    errors: TEST.errors,
    failedChecks: TEST.failedChecks,
    gptTokenizer: TEST.gptTokenizer,
    charChecks: TEST.charChecks,
  });
  document.body.append(dump);
}

main().catch((err) => {
  TEST.errors.push(String(err && err.stack || err));
  const status = document.getElementById("play-status");
  if (status) {
    status.classList.add("error");
    status.textContent = `Failed to load the demo data: ${err}`;
  }
});
