import { glyphDensity, glyphs } from './ascii-image.js';

// Fuel comes from the visible character, rather than the source image's hidden tone.
export function fuelFor(cell) {
  if (!cell || cell.wall || cell.fire?.ash) return 0;
  const density = glyphDensity(cell.glyph);
  return density > 0 ? 6 + Math.round(density * 40) : 0;
}

export function igniteCell(cell) {
  const fuel = cell?.fire?.fuel ?? fuelFor(cell);
  if (!fuel || cell.fire?.burning) return cell;
  return { ...cell, fire: { fuel, initial: fuel, heat: 1, burning: true, sourceGlyph: cell.glyph } };
}

export function fireStep(grid, columns, rows, turn = 0) {
  let burning = 0, ash = 0, warm = 0;
  const next = grid.map((cell, index) => {
    if (!cell || cell.wall) return cell;
    const state = cell.fire;
    if (state?.ash) { ash++; return cell; }
    if (state?.burning) {
      const fuel = Math.max(0, state.fuel - 1);
      if (!fuel) {
        ash++;
        const glyph = glyphDensity(state.sourceGlyph) >= 0.65 ? ':' : '.';
        return { ...cell, glyph, tone: glyphDensity(glyph), rank: glyphs.indexOf(glyph) * 4,
          ink: '#776e5c', backdrop: undefined, keepInk: true,
          fire: { ...state, fuel: 0, heat: 0, burning: false, ash: true } };
      }
      burning++;
      const ratio = fuel / state.initial;
      const level = Math.max(1, Math.round(glyphDensity(state.sourceGlyph) * ratio * (glyphs.length - 1)));
      const glyph = glyphs[level];
      const colors = ['#ff793e', '#ffb14d', '#ffe5a0', '#f8c86a'];
      return { ...cell, glyph, tone: glyphDensity(glyph), rank: level * 4 + 3,
        ink: colors[(turn + index) % colors.length], backdrop: '#30160a', keepInk: true,
        fire: { ...state, fuel, heat: 1 } };
    }
    if (!fuelFor(cell)) return cell;
    const x = index % columns, y = Math.floor(index / columns);
    let heat = Math.max(0, (state?.heat ?? 0) * 0.86 - 0.018);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx >= columns || y + dy < 0 || y + dy >= rows) continue;
      if (!grid[(y + dy) * columns + x + dx]?.fire?.burning) continue;
      // A burning cell below contributes more heat: the front tends to rise.
      const direction = dy === 1 ? 1.35 : dy === -1 ? 0.65 : 1;
      heat += 0.14 * direction * (dx && dy ? 0.65 : 1);
    }
    heat = Math.min(1, heat);
    if (heat >= 0.4) {
      burning++;
      return igniteCell(cell);
    }
    if (heat < 0.02) heat = 0;
    if (heat) warm++;
    if (heat === (state?.heat ?? 0)) return cell;
    return { ...cell, fire: { heat } };
  });
  return { next, burning, ash, warm };
}
