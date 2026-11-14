import { paletteModels } from './palette-colors.mjs';
import { checkAscii, asciiRubrics } from './ascii-contract.mjs?v=2';

export function createGeneration({ controls, locked, applyRows, renderRows }) {
  const panel = controls.querySelector('.generation-panel');
  const form = panel.querySelector('form');
  const brief = form.querySelector('textarea');
  const model = form.querySelector('select');
  const generate = form.querySelector('[type="submit"]');
  const repair = panel.querySelector('.generation-repair');
  const tools = panel.querySelector('.generation-tools');
  const guidance = panel.querySelector('.generation-guidance');
  const optimized = panel.querySelector('.generation-optimized');
  const optimizationInfo = panel.querySelector('.generation-optimization');
  let promptArtifact = null;
  const trace = panel.querySelector('.generation-trace');
  const status = panel.querySelector('[role="status"]');
  const list = panel.querySelector('.generation-results');
  const details = panel.querySelector('.generation-details');
  const evidence = panel.querySelector('.generation-evidence');
  const download = panel.querySelector('.generation-download');
  const attempts = [];
  let request = null, active = false;
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
  function updateControls() {
    generate.disabled = Boolean(request) || locked();
    generate.textContent = request ? 'Working…' : 'Generate';
    repair.disabled = Boolean(request) || locked();
    tools.disabled = Boolean(request) || locked();
    guidance.disabled = Boolean(request) || locked() || !tools.checked;
    optimized.disabled = Boolean(request) || locked() || !promptArtifact?.instructions;
    model.disabled = Boolean(request) || locked();
    brief.disabled = Boolean(request) || locked();
    download.disabled = !attempts.length;
  }
  brief.addEventListener('input', updateControls);
  tools.addEventListener('change', () => { if (!tools.checked) guidance.checked = false; updateControls(); });
  void fetch(new URL('./ascii-prompts.json', import.meta.url), { cache: 'no-cache' }).then(response => {
    if (!response.ok) throw new Error('Prompt record unavailable.'); return response.json();
  }).then(value => {
    promptArtifact = value;
    const comparison = value.instructions && value.validationScores[value.selectedIndex] > value.validationScores[0]
      ? 'The candidate scored higher on this small validation run.' : 'Baseline matched or beat the candidate on validation.';
    const mean = label => { const cases = value.heldOut?.filter(entry => entry.variant === label) ?? []; return cases.length ? cases.reduce((sum, entry) => sum + entry.score, 0) / cases.length : null; };
    const heldBaseline = mean('baseline'), heldCandidate = mean('selected');
    const heldOut = heldCandidate === null ? '' : heldCandidate < heldBaseline ? ' The candidate scored lower on the held-out cases.' : heldCandidate > heldBaseline ? ' It scored higher on the held-out cases.' : ' Held-out scores tied.';
    optimizationInfo.textContent = value.instructions
      ? `DSPy GEPA pilot · tuned on Qwen. ${comparison}${heldOut} No reliable improvement is established. Exact instructions and results are in Run details.`
      : 'DSPy prompt is awaiting an optimization run.';
    updateControls();
  }).catch(() => { optimizationInfo.textContent = 'DSPy prompt record unavailable. Other switches remain usable.'; });
  const time = ms => ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`;
  function showDetails(attempt) {
    const { image, ...record } = attempt;
    details.textContent = JSON.stringify({ ...record, rubrics: asciiRubrics, optimization: attempt.harness?.optimized ? promptArtifact : null }, null, 2);
    evidence.hidden = !image;
    if (image) evidence.src = `data:image/png;base64,${image}`;
  }
  function renderAttempts() {
    list.replaceChildren();
    for (const attempt of attempts.slice(-4).reverse()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'palette-card';
      button.disabled = locked(); button.setAttribute('aria-label', `${attempt.valid ? 'Use' : attempt.workspaceRows ? 'Preview workspace for' : 'Inspect'} generated attempt ${attempt.number}`);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 300;
      canvas.setAttribute('aria-hidden', 'true');
      if (attempt.valid || attempt.workspaceRows) canvas.getContext('2d').drawImage(renderRows(attempt.rows ?? attempt.workspaceRows), 0, 0, 300, 300);
      const text = document.createElement('span');
      const heading = document.createElement('strong'); heading.textContent = `${attempt.number}. ${attempt.name}`;
      const shape = document.createElement('span'); shape.className = 'palette-state';
      shape.textContent = attempt.valid ? '75 × 50 · structure passed' : attempt.reason ?? 'Generation failed';
      const metrics = document.createElement('span'); metrics.className = 'palette-metrics';
      const switches = document.createElement('span');
      if (attempt.harness) { switches.textContent = Object.entries(attempt.harness).filter(([, on]) => on).map(([name]) => name).join(' + ') || 'All switches off'; metrics.append(switches); }
      const strategy = document.createElement('span');
      const parent = attempts.find(a => a.id === attempt.parentId);
      strategy.textContent = `${attempt.strategy}${parent ? ` · follows draft ${parent.number}` : ''}`; metrics.append(strategy);
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
        if (attempt.valid || attempt.workspaceRows) { applyRows(attempt.rows ?? attempt.workspaceRows, !attempt.valid); }
        showDetails(attempt); updateControls();
        status.textContent = attempt.valid ? `Draft ${attempt.number} loaded. Its stored judgment describes the grid before further edits.` : attempt.workspaceRows ? `Workspace from turn ${attempt.step} loaded as a preview; the model had not submitted it.` : `Draft ${attempt.number} failed validation. Its errors and raw output are available in Run details.`;
      });
      list.append(button);
    }
    updateControls();
  }
  async function run() {
    if (request || locked() || !brief.value.trim()) return;
    const controller = new AbortController(); request = controller; updateControls();
    const subject = brief.value.trim();
    trace.replaceChildren();
    status.textContent = tools.checked ? 'The model is working in its grid…' : 'The model is writing the grid directly…';
    let attempt, partial;
    try {
      const input = { brief: subject, model: model.value, harness: { feedback: repair.checked, tools: tools.checked, guidance: guidance.checked && tools.checked, optimized: optimized.checked }, promptId: optimized.checked ? promptArtifact?.id : undefined };
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
          if (value.event === 'draft') {
            partial = { ...value, raw: '', partial: true };
            writing = false;
            status.textContent = `Turn ${value.step}/${value.maxDrafts} · ${tools.checked ? 'working on the grid' : value.step === 1 ? 'writing the grid' : 'retrying the grid'}…`;
          }
          if (value.event === 'first') { writing = true; if (partial) partial.firstMs = value.firstMs; }
          if (value.event === 'waiting' && !writing) status.textContent = `Preparing the grid… ${Math.round(value.elapsedMs / 1000)}s elapsed.`;
          if (value.event === 'progress') {
            if (partial && typeof value.raw === 'string') partial.raw = value.raw;
            status.textContent = `Writing JSON · ${value.characters.toLocaleString()} characters received…`;
          }
          if (value.event === 'result') {
            if (value.valid && !checkAscii({ rows: value.rows }).valid) throw new Error('The returned grid failed browser validation.');
            attempt = { ...value, number: attempts.length + 1 }; attempts.push(attempt); partial = null;
            const line = document.createElement('li');
            const failures = value.errors?.length ?? 0;
            line.textContent = `Turn ${value.step ?? 1}: ${value.valid ? 'submitted · structure passed' : value.reason ?? 'generation failed'}${failures > 1 ? ` (${failures} validation errors)` : ''}${value.stopReason === 'draft_budget' ? ' · turn budget reached' : ''}`;
            if (value.toolTrace?.length) {
              const actions = document.createElement('ul');
              for (const call of value.toolTrace) {
                const action = document.createElement('li');
                action.textContent = `${call.name} · ${call.observation.accepted.length} accepted · ${call.observation.rejected.length} rejected`;
                actions.append(action);
              }
              line.append(actions);
            }
            if (value.workspaceRows) {
              if (!checkAscii({ rows: value.workspaceRows }).valid) throw new Error('The workspace failed browser validation.');
              applyRows(value.workspaceRows, !value.valid);
            }
            trace.append(line); renderAttempts(); showDetails(attempt);
          }
          if (value.event === 'done') done = true;
        }
        if (chunk.done) break;
      }
      if (!done || !attempt) throw new Error('Generation ended before a complete result.');
      if (!attempt.valid) { status.textContent = `${attempt.reason}${attempt.stopReason === 'draft_budget' ? ' Turn budget reached; all drafts are preserved below.' : ''}`; return; }
      const canvas = renderRows(attempt.rows);
      attempt.image = canvas.toDataURL('image/png').split(',')[1];
      applyRows(attempt.rows); renderAttempts(); showDetails(attempt);
      status.textContent = 'Grid complete. Jev is judging the rendering…';
      try {
        const response = await fetch(`${panel.dataset.endpoint}/judge`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ brief: subject, rows: attempt.rows, image: attempt.image }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Jev could not judge this grid.');
        attempt.judge = result;
        status.textContent = 'Submitted. Jev’s visual judgments are ready; format checks remain separate.';
      } catch (error) {
        attempt.judgeError = controller.signal.aborted ? 'Judging stopped' : error.message;
        status.textContent = `Grid generated. ${attempt.judgeError}`;
      }
      renderAttempts(); showDetails(attempt);
    } catch (error) {
      if (partial) {
        const reason = controller.signal.aborted ? 'Generation stopped.' : error.message;
        attempt = { ...partial, event: 'result', number: attempts.length + 1, valid: false, reason, stopReason: 'stream_failure' };
        attempts.push(attempt); renderAttempts(); showDetails(attempt);
        const line = document.createElement('li'); line.textContent = `Turn ${attempt.step}: interrupted · available partial output preserved`; trace.append(line);
      }
      status.textContent = controller.signal.aborted ? 'Generation stopped.' : error.message;
    } finally { request = null; updateControls(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void run(); });
  download.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 2, rubrics: asciiRubrics, attempts }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'ascii-generation-run.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  updateControls();
  return {
    setMode(mode) { active = mode === 'generate'; placePanel(); if (!active) request?.abort(); },
    syncControls() { if (locked()) request?.abort(); updateControls(); for (const button of list.querySelectorAll('button')) button.disabled = locked(); },
  };
}
