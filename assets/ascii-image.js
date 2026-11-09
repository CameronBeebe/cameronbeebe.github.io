export const glyphs = ' .,:;*oxO%#@';

const mechanicsGlyphs = { '+': '*', '~': 'o', '=': '@', '<': '*', '>': '*', '^': '*', v: '*' };

export function glyphDensity(glyph) {
  return Math.max(0, glyphs.indexOf(mechanicsGlyphs[glyph] ?? glyph)) / (glyphs.length - 1);
}

export function sampleImageTones(image, columns, rows) {
  const sample = document.createElement('canvas');
  sample.width = columns;
  sample.height = rows;

  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, columns, rows);
  const pixels = ctx.getImageData(0, 0, columns, rows).data;

  return Array.from({ length: columns * rows }, (_, index) => {
    const i = index * 4;
    const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    return Math.min(1, Math.max(0, (luminance - 12) / 183));
  });
}
