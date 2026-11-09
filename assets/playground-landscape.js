import { glyphs, sampleImageTones } from './ascii-image.js';

export const columns = 150;
export const rows = 65;

export function createLandscape(canvas, image, font) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const inks = ['#214d20', '#397532', '#559846', '#7eb565'];
  const original = sampleImageTones(image, columns, rows).map(tone => {
    // Treat the carved dark lines as ink and the pale paper as open space.
    const density = 1 - tone;
    return {
      glyph: glyphs[Math.round(density * (glyphs.length - 1))],
      ink: inks[Math.round(density * (inks.length - 1))],
    };
  });
  const cells = original.slice();
  const scars = new Uint32Array(cells.length);
  let previous;

  function cut(center, id) {
    const x = center % columns;
    const y = Math.floor(center / columns);
    const patch = [];
    for (let row = Math.max(0, y - 3); row <= Math.min(rows - 1, y + 3); row++) {
      for (let col = Math.max(0, x - 5); col <= Math.min(columns - 1, x + 5); col++) {
        if (((col - x) / 5) ** 2 + ((row - y) / 3) ** 2 > 1) continue;
        const index = row * columns + col;
        patch.push(index);
        scars[index] = id;
        cells[index] = { glyph: (col + row) % 3 ? '.' : ':', ink: '#987d4e' };
      }
    }
    return patch;
  }

  function repair(goal) {
    for (const index of goal.patch) {
      if (scars[index] !== goal.id) continue;
      cells[index] = original[index];
      scars[index] = 0;
    }
  }

  function reset() {
    original.forEach((cell, index) => { cells[index] = cell; });
    scars.fill(0);
  }

  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (pixelWidth === canvas.width && pixelHeight === canvas.height) return;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    previous = undefined;
  }

  function draw(frame) {
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    ctx.font = (cellHeight * 1.02) + 'px ' + font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (!previous) {
      ctx.fillStyle = '#031803';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    frame.forEach(({ glyph, ink }, index) => {
      const old = previous?.[index];
      if (old?.glyph === glyph && old.ink === ink) return;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = Math.round(column * cellWidth);
      const y = Math.round(row * cellHeight);
      const width = Math.round((column + 1) * cellWidth) - x;
      const height = Math.round((row + 1) * cellHeight) - y;
      if (old && old.glyph !== ' ') {
        ctx.fillStyle = '#031803';
        ctx.fillRect(x, y, width, height);
      }
      if (glyph === ' ') return;
      // Clip to the same pixel bounds used for erasure so moving glyphs leave no fragments.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.fillStyle = ink;
      ctx.fillText(glyph, (column + 0.5) * cellWidth, (row + 0.5) * cellHeight, cellWidth);
      ctx.restore();
    });
    previous = frame;
  }

  new ResizeObserver(resize).observe(canvas);
  resize();
  return { cells, cut, repair, reset, draw };
}
