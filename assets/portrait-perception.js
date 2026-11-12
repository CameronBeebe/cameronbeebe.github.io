const humanInk = '#edc984';
const modelInk = '#7fdfe0';
const sharedInk = '#f6f1d3';
const percent = probability => `${Math.round(probability * 100)}%`;
const intentNames = {
  recognition: 'recognition', recovery: 'recovering the portrait', mechanics: 'how the algorithms work',
  comparison: 'human/model agreement', exploration: 'open exploration',
};

function cropCanvas(source, [left, top, right, bottom], minimum = 280) {
  const width = (right - left) * source.width;
  const height = (bottom - top) * source.height;
  const scale = Math.max(1, minimum / Math.min(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, left * source.width, top * source.height, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function png(canvas) { return canvas.toDataURL('image/png').split(',')[1]; }

function boostContrast(canvas) {
  const ctx = canvas.getContext('2d');
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const value = Math.min(255, Math.max(0, pixels.data[index + 1] - 24) * 4);
    pixels.data[index] = value;
    pixels.data[index + 1] = value;
    pixels.data[index + 2] = value;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function project(rect, frame) {
  const width = frame[2] - frame[0];
  const height = frame[3] - frame[1];
  return [frame[0] + rect[0] * width, frame[1] + rect[1] * height,
    frame[0] + rect[2] * width, frame[1] + rect[3] * height];
}

export function createPerception(bridge) {
  const { terminal, controls, columns, rows } = bridge;
  const panel = controls.querySelector('.perception-panel');
  const panelAnchor = document.createComment('Perception controls');
  panel.before(panelAnchor);
  const field = name => document.getElementById(`perception-${name}`);
  const result = field('result');
  const predictionText = field('prediction');
  const guide = controls.querySelector('.portrait-guide');
  const marks = new Set();
  const events = [];
  const comparisons = [];
  const remoteButtons = ['compare', 'predict', 'next', 'focus', 'whole', 'test'];
  let mode;
  let reading = null;
  let prediction = null;
  let focus = false;
  let busy = false;
  let generation = 0;
  let controller;
  let suggestedAction;
  let suggestedElement;

  function placePanel() {
    if (mode === 'perceive' && window.matchMedia('(min-width: 701px)').matches) {
      controls.closest('.hero').querySelector('.hero-copy').append(panel);
    } else {
      panelAnchor.after(panel);
    }
  }
  window.addEventListener('resize', placePanel);

  function record(event) {
    if (events.at(-1) !== event) events.push(event);
    if (events.length > 20) events.shift();
  }

  function invalidate(message = 'The view changed. Ask Jev again.') {
    generation++;
    controller?.abort();
    reading = null;
    prediction = null;
    field('test').hidden = true;
    predictionText.textContent = '';
    result.textContent = message;
    bridge.draw();
  }

  function markedBounds() {
    if (!marks.size) return null;
    let left = columns;
    let top = rows;
    let right = 0;
    let bottom = 0;
    for (const index of marks) {
      left = Math.min(left, index % columns);
      top = Math.min(top, Math.floor(index / columns));
      right = Math.max(right, index % columns + 1);
      bottom = Math.max(bottom, Math.floor(index / columns) + 1);
    }
    return [left / columns, top / rows, right / columns, bottom / rows];
  }

  function currentFrame() {
    const bounds = focus && markedBounds();
    if (!bounds) return [0, 0, 1, 1];
    // Include surroundings so the crop stays interpretable and within image aspect limits.
    const side = Math.min(1, Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 0.18) + 0.08);
    const left = Math.max(0, Math.min(1 - side, (bounds[0] + bounds[2] - side) / 2));
    const top = Math.max(0, Math.min(1 - side, (bounds[1] + bounds[3] - side) / 2));
    return [Math.floor(left * columns) / columns, Math.floor(top * rows) / rows,
      Math.ceil((left + side) * columns) / columns, Math.ceil((top + side) * rows) / rows];
  }

  function patchesFor(frame) {
    const width = Math.round((frame[2] - frame[0]) * columns);
    const height = Math.round((frame[3] - frame[1]) * rows);
    const across = Math.min(8, width);
    const down = Math.min(6, height);
    return Array.from({ length: across * down }, (_, index) => {
      const x = index % across;
      const y = Math.floor(index / across);
      return { id: `r${index}`, rect: [Math.floor(x * width / across) / width,
        Math.floor(y * height / down) / height, Math.floor((x + 1) * width / across) / width,
        Math.floor((y + 1) * height / down) / height] };
    });
  }

  function actionElements() {
    return {
      compare: field('compare'), predict: field('predict'), mark: field('brush'), crop: field('focus'),
      sort: controls.querySelector('[data-experiment="sort"]'),
      repair: controls.querySelector('[data-experiment="repair"]'), restore: document.getElementById('portrait-restore'),
      alphabet: controls.querySelector('[data-experiment="alphabet"]'), trace: controls.querySelector('[data-experiment="trace"]'),
    };
  }

  function payload(operation) {
    const frame = currentFrame();
    const snapshot = bridge.snapshot();
    const left = Math.round(frame[0] * columns);
    const top = Math.round(frame[1] * rows);
    const right = Math.round(frame[2] * columns);
    const bottom = Math.round(frame[3] * rows);
    const contrast = field('contrast').checked;
    const canvas = contrast ? boostContrast(cropCanvas(snapshot.canvas, frame)) : cropCanvas(snapshot.canvas, frame);
    let patches = patchesFor(frame);
    if (operation === 'predict') {
      const ranked = reading?.frame.join() === frame.join()
        ? [...reading.patches].sort((a, b) => b.probability - a.probability) : [];
      const spread = Array.from({ length: 6 }, (_, i) => patches[Math.round(i * (patches.length - 1) / 5)].rect);
      const chosen = ranked.length ? [...ranked.slice(0, 6).map(patch => patch.rect), ...spread] :
        Array.from({ length: 12 }, (_, i) => [i % 3 * 0.35, Math.floor(i / 3) * 0.7 / 3,
          i % 3 * 0.35 + 0.3, Math.floor(i / 3) * 0.7 / 3 + 0.3]);
      patches = chosen.map((rect, index) => {
        const left = Math.max(0, Math.min(0.7, (rect[0] + rect[2]) / 2 - 0.15));
        const top = Math.max(0, Math.min(0.7, (rect[1] + rect[3]) / 2 - 0.15));
        return { id: `r${index}`, rect: [left, top, left + 0.3, top + 0.3] };
      });
    }
    const view = field('view').value;
    const input = {
      operation, target: field('target').value.trim(), model: field('model').value, view,
      context: field('context').checked, tools: field('tools').checked, contrast,
      guidance: field('guidance').value.trim(),
      grid: snapshot.grid.slice(top, bottom).map(row => row.slice(left, right)),
      patches, events: events.slice(), available: Object.keys(actionElements()).filter(id => id !== 'crop' || marks.size),
    };
    if (field('goal').value) input.goal = field('goal').value;
    if (view === 'image') input.image = png(canvas);
    if (field('reference').checked) {
      const reference = cropCanvas(bridge.snapshot(true).canvas, frame);
      input.reference = png(contrast ? boostContrast(reference) : reference);
    }
    if (field('share').checked && marks.size) {
      const bounds = markedBounds();
      const width = frame[2] - frame[0];
      const height = frame[3] - frame[1];
      input.mark = [Math.max(0, (bounds[0] - frame[0]) / width), Math.max(0, (bounds[1] - frame[1]) / height),
        Math.min(1, (bounds[2] - frame[0]) / width), Math.min(1, (bounds[3] - frame[1]) / height)];
      input.mask = Array.from({ length: bottom - top }, (_, y) => Array.from({ length: right - left }, (_, x) =>
        marks.has((y + top) * columns + x + left) ? '1' : '0').join(''));
    }
    if (view === 'image' && input.tools && operation !== 'suggest') {
      input.patches = patches.map(patch => ({ ...patch, image: png(cropCanvas(canvas, patch.rect)) }));
    }
    return { input, frame, patches, human: Number(field('belief').value) / 100 };
  }

  async function request(operation, receive) {
    if (busy || bridge.locked()) return;
    if (!field('target').value.trim()) { result.textContent = 'Name something to look for first.'; return; }
    bridge.pause();
    busy = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    const version = generation;
    const revision = bridge.revision();
    for (const id of remoteButtons) field(id).disabled = true;
    result.textContent = operation === 'suggest' ? 'Considering your recent interactions…' : 'Jev is looking at your selected view…';
    try {
      const captured = payload(operation);
      const evidence = field('evidence');
      evidence.hidden = false;
      evidence.querySelector('p').textContent = `Looking for ${captured.input.target}. ${captured.input.view === 'grid' ? 'Raw character rows.' : captured.input.contrast ? 'Contrast tool applied.' : 'Rendered ASCII.'}`;
      const image = evidence.querySelector('img');
      const text = evidence.querySelector('pre');
      image.hidden = captured.input.view !== 'image';
      text.hidden = captured.input.view !== 'grid';
      if (captured.input.view === 'image') image.src = `data:image/png;base64,${captured.input.image}`;
      else text.textContent = captured.input.grid.join('\n');
      const endpoint = new URL(panel.dataset.endpoint);
      if (['127.0.0.1', 'localhost'].includes(location.hostname) && new URLSearchParams(location.search).has('live-ask')) {
        endpoint.protocol = 'http:';
        endpoint.host = '127.0.0.1:8787';
      }
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(captured.input), signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Jev could not inspect this view.');
      if (version !== generation || revision !== bridge.revision()) return;
      receive(data, captured);
      record(`asked ${operation} about ${captured.input.target}`);
    } catch (error) {
      if (version === generation) result.textContent = error.name === 'AbortError'
        ? 'The request timed out. Try again with the crop tool off.' : error.message;
    } finally {
      clearTimeout(timeout);
      busy = false;
      controller = undefined;
      for (const id of remoteButtons) field(id).disabled = bridge.locked();
    }
  }

  function modelMask() {
    const probabilities = new Float32Array(columns * rows);
    if (!reading) return probabilities;
    for (const patch of reading.patches) {
      const [left, top, right, bottom] = project(patch.rect, reading.frame);
      for (let y = Math.round(top * rows); y < Math.round(bottom * rows); y++) {
        for (let x = Math.round(left * columns); x < Math.round(right * columns); x++) probabilities[y * columns + x] = patch.probability;
      }
    }
    return probabilities;
  }

  function updateResult() {
    if (!reading) return;
    if (!field('experiments').open || !field('human').open) {
      result.textContent = `Jev’s estimate · ${percent(reading.visible)} recognizable.\nBlue highlights show its interpretation.`;
      return;
    }
    const human = Number(field('belief').value);
    const model = reading.visible * 100;
    const probabilities = modelMask();
    const cutoff = Number(field('cutoff').value) / 100;
    let intersection = 0;
    let union = 0;
    for (let i = 0; i < probabilities.length; i++) {
      const machine = probabilities[i] >= cutoff;
      if (marks.has(i) && machine) intersection++;
      if (marks.has(i) || machine) union++;
    }
    const overlap = marks.size && union ? ` · marked-region overlap ${Math.round(intersection / union * 100)}%` : '';
    result.textContent = `Recognizable? You ${human}% · Jev ${percent(reading.visible)}\n`
      + `Probability gap ${Math.round(Math.abs(human - model))} points${overlap}.`;
    if (reading.box && reading.visible < 0.5) result.textContent += '\nDashed blue box shows Jev’s location guess despite low recognition.';
    const previous = comparisons.at(-2);
    if (previous) result.textContent += `\nPrevious ${previous.target} reading ${percent(previous.visible)} (${previous.view}).`;
  }

  function compare(outcome) {
    return request('compare', (data, { frame, patches, input, human }) => {
      reading = { ...data, frame, patches: patches.map(patch => ({ ...patch,
        probability: data.patches.find(score => score.id === patch.id).probability })) };
      const treatment = [input.view === 'image' ? 'Rendered ASCII' : 'Raw grid', input.model,
        input.context && 'artwork context', input.reference && 'original reference',
        input.tools && input.view === 'image' && 'crop tool', input.contrast && input.view === 'image' && 'contrast tool', input.mark && 'human marks',
        input.guidance && 'custom guidance', focus && 'focused region'].filter(Boolean).join(' · ');
      comparisons.push({ visible: data.visible, view: input.view, treatment, human, target: input.target });
      if (comparisons.length > 6) comparisons.shift();
      const history = field('history');
      history.hidden = false;
      history.querySelector('ol').replaceChildren(...comparisons.toReversed().map(item => {
        const entry = document.createElement('li');
        entry.textContent = `${item.target} · You ${percent(item.human)} · Jev ${percent(item.visible)} · ${item.treatment}`;
        return entry;
      }));
      updateResult();
      if (outcome) {
        predictionText.textContent = `After erasing: predicted ${percent(outcome.remaining)} recognizable · observed Jev reading ${percent(data.visible)}.\n`
          + `Prediction error ${Math.round(Math.abs(outcome.remaining - data.visible) * 100)} points. Your own judgment can differ.`;
      }
      bridge.draw();
    });
  }

  function dismiss() {
    suggestedElement?.classList.remove('jev-suggested');
    suggestedElement = null;
    suggestedAction = null;
    guide.hidden = true;
  }

  field('compare').addEventListener('click', () => compare());
  field('target').addEventListener('input', () => { marks.clear(); invalidate('Ready. Ask Jev to find it.'); });
  field('human').addEventListener('toggle', () => { updateResult(); bridge.draw(); });
  field('experiments').addEventListener('toggle', () => { updateResult(); bridge.draw(); });
  field('target').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); compare(); } });
  field('belief').addEventListener('input', () => {
    field('belief-value').value = `${field('belief').value}%`;
    updateResult();
  });
  field('cutoff').addEventListener('input', () => {
    field('cutoff-value').value = `${field('cutoff').value}%`;
    updateResult(); bridge.draw();
  });
  field('overlay').addEventListener('change', () => bridge.draw());
  field('clear').addEventListener('click', () => {
    marks.clear();
    if (focus) { focus = false; field('whole').hidden = true; invalidate(); }
    if (field('share').checked) invalidate();
    updateResult(); bridge.draw(); record('cleared human marks');
  });
  for (const name of ['view', 'model', 'context', 'reference', 'tools', 'contrast', 'share', 'guidance']) {
    field(name).addEventListener('input', () => { invalidate(); record(`changed ${name}`); });
  }
  field('focus').addEventListener('click', () => {
    if (!marks.size) { result.textContent = 'Paint a region first so the crop tool knows where to look.'; return; }
    focus = true;
    field('whole').hidden = false;
    invalidate();
    compare();
  });
  field('whole').addEventListener('click', () => { focus = false; field('whole').hidden = true; invalidate(); compare(); });
  field('predict').addEventListener('click', () => request('predict', (data, { frame, patches }) => {
    const patch = patches.find(item => item.id === data.region);
    prediction = { rect: project(patch.rect, frame), remaining: data.remaining };
    predictionText.textContent = `If the dashed region is erased, Jev predicts ${percent(data.remaining)} probability the target stays recognizable.`;
    result.textContent = 'Prediction ready. Inspect the dashed region before testing it.';
    field('test').hidden = false;
    bridge.draw();
  }));
  field('test').addEventListener('click', () => {
    if (!prediction || busy) return;
    const outcome = prediction;
    prediction = null;
    field('test').hidden = true;
    if (bridge.eraseRegion(outcome.rect)) { record('tested predicted erasure'); compare(outcome); }
  });
  field('next').addEventListener('click', () => request('suggest', data => {
    dismiss();
    suggestedAction = data.next.choice;
    suggestedElement = actionElements()[suggestedAction];
    for (let parent = suggestedElement.parentElement; parent && parent !== panel; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    suggestedElement.classList.add('jev-suggested');
    const action = suggestedAction === 'mark' ? 'Mark yours' : suggestedElement.textContent.trim();
    field('suggestion').textContent = `Jev’s guess: you’re exploring ${intentNames[data.intent.choice]}. Try ${action}.\n`
      + 'Change “My intention” to correct the guess.';
    guide.hidden = false;
    result.textContent = 'Suggested control outlined in blue. You decide what to try.';
  }));
  field('follow').addEventListener('click', () => {
    const action = suggestedAction;
    const element = suggestedElement;
    dismiss();
    if (!element) return;
    record(`accepted suggestion ${action}`);
    if (['compare', 'predict', 'mark', 'crop'].includes(action)) bridge.selectMode('perceive');
    if (action === 'mark') { field('brush').value = 'mark'; terminal.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else element.click();
    element.focus({ preventScroll: true });
  });
  field('dismiss').addEventListener('click', () => { record(`dismissed suggestion ${suggestedAction}`); dismiss(); });
  field('goal').addEventListener('change', () => { dismiss(); record(`stated intention ${field('goal').value || 'infer'}`); });
  controls.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button && !button.id.startsWith('perception-')) record(button.dataset.experiment ? `selected ${button.dataset.experiment}` : button.textContent.trim());
  });

  function outline(ctx, rect, color, dashed) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, ctx.canvas.width / 250);
    ctx.setLineDash(dashed ? [7, 5] : []);
    ctx.strokeRect(rect[0] * ctx.canvas.width, rect[1] * ctx.canvas.height,
      (rect[2] - rect[0]) * ctx.canvas.width, (rect[3] - rect[1]) * ctx.canvas.height);
  }

  return {
    setMode(next) { mode = next; placePanel(); },
    gridChanged() {
      if (reading || prediction || busy) invalidate('Portrait changed. Ask Jev again.');
      record(`edited portrait in ${mode}`);
    },
    stroke(from, to) {
      if (!field('experiments').open || !field('human').open) return;
      const steps = Math.max(1, Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
      for (let step = 0; step <= steps; step++) {
        const x = Math.round(from[0] + (to[0] - from[0]) * step / steps);
        const y = Math.round(from[1] + (to[1] - from[1]) * step / steps);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= columns || y + dy < 0 || y + dy >= rows) continue;
          const index = (y + dy) * columns + x + dx;
          if (field('brush').value === 'unmark') marks.delete(index);
          else marks.add(index);
        }
      }
      if (focus || field('share').checked) invalidate('Your marked context changed. Compare again.');
      field('hover').textContent = `${marks.size} cells marked by you.`;
      updateResult(); bridge.draw(); record('painted human interpretation');
    },
    hover([x, y]) {
      if (!field('experiments').open || !field('human').open) return;
      const probability = modelMask()[y * columns + x];
      field('hover').textContent = `Cell ${x + 1}, ${y + 1} · ${marks.has(y * columns + x) ? 'marked by you' : 'unmarked'}`
        + (reading ? ` · Jev’s region score ${percent(probability)}` : '');
    },
    draw(ctx, cells) {
      if (mode !== 'perceive') return;
      ctx.save();
      const probabilities = modelMask();
      const cutoff = Number(field('cutoff').value) / 100;
      const show = field('experiments').open && field('human').open ? field('overlay').value : 'model';
      const width = ctx.canvas.width / columns;
      const height = ctx.canvas.height / rows;
      for (let index = 0; index < cells.length; index++) {
        const human = marks.has(index);
        const machine = Boolean(reading) && probabilities[index] >= cutoff;
        if ((show === 'human' && !human) || (show === 'model' && !machine)
          || (show === 'difference' && human === machine) || (!human && !machine)) continue;
        const color = show === 'human' ? humanInk : show === 'model' ? modelInk : human && machine ? sharedInk : human ? humanInk : modelInk;
        const x = index % columns * width;
        const y = Math.floor(index / columns) * height;
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, width, height);
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        if (cells[index]) ctx.fillText(cells[index].glyph, x + width / 2, y + height / 2, width);
      }
      if (reading?.box && show !== 'human') outline(ctx, project(reading.box, reading.frame), modelInk, reading.visible < 0.5);
      if (focus) outline(ctx, currentFrame(), humanInk, true);
      if (prediction) outline(ctx, prediction.rect, humanInk, true);
      ctx.restore();
    },
  };
}
