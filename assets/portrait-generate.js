import { paletteModels } from './palette-colors.mjs';
import { checkAscii, asciiRubrics } from './ascii-contract.mjs';

export function createGeneration({ controls, locked, applyRows, renderRows }) {
  const panel = controls.querySelector('.generation-panel');
  const form = panel.querySelector('form');
  const brief = form.querySelector('textarea');
  const model = form.querySelector('select');
  const generate = form.querySelector('[type="submit"]');
  const refine = panel.querySelector('.generation-refine');
  const status = panel.querySelector('[role="status"]');
  const list = panel.querySelector('.generation-results');
  const details = panel.querySelector('.generation-details');
  const evidence = panel.querySelector('.generation-evidence');
  const download = panel.querySelector('.generation-download');
  const attempts = [];
  let request = null, active = false, selected = null;
  const home = document.createComment('generation controls'); panel.before(home);
  const desktop = matchMedia('(min-width: 701px)');
  function placePanel() {
    if (active && desktop.matches) controls.closest('.hero').querySelector('.hero-copy').append(panel);
    else home.after(panel);
  }
  desktop.addEventListener('change', placePanel);
  for (const entry of paletteModels) {
    const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name;
    option.selected = entry.id === 'thinkingmachines/inkling-2-small'; model.append(option);
  }
  function previous() { return selected?.valid && selected.brief === brief.value.trim() && selected.judge?.judgments ? selected : null; }
  function updateControls() {
    generate.disabled = Boolean(request) || locked();
    generate.textContent = request ? 'Working…' : 'Generate';
    refine.disabled = Boolean(request) || locked() || !previous();
    download.disabled = !attempts.length;
  }
  brief.addEventListener('input', updateControls);
  const time = ms => ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`;
  function showDetails(attempt) {
    const { image, ...record } = attempt;
    details.textContent = JSON.stringify({ ...record, rubrics: asciiRubrics }, null, 2);
    evidence.hidden = !image;
    if (image) evidence.src = `data:image/png;base64,${image}`;
  }
  function renderAttempts() {
    list.replaceChildren();
    for (const attempt of attempts.slice(-4).reverse()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'palette-card';
      button.disabled = !attempt.valid || locked(); button.setAttribute('aria-label', `Use generated attempt ${attempt.number}`);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 300;
      canvas.setAttribute('aria-hidden', 'true');
      if (attempt.valid) canvas.getContext('2d').drawImage(renderRows(attempt.rows), 0, 0, 300, 300);
      const text = document.createElement('span');
      const heading = document.createElement('strong'); heading.textContent = `${attempt.number}. ${attempt.name}`;
      const shape = document.createElement('span'); shape.className = 'palette-state';
      shape.textContent = attempt.valid ? '75 × 50 · structure passed' : attempt.reason ?? 'Generation failed';
      const metrics = document.createElement('span'); metrics.className = 'palette-metrics';
      const strategy = document.createElement('span'); strategy.textContent = attempt.strategy; metrics.append(strategy);
      if (attempt.valid) {
        const coverage = document.createElement('span');
        coverage.textContent = `${attempt.rows.join('').split('').filter(c => c !== ' ').length.toLocaleString()} / 3,750 inked cells`;
        metrics.append(coverage);
      }
      if (attempt.judge?.judgments) {
        for (const [id, rubric] of Object.entries(asciiRubrics)) {
          const score = document.createElement('span');
          score.textContent = `Jev · ${rubric.title} ${attempt.judge.judgments[id].score.toFixed(2)}/3`;
          metrics.append(score);
        }
      } else {
        const waiting = document.createElement('span'); waiting.textContent = attempt.judgeError ?? (attempt.valid ? 'Jev is judging…' : 'Not judged'); metrics.append(waiting);
      }
      const timing = document.createElement('span'); timing.textContent = `First ${time(attempt.firstMs)} · grid ${time(attempt.readyMs)}`; metrics.append(timing);
      const cost = document.createElement('span'); cost.textContent = attempt.cost === null ? 'Generation cost unreported' : `Generation $${attempt.cost.toFixed(6)}`; metrics.append(cost);
      if (Number.isInteger(attempt.tokens)) cost.textContent += ` · ${attempt.tokens} tokens`;
      const provider = document.createElement('span'); provider.textContent = `${attempt.provider ?? 'Provider unreported'} · reasoning ${attempt.thinking}`; metrics.append(provider);
      text.append(heading, shape, metrics); button.append(canvas, text);
      button.addEventListener('click', () => {
        if (locked()) return;
        selected = attempt; applyRows(attempt.rows); showDetails(attempt); updateControls();
        status.textContent = `Attempt ${attempt.number} loaded. Its stored judgment describes the generated grid before further edits.`;
      });
      list.append(button);
    }
    updateControls();
  }
  async function run(revising = false) {
    if (request || locked() || !brief.value.trim()) return;
    const old = revising ? previous() : null;
    if (revising && !old) return;
    const controller = new AbortController(); request = controller; updateControls();
    const subject = brief.value.trim();
    status.textContent = 'The model is writing the grid directly…';
    let attempt;
    try {
      const input = { brief: subject, model: model.value };
      if (old) {
        input.previous = old.rows;
        input.feedback = Object.fromEntries(Object.entries(old.judge.judgments).map(([id, value]) => [id, value.score]));
      }
      const response = await fetch(`${panel.dataset.endpoint}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Generation could not start.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '', done = false, writing = false;
      while (true) {
        const chunk = await reader.read(); pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line) continue;
          const value = JSON.parse(line);
          if (value.event === 'first') writing = true;
          if (value.event === 'waiting' && !writing) status.textContent = `Preparing the grid… ${Math.round(value.elapsedMs / 1000)}s elapsed.`;
          if (value.event === 'progress') status.textContent = `Writing JSON · ${value.characters.toLocaleString()} characters received…`;
          if (value.event === 'result') attempt = { ...value, number: attempts.length + 1 };
          if (value.event === 'done') done = true;
        }
        if (chunk.done) break;
      }
      if (!done || !attempt) throw new Error('Generation ended before a complete result.');
      if (attempt.valid && !checkAscii({ rows: attempt.rows }).valid) throw new Error('The returned grid failed browser validation.');
      attempts.push(attempt);
      if (!attempt.valid) { renderAttempts(); showDetails(attempt); status.textContent = attempt.reason; return; }
      const canvas = renderRows(attempt.rows);
      attempt.image = canvas.toDataURL('image/png').split(',')[1];
      selected = attempt; applyRows(attempt.rows); renderAttempts(); showDetails(attempt);
      status.textContent = 'Grid complete. Jev is judging the rendering…';
      try {
        const response = await fetch(`${panel.dataset.endpoint}/judge`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ brief: subject, rows: attempt.rows, image: attempt.image }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Jev could not judge this grid.');
        attempt.judge = result;
        status.textContent = 'Jev’s judgments are ready. Refine uses the previous grid and scores to request a new drawing.';
      } catch (error) {
        attempt.judgeError = controller.signal.aborted ? 'Judging stopped' : error.message;
        status.textContent = `Grid generated. ${attempt.judgeError}`;
      }
      renderAttempts(); showDetails(attempt);
    } catch (error) {
      status.textContent = controller.signal.aborted ? 'Generation stopped.' : error.message;
    } finally { request = null; updateControls(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void run(); });
  refine.addEventListener('click', () => { void run(true); });
  download.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 1, rubrics: asciiRubrics, attempts }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'ascii-generation-run.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  updateControls();
  return {
    setMode(mode) { active = mode === 'generate'; placePanel(); if (!active) request?.abort(); },
    syncControls() { if (locked()) request?.abort(); updateControls(); for (const button of list.querySelectorAll('button')) button.disabled = locked() || !attempts.find(a => button.getAttribute('aria-label') === `Use generated attempt ${a.number}`)?.valid; },
  };
}
