const columns = 90;
const rows = 42;
const palette = {
  sky: '#385337',
  mist: '#5b7250',
  ridge: '#47643f',
  light: '#96a16b',
  shade: '#365334',
  bank: '#4b6135',
  grass: '#78854a',
  water: '#527d5b',
  glint: '#92aa74',
  pine: '#4b8143',
  needles: '#86ae61',
  trunk: '#827c4f',
};

function texture(x, y) {
  return ((x * 37 + y * 71 + x * y * 13) % 97) / 97;
}

// Sample the hand-shaped silhouettes on the same character lattice as the scene.
function profile(points, x) {
  const right = points.findIndex(([column]) => column >= x);
  if (right === 0) return points[0][1];
  const [x0, y0] = points[right - 1];
  const [x1, y1] = points[right];
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}

function landscape() {
  const cells = Array.from({ length: rows }, () => Array(columns).fill(null));
  function put(x, y, glyph, color) {
    if (x >= 0 && x < columns && y >= 0 && y < rows) cells[y][x] = [glyph, palette[color]];
  }

  const farRidge = [[0, 20], [11, 14], [16, 16], [24, 10], [37, 19], [45, 15], [61, 21], [75, 14], [89, 19]];
  const summit = [[0, 25], [20, 23], [31, 20], [41, 15], [46, 15], [55, 8], [61, 4], [66, 9], [70, 11], [77, 18], [89, 23]];
  const riverCenter = [[23, 59], [26, 56], [30, 47], [34, 45], [38, 53], [41, 62]];
  const riverWidth = [[23, 2], [26, 4], [30, 7], [34, 10], [38, 16], [41, 22]];

  for (let x = 0; x < columns; x++) {
    const distant = Math.round(profile(farRidge, x));
    const slope = Math.round(profile(summit, x));
    for (let y = 0; y < rows; y++) {
      const grain = texture(x, y);
      if (y < distant && y < slope) {
        const cloud = (y === 5 && x >= 24 && x <= 42) || (y === 9 && x >= 4 && x <= 23)
          || (y === 13 && x >= 76 && x <= 87);
        if (cloud && grain > 0.18) put(x, y, grain > 0.45 ? '-' : '.', 'mist');
        else if (grain < 0.025) put(x, y, '.', 'sky');
      } else if (y < 23) {
        if (y < slope) {
          if (grain > 0.22) put(x, y, y === distant ? '_' : ':', 'ridge');
          continue;
        }
        const lit = x <= 61 + (y - 4) * 0.58;
        const contour = (y + Math.floor(x / 2)) % 5 === 0;
        if (y === slope) put(x, y, x < 61 ? '/' : '\\', lit ? 'light' : 'mist');
        else if (lit && (y < 12 || contour)) put(x, y, grain > 0.49 ? '/' : ':', 'light');
        else if (grain > 0.25) put(x, y, grain > 0.66 ? ':' : '.', lit ? 'ridge' : 'shade');
      } else {
        const center = profile(riverCenter, y);
        const width = profile(riverWidth, y);
        const distance = Math.abs(x - center);
        if (distance < width - 1) {
          const ripple = Math.sin(x * 0.28 + y * 1.9) > 0.2;
          if (ripple && grain > 0.12) put(x, y, y % 3 === 0 ? '~' : '-', y % 5 === 0 ? 'glint' : 'water');
        } else if (distance < width + 0.4) {
          put(x, y, grain > 0.5 ? '_' : '.', 'glint');
        } else if (grain > 0.38) {
          const tuft = y > 32 && grain > 0.82;
          put(x, y, tuft ? '"' : grain > 0.55 ? ',' : '.', tuft ? 'grass' : 'bank');
        }
      }
    }
  }

  function pine(x, base, height, spread, distant = false) {
    const top = base - height + 1;
    for (let y = top; y <= base; y++) {
      const depth = y - top;
      const tier = depth % 4;
      const width = depth < height - 2 ? Math.min(spread, Math.floor(depth * 0.24 + tier * 0.9)) : 0;
      for (let dx = -width; dx <= width; dx++) {
        const grain = texture(x + dx, y);
        if (dx && grain < 0.12) continue;
        const edge = Math.abs(dx) === width;
        const glyph = width === 0 ? '|' : dx === 0 ? '|' : edge ? (dx < 0 ? '/' : '\\') : grain > 0.5 ? '+' : ':';
        const color = distant ? 'ridge' : !width && depth > 0 ? 'trunk' : dx < 0 ? 'pine' : 'needles';
        put(x + dx, y, glyph, color);
      }
    }
  }

  for (const [x, base, height] of [[28, 25, 7], [34, 25, 6], [39, 24, 7], [47, 24, 6], [51, 24, 5],
    [67, 24, 7], [72, 25, 8], [80, 26, 10], [85, 25, 7], [89, 26, 9]]) pine(x, base, height, 3, true);
  pine(24, 34, 11, 4);
  pine(2, 36, 15, 6);
  pine(86, 37, 16, 6);

  // A leaning pine in the foreground, with broad boughs above the riverbank.
  const trunk = [[13, 15], [17, 12], [23, 10], [29, 12], [34, 11], [40, 8]];
  for (let y = 13; y <= 40; y++) {
    const x = Math.round(profile(trunk, y));
    const next = Math.round(profile(trunk, Math.min(y + 1, 40)));
    const stroke = next === x ? '|' : next < x ? '/' : '\\';
    put(x, y, stroke, 'trunk');
    if (y > 24) put(x + 1, y, stroke, 'pine');
  }
  const boughs = [
    [15, 19, 10, 3], [11, 23, 10, 3], [6, 27, 8, 4], [16, 31, 9, 4],
  ];
  for (const [x, y, width, depth] of boughs) {
    for (let dy = -depth; dy <= 0; dy++) {
      for (let dx = -width; dx <= width; dx++) {
        const grain = texture(x + dx, y + dy);
        const shape = Math.abs(dx + dy * 0.8) / width + Math.abs(dy + 0.5) / depth;
        if (shape > 1 || grain < 0.07) continue;
        const glyph = dy === 0 ? (grain > 0.45 ? '_' : '+') : grain > 0.63 ? '*' : '+';
        put(x + dx, y + dy, glyph, dy < -1 || grain > 0.76 ? 'needles' : 'pine');
      }
    }
  }
  return cells;
}

const scene = landscape();

export function drawLandscape(canvas, width, height, font) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  ctx.fillStyle = '#011401';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${cellHeight * 1.05}px ${font}`;
  scene.forEach((row, y) => row.forEach((cell, x) => {
    if (!cell) return;
    const [glyph, color] = cell;
    ctx.fillStyle = color;
    ctx.fillText(glyph, (x + 0.5) * cellWidth, (y + 0.5) * cellHeight);
  }));
}
