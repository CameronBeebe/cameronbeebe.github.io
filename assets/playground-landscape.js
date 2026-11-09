import { glyphs, sampleImageTones } from './ascii-image.js';

export const columns = 150;
export const rows = 65;
const background = '#031803';

export function createLandscape(canvas, image, font) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const inks = ['#214d20', '#397532', '#559846', '#7eb565'];
  const cells = sampleImageTones(image, columns, rows).map(tone => {
    // Treat the carved dark lines as ink and the pale paper as open space.
    const density = 1 - tone;
    return {
      glyph: glyphs[Math.round(density * (glyphs.length - 1))],
      ink: inks[Math.round(density * (inks.length - 1))],
    };
  });
  let previous;

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
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    frame.forEach(({ glyph, ink, backdrop }, index) => {
      const old = previous?.[index];
      if (old?.glyph === glyph && old.ink === ink && old.backdrop === backdrop) return;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = Math.round(column * cellWidth);
      const y = Math.round(row * cellHeight);
      const width = Math.round((column + 1) * cellWidth) - x;
      const height = Math.round((row + 1) * cellHeight) - y;
      if (backdrop || old?.backdrop || (old && old.glyph !== ' ')) {
        ctx.fillStyle = backdrop ?? background;
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
  return { cells, draw };
}
