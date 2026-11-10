export const glyphs = ' .,:;*oxO%#@';

const mechanicsGlyphs = { '+': '*', '~': 'o', '=': '@', '<': '*', '>': '*', '^': '*', v: '*' };

export function glyphDensity(glyph) {
  return Math.max(0, glyphs.indexOf(mechanicsGlyphs[glyph] ?? glyph)) / (glyphs.length - 1);
}

export function sampleImageTones(image, columns, rows) {
  const { naturalWidth: width, naturalHeight: height } = image;
  const sample = document.createElement('canvas');
  sample.width = width;
  sample.height = height;

  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;

  // Average the source area covered by each cell, including partial pixels at its edges.
  return Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = column * width / columns;
    const right = (column + 1) * width / columns;
    const top = row * height / rows;
    const bottom = (row + 1) * height / rows;
    let sum = 0;
    for (let y = Math.floor(top); y < bottom; y++) {
      const overlapY = Math.min(y + 1, bottom) - Math.max(y, top);
      for (let x = Math.floor(left); x < right; x++) {
        const overlapX = Math.min(x + 1, right) - Math.max(x, left);
        const i = (y * width + x) * 4;
        const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
        sum += luminance * overlapX * overlapY;
      }
    }
    const luminance = sum / ((right - left) * (bottom - top));
    return Math.min(1, Math.max(0, (luminance - 12) / 183));
  });
}
