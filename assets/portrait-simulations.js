import { descentPath, gravityStep, lifeStep, neighbors, sobelTone } from './portrait-grid.js';
import { glyphDensity } from './ascii-image.js';
import { fireStep, igniteCell } from './portrait-fire.mjs';

export const simulationDescriptions = {
  life: ['Conway’s Game of Life', 'Dense characters seed living cells. A cell is born with three live neighbors and survives with two or three. Drag to plant or erase cells.'],
  gravity: ['Glyph gravity', 'Dense glyphs fall and slide past lighter ones. Draw a blue wall to catch them, or erase a wall and run gravity again.'],
  descent: ['Gradient descent', 'Click a starting glyph. Each character has a fixed density. Gold arrows step downhill or cross a flat patch to reach a lower character. A star marks the endpoint.'],
  edges: ['Sobel edge detection', 'Replace each glyph with the strength of the contrast around it. Sharp outlines become bright, and even shading fades.'],
  flow: ['Ink percolation', 'Can ink get from left to right? Release it at the left edge or click a starting cell. It spreads through connected glyphs at or below the maximum density.'],
  fire: ['Glyph fire', 'Drag to ignite characters. Denser glyphs hold more fuel and burn longer. Heat spreads to neighbors, then the spent glyphs leave ash. Restore rewinds the burn.'],
};

export function createSimulations(ui) {
  const { columns, rows } = ui;
  const lifeButton = document.getElementById('life-run');
  const gravityButton = document.getElementById('gravity-run');
  const eraseWalls = document.getElementById('gravity-erase');
  const threshold = document.getElementById('flow-threshold');
  const fireButton = document.getElementById('fire-run');
  let running = null;
  let generation = 0;
  let turn = 0;
  let totalMoves = 0;
  let paintAlive = true;
  let flowSeed = null;

  function marked(tone, glyph, extra = {}) {
    return { ...ui.makeCell(tone), glyph, ink: ui.phosphor, ...extra };
  }
  const lifeCells = [' ', '.', ':', '+', '#'].map((glyph, lifeAge) => marked(lifeAge / 4, glyph, { lifeAge }));
  const wall = marked(1, '=', { wall: true, keepInk: true, ink: '#9dbac9', backdrop: '#19323b' });
  const dryInk = marked(0.62, '~');
  const indexAt = ([x, y]) => y * columns + x;

  function reset() {
    running = null;
    generation = 0;
    turn = 0;
    totalMoves = 0;
    flowSeed = null;
    lifeButton.textContent = 'Run Life';
    gravityButton.textContent = 'Run gravity';
    fireButton.textContent = 'Resume fire';
  }

  function fireTick() {
    const { next, burning, ash, warm } = fireStep(ui.current(), columns, rows, turn++);
    ui.apply(next);
    ui.report(`${burning ? 'Burning' : warm ? 'Cooling' : 'Fire out'} · ${burning.toLocaleString()} burning · ${ash.toLocaleString()} ash cells.`);
    if (running === 'fire' && (burning || warm)) ui.later(fireTick, 90);
    else {
      running = null;
      fireButton.textContent = 'Resume fire';
    }
  }

  function lifeState() {
    return ui.current().map(cell => cell?.lifeAge ?? ((cell?.tone ?? 0) >= 0.53 ? 4 : 0));
  }

  function lifeTick() {
    const next = lifeStep(lifeState(), columns, rows);
    const population = next.filter(age => age === 4).length;
    generation++;
    ui.apply(next.map(age => lifeCells[age]));
    ui.report(`Generation ${generation} · ${population.toLocaleString()} live cells.`);
    if (running === 'life' && next.some(Boolean)) ui.later(lifeTick, 150);
    else if (running === 'life') {
      running = null;
      lifeButton.textContent = 'Run Life';
    }
  }

  function gravityTick() {
    const { next, moves } = gravityStep(ui.current(), columns, rows, turn++);
    totalMoves += moves;
    if (!moves) {
      running = null;
      gravityButton.textContent = 'Run gravity';
      ui.report(`Settled · ${totalMoves.toLocaleString()} glyph moves.`);
      return;
    }
    ui.apply(next);
    ui.report(`Falling · ${totalMoves.toLocaleString()} glyph moves.`);
    ui.later(gravityTick, 65);
  }

  function descent(start) {
    ui.stop();
    const surface = ui.current().map(cell => glyphDensity(cell?.glyph ?? ' '));
    const path = descentPath(surface, start, columns, rows);
    let steps = 0;
    const arrows = { [-1]: '<', [1]: '>', [-columns]: '^', [columns]: 'v' };
    const startTone = surface[start];

    function step() {
      const index = path[steps];
      const next = path[steps + 1];
      const grid = ui.current().slice();
      grid[index] = marked(0.85, next === undefined ? '*' : arrows[next - index], {
        keepInk: true, ink: '#f0ce87', backdrop: '#3d2d12',
      });
      ui.apply(grid);
      const height = surface[index].toFixed(3);
      if (next === undefined) {
        ui.report(steps
          ? `${steps} ${steps === 1 ? 'step' : 'steps'} · Density ${startTone.toFixed(3)} → ${height}.`
          : `0 steps · Density ${height}.`);
        return;
      }
      steps++;
      ui.report(`Step ${steps} · Density ${height} → ${surface[next].toFixed(3)}.`);
      ui.later(step, 180);
    }
    step();
  }

  function edges() {
    ui.stop();
    const source = ui.current().slice();
    let index = 0;
    function step() {
      const next = ui.current().slice();
      const end = Math.min(index + 3 * columns, source.length);
      for (; index < end; index++) next[index] = ui.makeCell(sobelTone(source, index, columns, rows));
      ui.apply(next);
      if (index < source.length) {
        ui.report(`Scanning edges · ${index / columns}/${rows} rows.`);
        ui.later(step, 45);
      } else ui.report('Edge map complete.');
    }
    step();
  }

  function flow(start, reuse = false) {
    ui.stop();
    flowSeed = start;
    const source = ui.beginPreview(reuse);
    const limit = Number(threshold.value) / 100;
    const permeable = index => (source[index]?.tone ?? 0) <= limit;
    if (!permeable(start)) {
      ui.apply(source.slice());
      ui.report('The starting glyph blocks the ink. Raise Max density or pick a lighter starting cell.');
      return;
    }
    const queue = [start];
    const visited = new Set(queue);
    let head = 0;
    let crossed = false;
    function step() {
      const boundary = queue.length;
      const grid = ui.current().slice();
      while (head < boundary) {
        const index = queue[head++];
        grid[index] = dryInk;
        crossed ||= index % columns === columns - 1;
        for (const next of neighbors(index, columns, rows)) {
          if (!permeable(next) || visited.has(next)) continue;
          visited.add(next);
          queue.push(next);
        }
      }
      ui.apply(grid);
      if (head < queue.length) {
        ui.report(`Spreading · ${head.toLocaleString()} cells${crossed ? ' · Right edge reached' : ''}.`);
        ui.later(step, 24);
      } else {
        ui.report(`${crossed ? 'Reached the right edge' : 'No route to the right edge'} · ${head.toLocaleString()} cells filled.`);
      }
    }
    step();
  }

  function pick(mode, point) {
    const index = indexAt(point);
    if (mode === 'life') paintAlive = lifeState()[index] !== 4;
    if (mode === 'descent') descent(index);
    if (mode === 'flow') flow(index);
  }

  function stroke(mode, [x, y], [nx, ny]) {
    if (!['life', 'gravity', 'fire'].includes(mode)) return;
    const grid = ui.current().slice();
    const steps = Math.max(1, Math.abs(nx - x), Math.abs(ny - y));
    for (let i = 0; i <= steps; i++) {
      const index = indexAt([Math.round(x + (nx - x) * i / steps), Math.round(y + (ny - y) * i / steps)]);
      if (mode === 'life') grid[index] = lifeCells[paintAlive ? 4 : 0];
      else if (mode === 'fire') grid[index] = igniteCell(grid[index]);
      else if (!eraseWalls.checked) grid[index] = wall;
      else if (grid[index]?.wall) grid[index] = lifeCells[0];
    }
    ui.apply(grid);
    if (mode === 'fire') {
      if (running !== 'fire') {
        ui.stop();
        running = 'fire';
        fireButton.textContent = 'Pause fire';
        fireTick();
      }
      return;
    }
    if (mode === 'life') ui.report(paintAlive ? 'Live cells planted.' : 'Cells erased.');
    else ui.report(eraseWalls.checked ? 'Wall cells cleared.' : 'Wall drawn. Run gravity to test it.');
  }

  lifeButton.addEventListener('click', () => {
    ui.stop();
    if (running === 'life') {
      running = null;
      lifeButton.textContent = 'Run Life';
      ui.report(`Paused at generation ${generation}.`);
      return;
    }
    running = 'life';
    lifeButton.textContent = 'Pause Life';
    lifeTick();
  });
  document.getElementById('life-step').addEventListener('click', () => {
    ui.stop();
    running = null;
    lifeButton.textContent = 'Run Life';
    lifeTick();
  });
  gravityButton.addEventListener('click', () => {
    ui.stop();
    if (running === 'gravity') {
      running = null;
      gravityButton.textContent = 'Run gravity';
      ui.report(`Paused · ${totalMoves.toLocaleString()} glyph moves.`);
      return;
    }
    running = 'gravity';
    gravityButton.textContent = 'Pause gravity';
    gravityTick();
  });
  fireButton.addEventListener('click', () => {
    ui.stop();
    if (running === 'fire') {
      running = null;
      fireButton.textContent = 'Resume fire';
      ui.report('Fire paused.');
    } else {
      running = 'fire';
      fireButton.textContent = 'Pause fire';
      fireTick();
    }
  });
  document.getElementById('descent-run').addEventListener('click', () => descent(indexAt([32, 18])));
  document.getElementById('edges-run').addEventListener('click', edges);
  document.getElementById('flow-run').addEventListener('click', () => flow(indexAt([0, 11])));
  threshold.addEventListener('input', () => {
    document.getElementById('flow-level').value = threshold.value;
    if (flowSeed !== null) flow(flowSeed, true);
  });

  return { pick, reset, stroke };
}
