import assert from 'node:assert/strict';
import test from 'node:test';
import { fuelFor, igniteCell, fireStep } from './portrait-fire.mjs';

const cell = glyph => ({ glyph, tone: 0.5, ink: '#39ff14', rank: 20 });

test('visible density determines fuel and burn duration, independently of hidden tone or palette', () => {
  const light = cell('.'), dense = cell('@');
  assert.ok(fuelFor(dense) > fuelFor(light));
  assert.equal(fuelFor({ ...light, tone: 1, ink: '#ffffff' }), fuelFor(light));
  function duration(source) {
    let grid = [igniteCell(source)], ticks = 0;
    while (!grid[0].fire.ash && ticks < 100) {
      grid = fireStep(grid, 1, 1, ticks++).next;
    }
    return ticks;
  }
  assert.ok(duration(dense) > duration(light));
  assert.equal(duration(dense), fuelFor(dense));
});

test('heat builds over multiple steps before igniting a neighbor', () => {
  let grid = [igniteCell(cell('@')), cell('O')];
  grid = fireStep(grid, 2, 1).next;
  assert.ok(grid[1].fire.heat > 0);
  assert.ok(!grid[1].fire.burning);
  for (let i = 0; i < 10 && !grid[1].fire.burning; i++) grid = fireStep(grid, 2, 1, i).next;
  assert.equal(grid[1].fire.burning, true);
});

test('spaces, erased cells, walls, and ash cannot supply fuel', () => {
  for (const source of [null, cell(' '), { ...cell('@'), wall: true }, { ...cell('.'), fire: { ash: true, fuel: 0 } }]) {
    assert.equal(fuelFor(source), 0);
    assert.equal(igniteCell(source), source);
  }
  const sources = [igniteCell(cell('@')), null, cell(' '), { ...cell('@'), wall: true }];
  const next = fireStep(sources, 4, 1).next;
  assert.equal(next[1], null);
  assert.equal(next[2], sources[2]);
  assert.equal(next[3], sources[3]);
});

test('a finite portrait burns out, leaves ash, and preserves prior states for undo', () => {
  const source = [cell('@'), cell('O'), cell('.')];
  const saved = structuredClone(source);
  let grid = [igniteCell(source[0]), ...source.slice(1)];
  let result;
  for (let i = 0; i < 200; i++) {
    result = fireStep(grid, 3, 1, i);
    grid = result.next;
    if (!result.burning && !result.warm) break;
  }
  assert.equal(result.burning, 0);
  assert.equal(result.warm, 0);
  assert.equal(result.ash, 3);
  assert.ok(grid.every(c => c.fire.ash && c.fire.fuel === 0));
  assert.deepEqual(source, saved);
});

test('heat is stronger above a flame and does not wrap around grid edges', () => {
  const grid = Array.from({ length: 9 }, () => cell('@'));
  grid[4] = igniteCell(grid[4]);
  const result = fireStep(grid, 3, 3).next;
  assert.ok(result[1].fire.heat > result[7].fire.heat);
  const edge = [cell('@'), cell('@'), igniteCell(cell('@')), cell('@'), cell('@'), cell('@')];
  const next = fireStep(edge, 3, 2).next;
  assert.equal(next[3].fire, undefined);
});
