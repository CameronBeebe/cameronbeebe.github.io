import { paletteModels, checkPalette, colorCells } from './palette-colors.mjs';

export function createPalette({ controls, current, apply, drawPreview, locked }) {
  const panel = controls.querySelector('.palette-panel');
  const form = panel.querySelector('form');
  const input = panel.querySelector('input');
  const compare = form.querySelector('button');
  const status = panel.querySelector('[role="status"]');
  const results = panel.querySelector('.palette-results');
  const cards = new Map();
  const home = document.createComment('palette controls');
  panel.before(home);
  const desktop = matchMedia('(min-width: 701px)');
  const copy = controls.closest('.hero').querySelector('.hero-copy');
  let request;
  let active = false;
  let rendering;
  function updateButton() {
    compare.disabled = Boolean(request) || locked();
    compare.textContent = request ? 'Comparing…' : 'Compare';
  }
  updateButton();

  function placePanel() {
    if (active && desktop.matches) copy.append(panel);
    else home.after(panel);
  }
  desktop.addEventListener('change', placePanel);

  function makeCard(model) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-card';
    button.disabled = true;
    button.setAttribute('aria-label', `Apply ${model.name} palette`);
    const canvas = document.createElement('canvas');
    canvas.width = 300; canvas.height = 300;
    canvas.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = model.name;
    const state = document.createElement('span');
    state.className = 'palette-state';
    state.textContent = 'Waiting for output…';
    const metrics = document.createElement('span');
    metrics.className = 'palette-metrics';
    body.append(name, state, metrics);
    button.append(canvas, body);
    const card = { button, canvas, state, metrics, model };
    button.addEventListener('click', () => {
      if (locked() || !card.palette) return;
      apply(card.palette);
      for (const other of cards.values()) other.button.setAttribute('aria-pressed', String(other === card));
      status.textContent = `${model.name} palette applied. Restore rewinds the color edits.`;
    });
    results.append(button);
    cards.set(model.id, card);
    drawPreview(canvas, current());
  }

  const seconds = ms => ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`;
  function renderMetrics() {
    const ceiling = Math.max(1000, ...[...cards.values()].map(c => c.result?.readyMs ?? c.result?.firstMs ?? 0));
    for (const card of cards.values()) {
      const result = card.result;
      if (!result) continue;
      card.metrics.replaceChildren();
      for (const [label, value] of [['First token', result.firstMs], ['Usable JSON', result.readyMs]]) {
        const line = document.createElement('span');
        line.className = 'palette-timing';
        const text = document.createElement('span');
        text.textContent = `${label} ${seconds(value)}`;
        const track = document.createElement('span');
        track.className = 'palette-track';
        const bar = document.createElement('span');
        bar.style.width = `${Math.min(100, (value ?? 0) / ceiling * 100)}%`;
        track.append(bar); line.append(text, track); card.metrics.append(line);
      }
      const cost = document.createElement('span');
      cost.textContent = Number.isFinite(result.cost) ? `$${result.cost.toFixed(6)}` : 'Cost unreported';
      if (Number.isInteger(result.tokens)) cost.textContent += ` · ${result.tokens} tokens`;
      card.metrics.append(cost);
      const provider = document.createElement('span');
      provider.textContent = result.provider ?? 'Provider unreported';
      if (result.thinking) provider.textContent += ` · reasoning ${result.thinking}`;
      card.metrics.append(provider);
    }
  }

  function consume(value) {
    if (value.event === 'done') return;
    const card = cards.get(value.model);
    if (!card) return;
    card.result = value;
    if (value.event === 'first') card.state.textContent = 'Receiving JSON…';
    if (value.event === 'result') {
      card.palette = value.valid && checkPalette(value.palette).valid ? value.palette : null;
      card.button.disabled = !card.palette || locked();
      card.state.textContent = card.palette ? `Valid JSON${value.adjusted ? ' · contrast adjusted' : ''} · select to apply` : value.reason ?? 'No usable palette';
      if (card.palette) drawPreview(card.canvas, colorCells(current(), card.palette));
    }
    renderMetrics();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const mood = input.value.trim();
    if (!mood || request || locked()) return;
    const controller = new AbortController();
    request = controller;
    updateButton();
    status.textContent = 'The same mood goes to three models in parallel.';
    let done = false;
    try {
      const response = await fetch(panel.dataset.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mood }), signal: controller.signal,
      });
      if (!response.ok) {
        const problem = await response.json();
        throw new Error(problem.error ?? 'The comparison could not start.');
      }
      results.replaceChildren(); cards.clear();
      for (const model of paletteModels) makeCard(model);
      results.hidden = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line) continue;
          const value = JSON.parse(line);
          if (value.event === 'done') done = true;
          consume(value);
        }
        if (chunk.done) break;
      }
      if (!done) throw new Error('The connection ended early.');
      const valid = [...cards.values()].filter(c => c.palette).length;
      status.textContent = valid ? `Palettes for “${mood}”. Choose one to recolor the portrait.` : 'No palette passed the checks this round. You can try another mood.';
    } catch (error) {
      for (const card of cards.values()) {
        if (!card.result || card.result.event !== 'result') card.state.textContent = 'Comparison incomplete';
      }
      status.textContent = controller.signal.aborted ? 'Comparison stopped.' : error.message;
      if (!cards.size) results.hidden = true;
    } finally {
      request = null;
      updateButton();
    }
  });

  return {
    syncControls() {
      updateButton();
      for (const card of cards.values()) card.button.disabled = !card.palette || locked();
    },
    setMode(mode) {
      active = mode === 'palette';
      placePanel();
      if (!active) request?.abort();
    },
    gridChanged() {
      if (!active || rendering || !cards.size) return;
      rendering = requestAnimationFrame(() => {
        rendering = null;
        for (const card of cards.values()) drawPreview(card.canvas, card.palette ? colorCells(current(), card.palette) : current());
      });
    },
  };
}
