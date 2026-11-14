import { paletteModels } from './palette-colors.mjs';
import { checkAscii, asciiRubrics } from './ascii-contract.mjs?v=2';

export function createGeneration({ controls, locked, applyRows, renderRows }) {
  const panel = controls.querySelector('.generation-panel');
  const form = panel.querySelector('form');
  const brief = form.querySelector('textarea'), model = form.querySelector('select');
  const generate = form.querySelector('[type="submit"]');
  const repair = panel.querySelector('.generation-repair'), tools = panel.querySelector('.generation-tools');
  const guidance = panel.querySelector('.generation-guidance'), optimized = panel.querySelector('.generation-optimized');
  const status = panel.querySelector('.generation-status'), summary = panel.querySelector('.generation-result');
  const history = panel.querySelector('.generation-history'), list = panel.querySelector('.generation-results');
  const feedback = panel.querySelector('.generation-feedback'), voteStatus = panel.querySelector('.generation-vote-status');
  const voteButtons = [...panel.querySelectorAll('[data-vote]')];
  const optimizationInfo = panel.querySelector('.generation-optimization');
  const download = panel.querySelector('.generation-download');
  const attempts = [], runs = [], feedbackEvents = [];
  let request = null, voting = false, active = false, painting = false, viewMatches = false, selected = null, promptArtifact = null;
  const home = document.createComment('generation controls'); panel.before(home);
  const desktop = matchMedia('(min-width: 701px)');
  function placePanel() { if (active && desktop.matches) controls.closest('.hero').querySelector('.hero-copy').append(panel); else home.after(panel); }
  desktop.addEventListener('change', placePanel);
  for (const entry of paletteModels) {
    const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name;
    option.selected = entry.id === 'thinkingmachines/inkling-2-small'; model.append(option);
  }
  function updateControls() {
    const busy = Boolean(request) || voting || locked();
    generate.disabled = busy; generate.textContent = request ? 'Drawing…' : 'Generate';
    for (const input of [repair, tools, model, brief]) input.disabled = busy;
    guidance.disabled = busy || !tools.checked;
    optimized.disabled = busy || !promptArtifact?.instructions;
    download.disabled = !attempts.length;
    feedback.hidden = !selected?.finished || !viewMatches || !selected.attempts.length;
    for (const button of voteButtons) {
      button.disabled = busy;
      button.setAttribute('aria-pressed', String(selected?.vote === Number(button.dataset.vote)));
    }
    voteStatus.textContent = selected?.voteMessage ?? '';
    for (const button of list.querySelectorAll('button')) button.disabled = busy;
  }
  tools.addEventListener('change', () => { if (!tools.checked) guidance.checked = false; updateControls(); });
  void fetch(new URL('./ascii-prompts.json', import.meta.url), { cache: 'no-cache' }).then(response => {
    if (!response.ok) throw Error('Prompt unavailable'); return response.json();
  }).then(value => {
    promptArtifact = value;
    optimizationInfo.textContent = value.instructions
      ? 'The DSPy switch uses saved composition instructions from a small Qwen pilot. Validation improved slightly; excluded-case results were worse. No reliable improvement is established.'
      : 'The DSPy prompt is awaiting an optimization run.';
    updateControls();
  }).catch(() => { optimizationInfo.textContent = 'The DSPy prompt is unavailable. The other switches still work.'; });

  function paint(rows, workspace = false) {
    painting = true;
    try { applyRows(rows, workspace); viewMatches = true; } finally { painting = false; }
  }
  function displayRows(run) {
    const final = run.attempts.at(-1);
    return final?.valid ? final.rows : run.attempts.findLast(attempt => attempt.workspaceRows)?.workspaceRows;
  }
  function renderSummary() {
    const final = selected?.attempts.at(-1);
    summary.hidden = !selected?.finished || !final;
    if (summary.hidden) return;
    const grades = final.judge?.judgments;
    const costKnown = selected.attempts.every(attempt => Number.isFinite(attempt.cost));
    const cost = selected.attempts.reduce((sum, attempt) => sum + (attempt.cost ?? 0), 0);
    summary.textContent = `${final.name} · ${selected.attempts.length} ${selected.attempts.length === 1 ? 'turn' : 'turns'}`
      + (costKnown ? ` · $${cost.toFixed(5)} generation` : ' · cost incomplete')
      + (grades ? ` · Jev: match ${grades.match.score.toFixed(1)}/3, coherence ${grades.readability.score.toFixed(1)}/3` : final.judgeError ? ' · visual grade unavailable' : '');
  }
  function renderHistory() {
    list.replaceChildren();
    const completed = runs.filter(run => run.finished && displayRows(run));
    history.hidden = completed.length === 0;
    for (const run of completed.slice(-3).reverse()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'generation-history-item';
      button.setAttribute('aria-label', `Load result ${run.number}`);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100; canvas.setAttribute('aria-hidden', 'true');
      canvas.getContext('2d').drawImage(renderRows(displayRows(run)), 0, 0, 100, 100);
      const label = document.createElement('span'), final = run.attempts.at(-1);
      label.textContent = `${run.number}. ${final.name} · ${final.valid ? 'submitted' : 'unfinished'}`;
      button.append(canvas, label);
      button.addEventListener('click', () => {
        if (request || voting || locked()) return;
        selected = run; paint(displayRows(run), !final.valid); renderSummary(); updateControls();
        status.textContent = final.valid ? 'Earlier result loaded.' : 'Unfinished result loaded.';
      });
      list.append(button);
    }
  }
  async function vote(rating) {
    if (voting || request || locked() || !selected?.finished || !viewMatches || selected.vote === rating) return;
    const run = selected;
    const payload = { feedbackId: run.feedbackId, sequence: ++run.sequence, rating,
      run: { version: 3, runId: run.id, rubrics: asciiRubrics, attempts: run.attempts, optimization: run.optimization } };
    voting = true; run.voteMessage = 'Saving…'; updateControls();
    try {
      const response = await fetch(`${panel.dataset.endpoint}/feedback`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      if (!response.ok || value.saved !== true) throw Error(value.error ?? 'Vote was not saved. Please try again.');
      run.vote = rating; run.voteMessage = 'Thanks—saved.';
      feedbackEvents.push({ id: value.id, feedbackId: run.feedbackId, runId: run.id, sequence: run.sequence, rating });
    } catch { run.voteMessage = 'Not saved. Please try again.'; }
    finally { voting = false; updateControls(); }
  }
  for (const button of voteButtons) button.addEventListener('click', () => { void vote(Number(button.dataset.vote)); });

  async function run() {
    if (request || voting || locked() || !brief.value.trim()) return;
    const controller = new AbortController(); request = controller; viewMatches = false;
    const record = { number: runs.length + 1, id: null, attempts: [], finished: false,
      feedbackId: crypto.randomUUID(), sequence: 0, vote: null, voteMessage: '', optimization: optimized.checked ? promptArtifact : null };
    runs.push(record); selected = record; renderSummary(); updateControls();
    const subject = brief.value.trim();
    status.textContent = 'Drawing…';
    let attempt, partial;
    try {
      const input = { brief: subject, model: model.value,
        harness: { feedback: repair.checked, tools: tools.checked, guidance: guidance.checked && tools.checked, optimized: optimized.checked },
        promptId: optimized.checked ? promptArtifact?.id : undefined };
      const response = await fetch(`${panel.dataset.endpoint}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal,
      });
      if (!response.ok) throw Error((await response.json()).error ?? 'Drawing could not start.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '', done = false, step = 1;
      while (true) {
        const chunk = await reader.read(); pending += decoder.decode(chunk.value, { stream: !chunk.done });
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line) continue;
          const value = JSON.parse(line);
          if (value.event === 'draft') {
            partial = { ...value, raw: '', partial: true }; record.id = value.runId; step = value.step;
            status.textContent = `Drawing · turn ${step} of ${value.maxDrafts}…`;
          }
          if (value.event === 'first' && partial) partial.firstMs = value.firstMs;
          if (value.event === 'waiting') status.textContent = `Drawing · turn ${step} · ${Math.round(value.elapsedMs / 1000)}s…`;
          if (value.event === 'progress' && partial && typeof value.raw === 'string') partial.raw = value.raw;
          if (value.event === 'result') {
            if (value.valid && !checkAscii({ rows: value.rows }).valid) throw Error('The returned grid failed validation.');
            attempt = { ...value, number: attempts.length + 1 }; attempts.push(attempt); record.attempts.push(attempt); partial = null;
            if (value.workspaceRows) {
              if (!checkAscii({ rows: value.workspaceRows }).valid) throw Error('The workspace failed validation.');
              paint(value.workspaceRows, !value.valid);
            }
          }
          if (value.event === 'done') done = true;
        }
        if (chunk.done) break;
      }
      if (!done || !attempt) throw Error('Drawing stopped before a complete result.');
      if (!attempt.valid) { status.textContent = attempt.stopReason === 'draft_budget' ? 'Turn limit reached. The unfinished drawing is still here.' : attempt.reason; return; }
      attempt.image = renderRows(attempt.rows).toDataURL('image/png').split(',')[1];
      paint(attempt.rows); status.textContent = 'Drawing ready. Getting a visual grade…';
      try {
        const response = await fetch(`${panel.dataset.endpoint}/judge`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: controller.signal, body: JSON.stringify({ brief: subject, rows: attempt.rows, image: attempt.image }) });
        const value = await response.json(); if (!response.ok) throw Error(value.error ?? 'Visual grade unavailable.');
        attempt.judge = value; status.textContent = 'Ready. What do you think?';
      } catch (error) { attempt.judgeError = controller.signal.aborted ? 'Judging stopped.' : error.message; status.textContent = 'Drawing ready. Visual grade unavailable.'; }
    } catch (error) {
      if (partial) {
        attempt = { ...partial, event: 'result', number: attempts.length + 1, valid: false,
          reason: controller.signal.aborted ? 'Drawing stopped.' : error.message, stopReason: 'stream_failure' };
        attempts.push(attempt); record.attempts.push(attempt);
      }
      status.textContent = controller.signal.aborted ? 'Drawing stopped.' : error.message;
    } finally {
      record.finished = true; request = null; renderSummary(); renderHistory(); updateControls();
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void run(); });
  download.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 3, rubrics: asciiRubrics, attempts, feedback: feedbackEvents,
      optimization: promptArtifact }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'ascii-generation-run.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  updateControls();
  return {
    setMode(mode) { active = mode === 'generate'; placePanel(); if (!active) request?.abort(); },
    gridChanged() { if (!painting) { viewMatches = false; updateControls(); } },
    syncControls() { if (locked()) request?.abort(); updateControls(); },
  };
}
