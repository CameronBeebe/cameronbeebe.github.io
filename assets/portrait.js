import { createSimulations, simulationDescriptions } from './portrait-simulations.js';
import { swapCells, sortPass, neighbors, repairPass, quantizeRow } from './portrait-grid.js';
import { glyphs, sampleImageTones } from './ascii-image.js';

const portrait = document.querySelector('.portrait-print');
const terminal = document.querySelector('.portrait-terminal');
const controls = document.querySelector('.portrait-controls');
const phosphor = getComputedStyle(document.documentElement).getPropertyValue('--phosphor').trim();

const columns = 75;
const rows = 50;
const inks = ['#246321', '#389b2d', '#59cf48', phosphor];

function makeCell(tone) {
  const glyph = Math.round(tone * (glyphs.length - 1));
  const ink = Math.round(tone * (inks.length - 1));
  return { glyph: glyphs[glyph], ink: inks[ink], rank: glyph * inks.length + ink, tone };
}

function drawTerminal(ctx, cells) {
  const cellWidth = terminal.width / columns;
  const cellHeight = terminal.height / rows;
  ctx.fillStyle = '#031803';
  ctx.fillRect(0, 0, terminal.width, terminal.height);
  ctx.font = '13px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  cells.forEach((cell, index) => {
    if (!cell || cell.glyph === ' ') return;
    const { glyph, ink, backdrop } = cell;
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * cellHeight;
    if (backdrop) {
      ctx.fillStyle = backdrop;
      ctx.fillRect(x, y, cellWidth, cellHeight);
    }
    ctx.fillStyle = ink;
    ctx.fillText(glyph, x, y);
  });
}

function enablePortraitExperiments() {
  if (!portrait.naturalWidth) return;
  const ctx = terminal.getContext('2d');
  if (!ctx) return;

  const original = sampleImageTones(portrait, columns, rows).map(makeCell);
  const modeButtons = [...controls.querySelectorAll('[data-experiment]')];
  const panels = [...controls.querySelectorAll('[data-controls]')];
  const sortColumns = document.getElementById('sort-columns');
  const sortButton = document.getElementById('sort-run');
  const restoreButton = document.getElementById('portrait-restore');
  const tolerance = document.getElementById('trace-tolerance');
  const dither = document.getElementById('alphabet-dither');
  const status = document.getElementById('portrait-status');
  const history = [];
  const pending = new Map();
  const finished = new Set();
  let working = original.slice();
  let mode;
  let timer;
  let rewinding = false;
  let pointer = null;
  let seed = null;
  let alphabet = 4;
  let preview = null;

  function draw() { drawTerminal(ctx, working); }
  function report(message) { status.textContent = message; }
  function later(step, delay) {
    timer = setTimeout(() => {
      timer = undefined;
      step();
    }, delay);
  }
  function stop() {
    clearTimeout(timer);
    timer = undefined;
  }
  function lockControls(locked) {
    rewinding = locked;
    for (const control of controls.querySelectorAll('button, input')) control.disabled = locked;
    if (!locked) dither.disabled = alphabet === glyphs.length;
  }

  function applyGrid(next) {
    const changes = [];
    next.forEach((cell, index) => {
      if (cell !== working[index]) changes.push(index, working[index]);
    });
    if (changes.length) history.push({ changes });
    working = next;
  }

  function beginPreview(reuse, keepCurrent = false) {
    if (!reuse || !preview) {
      preview = { source: working.slice(), historyStart: history.length };
    } else if (!keepCurrent) {
      working = preview.source.slice();
      history.length = preview.historyStart;
    }
    return preview.source;
  }

  const simulations = createSimulations({
    columns, rows, makeCell, phosphor,
    current: () => working,
    apply(next) { applyGrid(next); draw(); },
    report, later, stop, beginPreview,
  });

  function sortStep() {
    const vertical = sortColumns.checked;
    const stride = vertical ? columns : 1;
    const length = vertical ? rows : columns;
    const axis = vertical ? 'columns' : 'rows';
    const swaps = [];
    for (const [lane, state] of pending) {
      const offset = vertical ? lane : lane * columns;
      const moved = sortPass(working, offset, stride, length, state.pass % 2, swaps);
      state.pass++;
      state.quiet = moved ? 0 : state.quiet + 1;
      if (state.pass === length || state.quiet === 2) {
        pending.delete(lane);
        finished.add(lane);
      }
    }
    if (swaps.length) history.push({ swaps });
    draw();
    const total = vertical ? columns : rows;
    if (pending.size) {
      report(`Sorting ${pending.size} · ${finished.size}/${total} ${axis} sorted.`);
      later(sortStep, 45);
    } else {
      report(`${finished.size}/${total} ${axis} sorted.`);
    }
  }

  function queueLines(first, last = first) {
    if (rewinding) return;
    for (let lane = Math.min(first, last); lane <= Math.max(first, last); lane++) {
      if (!pending.has(lane) && !finished.has(lane)) pending.set(lane, { pass: 0, quiet: 0 });
    }
    if (timer === undefined && pending.size) sortStep();
  }

  function restore() {
    stop();
    simulations.reset();
    pending.clear();
    finished.clear();
    pointer = null;
    preview = null;
    seed = null;
    if (!history.length) {
      report('The portrait is already in its original state.');
      return;
    }

    lockControls(true);
    const onlySorts = history.every(entry => entry.swaps);
    const batchSize = Math.ceil(history.length / 75);
    let swapsReversed = 0;
    let cellsRestored = 0;
    function step() {
      for (let batch = 0; batch < batchSize && history.length; batch++) {
        const { swaps, changes } = history.pop();
        if (swaps) {
          for (let i = swaps.length - 2; i >= 0; i -= 2) {
            swapCells(working, swaps[i], swaps[i + 1]);
            swapsReversed++;
          }
        } else {
          for (let i = changes.length - 2; i >= 0; i -= 2) {
            working[changes[i]] = changes[i + 1];
            cellsRestored++;
          }
        }
      }
      draw();
      const counts = `${swapsReversed.toLocaleString()} swaps reversed`
        + (onlySorts ? '' : ` · ${cellsRestored.toLocaleString()} cell edits undone`);
      if (history.length) {
        report(`${onlySorts ? 'Unsorting' : 'Rewinding'} · ${counts}.`);
        later(step, 45);
      } else {
        lockControls(false);
        report(`Portrait restored · ${counts}.`);
      }
    }
    step();
  }

  function erase(grid, [x, y], radius = 4) {
    for (let ny = Math.max(0, y - radius); ny <= Math.min(rows - 1, y + radius); ny++) {
      for (let nx = Math.max(0, x - radius); nx <= Math.min(columns - 1, x + radius); nx++) {
        if ((nx - x) ** 2 + (ny - y) ** 2 <= radius ** 2) grid[ny * columns + nx] = null;
      }
    }
  }

  function eraseStroke([x, y], [nx, ny]) {
    stop();
    const next = working.slice();
    const steps = Math.max(1, Math.abs(nx - x), Math.abs(ny - y));
    for (let i = 0; i <= steps; i++) {
      erase(next, [Math.round(x + (nx - x) * i / steps), Math.round(y + (ny - y) * i / steps)]);
    }
    applyGrid(next);
    draw();
    report('Patch erased. Choose Repair patch to rebuild it from its edges.');
  }

  function repair() {
    stop();
    const missing = working.filter(cell => cell === null).length;
    if (!missing) {
      report('Erase a patch first.');
      return;
    }
    if (missing === working.length) {
      report('Every cell was erased. Restore the portrait to start again.');
      return;
    }
    let pass = 0;
    function step() {
      const { next, remaining } = repairPass(working, columns, rows, makeCell);
      applyGrid(next);
      pass++;
      draw();
      if (remaining) {
        report(`Repair pass ${pass} · ${remaining} cells left.`);
        later(step, 95);
        return;
      }
      report(`Rebuilt ${missing} cells in ${pass} passes using the surrounding characters.`);
    }
    step();
  }

  function trace(index, reuse = false) {
    if (!(reuse ? preview.source : working)[index]) {
      report('Choose a character outside the erased patch.');
      return;
    }
    stop();
    seed = index;
    const source = beginPreview(reuse);
    const limit = Number(tolerance.value);
    const startTone = source[seed].tone;
    const marked = { glyph: '+', ink: phosphor, tone: 0.45, rank: 5 * inks.length + 3 };
    const queue = [seed];
    const visited = new Set(queue);
    let head = 0;

    function step() {
      const boundary = queue.length;
      const nextGrid = working.slice();
      while (head < boundary) {
        const current = queue[head++];
        nextGrid[current] = marked;
        for (const next of neighbors(current, columns, rows)) {
          if (visited.has(next)) continue;
          visited.add(next);
          if (source[next] && Math.abs(source[next].tone - startTone) <= limit / 20) queue.push(next);
        }
      }
      applyGrid(nextGrid);
      draw();
      report(`${head < queue.length ? 'Tracing' : 'Traced'} ${head} connected cells · Tolerance ${limit}.`);
      if (head < queue.length) later(step, 32);
    }
    step();
  }

  function shrink(size) {
    stop();
    alphabet = size;
    const full = size === glyphs.length;
    dither.disabled = full;
    const source = beginPreview(true, true);
    const reducedGlyphs = { 2: ' @', 4: ' :o@', 8: ' .:;ox#@' }[size];
    const errors = !full && dither.checked ? new Float64Array(source.length) : null;
    let row = 0;
    const reducedCell = (tone, glyph) => ({
      tone, glyph, ink: phosphor, rank: glyphs.indexOf(glyph) * inks.length + inks.length - 1,
    });

    function step() {
      const end = Math.min(row + 3, rows);
      const next = working.slice();
      for (; row < end; row++) {
        if (full) {
          const start = row * columns;
          for (let i = start; i < start + columns; i++) next[i] = source[i];
        } else {
          quantizeRow(source, next, errors, row, columns, reducedGlyphs, reducedCell);
        }
      }
      applyGrid(next);
      draw();
      const result = row === rows ? 'Done' : `${row}/${rows} rows`;
      const treatment = full ? 'Full input' : errors ? 'Error diffusion' : 'Direct rounding';
      report(`${result} · ${size} glyphs including space · ${treatment}.`);
      if (row < rows) later(step, 45);
    }
    step();
  }

  const descriptions = {
    ...simulationDescriptions,
    sort: ['Sort the ASCII portrait', 'Drag across rows or columns to sort them together by ink density. Restore rewinds the edits across tools.'],
    repair: ['Damage & repair', 'Drag to erase characters. Repair estimates each missing cell from its neighbors, one pass at a time.'],
    trace: ['Trace the ink', 'Click a character to rewrite connected cells of similar tone. Change tolerance to see where the fill stops.'],
    alphabet: ['Shrink the alphabet', 'Try 2, 4, or 8 glyphs with optional dithering. Use 12 to restore the grid you entered with. Colored mechanics marks keep their glyphs and ink.'],
  };

  for (const button of modeButtons) {
    button.addEventListener('click', () => selectMode(button.dataset.experiment));
  }

  function selectMode(next) {
    if (mode === next) return;
    stop();
    simulations.reset();
    pending.clear();
    finished.clear();
    preview = null;
    seed = null;
    mode = next;
    pointer = null;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.experiment === mode));
    for (const panel of panels) panel.hidden = panel.dataset.controls !== mode;
    const [title, instructions] = descriptions[mode];
    document.getElementById('portrait-title').textContent = title;
    document.getElementById('portrait-instructions').textContent = instructions;
    draw();
    report(history.length ? 'Continuing with the edited grid.' : `The original ${columns} × ${rows} character grid is ready.`);
  }

  function pointAt(event) {
    const bounds = terminal.getBoundingClientRect();
    const x = Math.floor((event.clientX - bounds.left) / bounds.width * columns);
    const y = Math.floor((event.clientY - bounds.top) / bounds.height * rows);
    return [Math.max(0, Math.min(columns - 1, x)), Math.max(0, Math.min(rows - 1, y))];
  }

  function stroke(from, to) {
    if (mode === 'repair') eraseStroke(from, to);
    simulations.stroke(mode, from, to);
    if (mode === 'sort') {
      const axis = sortColumns.checked ? 0 : 1;
      queueLines(from[axis], to[axis]);
    }
  }

  terminal.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer || rewinding) return;
    const point = pointAt(event);
    if (mode === 'trace') trace(point[1] * columns + point[0]);
    simulations.pick(mode, point);
    if (!['repair', 'sort', 'life', 'gravity'].includes(mode)) return;
    terminal.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, point };
    stroke(point, point);
  });

  terminal.addEventListener('pointermove', event => {
    if (pointer?.id !== event.pointerId) return;
    const point = pointAt(event);
    if (point[0] === pointer.point[0] && point[1] === pointer.point[1]) return;
    stroke(pointer.point, point);
    pointer.point = point;
  });

  terminal.addEventListener('pointerup', event => {
    if (pointer?.id !== event.pointerId) return;
    stroke(pointer.point, pointAt(event));
    pointer = null;
  });

  for (const type of ['pointercancel', 'lostpointercapture']) {
    terminal.addEventListener(type, event => {
      if (pointer?.id === event.pointerId) pointer = null;
    });
  }

  sortButton.addEventListener('click', () => queueLines(0, (sortColumns.checked ? columns : rows) - 1));
  sortColumns.addEventListener('change', () => {
    stop();
    pending.clear();
    finished.clear();
    report(`Drag to sort ${sortColumns.checked ? 'columns' : 'rows'} from the current arrangement.`);
  });
  restoreButton.addEventListener('click', restore);
  document.getElementById('repair-run').addEventListener('click', repair);
  tolerance.addEventListener('input', () => {
    document.getElementById('trace-level').value = tolerance.value;
    if (seed !== null) trace(seed, true);
  });
  document.getElementById('alphabet-four').addEventListener('click', () => shrink(4));
  document.getElementById('alphabet-two').addEventListener('click', () => shrink(2));
  document.getElementById('alphabet-eight').addEventListener('click', () => shrink(8));
  document.getElementById('alphabet-twelve').addEventListener('click', () => shrink(glyphs.length));
  dither.addEventListener('change', () => shrink(alphabet));

  selectMode('sort');
  portrait.hidden = true;
  terminal.hidden = false;
  controls.hidden = false;
}

if (portrait.complete) enablePortraitExperiments();
else portrait.addEventListener('load', enablePortraitExperiments, { once: true });
