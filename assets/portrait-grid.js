export function swapCells(grid, first, second) {
  [grid[first], grid[second]] = [grid[second], grid[first]];
}

export function sortPass(grid, offset, stride, length, parity, swaps) {
  const previousCount = swaps.length;
  for (let position = parity; position < length - 1; position += 2) {
    const first = offset + position * stride;
    const second = first + stride;
    if ((grid[first]?.rank ?? -1) <= (grid[second]?.rank ?? -1)) continue;
    swapCells(grid, first, second);
    swaps.push(first, second);
  }
  return swaps.length - previousCount;
}

export function neighbors(index, columns, rows) {
  const result = [];
  if (index % columns > 0) result.push(index - 1);
  if (index % columns < columns - 1) result.push(index + 1);
  if (index >= columns) result.push(index - columns);
  if (index < (rows - 1) * columns) result.push(index + columns);
  return result;
}

export function repairPass(grid, columns, rows, makeCell) {
  const next = grid.slice();
  let remaining = 0;
  grid.forEach((cell, index) => {
    if (cell !== null) return;
    const known = neighbors(index, columns, rows).map(neighbor => grid[neighbor]).filter(Boolean);
    if (!known.length) {
      remaining++;
      return;
    }
    const tone = known.reduce((sum, neighbor) => sum + neighbor.tone, 0) / known.length;
    next[index] = makeCell(tone);
  });
  return { next, remaining };
}

export function quantizeRow(source, working, errors, row, columns, glyphs, makeCell) {
  const levels = glyphs.length - 1;
  for (let column = 0; column < columns; column++) {
    const index = row * columns + column;
    if (!source[index]) continue;
    const tone = Math.max(0, Math.min(1, source[index].tone + (errors?.[index] ?? 0)));
    const level = Math.round(tone * levels);
    working[index] = makeCell(level / levels, glyphs[level]);
    if (!errors) continue;
    const error = tone - level / levels;
    if (column < columns - 1) errors[index + 1] += error * 7 / 16;
    if (index + columns >= source.length) continue;
    if (column > 0) errors[index + columns - 1] += error * 3 / 16;
    errors[index + columns] += error * 5 / 16;
    if (column < columns - 1) errors[index + columns + 1] += error / 16;
  }
}

export function lifeStep(state, columns, rows) {
  return state.map((age, index) => {
    const x = index % columns;
    const y = Math.floor(index / columns);
    let alive = 0;
    for (let ny = Math.max(0, y - 1); ny <= Math.min(rows - 1, y + 1); ny++) {
      for (let nx = Math.max(0, x - 1); nx <= Math.min(columns - 1, x + 1); nx++) {
        if ((nx !== x || ny !== y) && state[ny * columns + nx] === 4) alive++;
      }
    }
    if (alive === 3 || (age === 4 && alive === 2)) return 4;
    return Math.max(0, age - 1);
  });
}

export function gravityStep(grid, columns, rows, turn) {
  const next = grid.slice();
  const solid = cell => cell?.wall || (cell?.tone ?? 0) >= 0.48;
  let moves = 0;
  for (let y = rows - 2; y >= 0; y--) {
    for (let i = 0; i < columns; i++) {
      const x = turn % 2 ? columns - 1 - i : i;
      const from = y * columns + x;
      if (!solid(next[from]) || next[from]?.wall) continue;
      const offsets = (x + y + turn) % 2 ? [0, -1, 1] : [0, 1, -1];
      const offset = offsets.find(dx => x + dx >= 0 && x + dx < columns && !solid(next[from + columns + dx]));
      if (offset === undefined) continue;
      swapCells(next, from, from + columns + offset);
      moves++;
    }
  }
  return { next, moves };
}

export function sobelTone(grid, index, columns, rows) {
  const x = index % columns;
  const y = Math.floor(index / columns);
  const at = (dx, dy) => {
    const nx = Math.max(0, Math.min(columns - 1, x + dx));
    const ny = Math.max(0, Math.min(rows - 1, y + dy));
    return grid[ny * columns + nx]?.tone ?? 0;
  };
  const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
  const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
  return Math.min(1, Math.hypot(gx, gy) / 3);
}
