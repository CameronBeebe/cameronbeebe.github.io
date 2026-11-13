export const paletteModels = [
  { id: 'thinkingmachines/inkling-2-small', name: 'Inkling 2 Small' },
  { id: 'qwen/qwen3.6-35b-a3b', name: 'Qwen 3.6' },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' },
];

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(n => parseInt(n, 16) / 255)
    .map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function checkShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'background,inks'
    || !Array.isArray(value.inks) || value.inks.length !== 4
    || ![value.background, ...value.inks].every(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))) {
    return { valid: false, reason: 'Invalid palette JSON' };
  }
  return { valid: true };
}

export function checkPalette(value) {
  const shape = checkShape(value);
  if (!shape.valid) return shape;
  const bg = luminance(value.background);
  const levels = value.inks.map(luminance);
  const contrast = levels.map(n => (n + 0.05) / (bg + 0.05));
  if (bg > 0.035 || contrast[0] < 2 || contrast[3] < 7 || levels.some((n, i) => i && n <= levels[i - 1])) {
    return { valid: false, reason: 'JSON valid; contrast check failed' };
  }
  return { valid: true };
}

function mix(hex, target, amount) {
  return '#' + hex.slice(1).match(/../g).map(n => Math.round(parseInt(n, 16) * (1 - amount) + target * amount)
    .toString(16).padStart(2, '0')).join('');
}

// The model chooses hues; code owns the exact display constraints.
export function preparePalette(value) {
  const shape = checkShape(value);
  if (!shape.valid) return shape;
  let background = value.background;
  while (luminance(background) > 0.035) background = mix(background, 0, 0.1);
  const levels = [2.2, 3.5, 5.5, 8];
  const bg = luminance(background);
  const inks = [...value.inks].sort((a, b) => luminance(a) - luminance(b)).map((color, index) => {
    // Preserve the hue by mixing toward white/black, using binary search for the target lightness.
    const goal = levels[index] * (bg + 0.05) - 0.05;
    const target = luminance(color) < goal ? 255 : 0;
    let low = 0, high = 1;
    for (let step = 0; step < 16; step++) {
      const mid = (low + high) / 2;
      const light = luminance(mix(color, target, mid));
      if ((target === 255 && light < goal) || (target === 0 && light > goal)) low = mid;
      else high = mid;
    }
    return mix(color, target, high);
  });
  const palette = { background, inks };
  return { ...checkPalette(palette), palette, adjusted: JSON.stringify(palette) !== JSON.stringify(value) };
}

export function colorCells(cells, palette) {
  return cells.map(cell => cell && {
    ...cell,
    ink: palette.inks[Math.round(Math.max(0, Math.min(1, cell.tone)) * 3)],
    paper: palette.background,
  });
}
