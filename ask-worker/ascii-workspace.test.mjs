import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspace } from '../assets/ascii-workspace.mjs';

test('a full grid can be created once, revised by rows and columns, and submitted', () => {
  const workspace = createWorkspace(), rows = Array(50).fill('.'.repeat(75));
  assert.equal(workspace.execute('create_grid', { width: 75, height: 50, rows }).ok, true);
  rows[0] = '@'.repeat(75); // Caller-owned input cannot mutate stored state.
  assert.equal(workspace.snapshot()[0], '.'.repeat(75));
  assert.deepEqual(workspace.execute('write_rows', { updates: [{ row: 2, text: 'O'.repeat(75) }, { row: 7, text: '*'.repeat(75) }] }).accepted, [2, 7]);
  workspace.execute('write_columns', { updates: [{ column: 75, text: '#'.repeat(50) }] });
  assert.equal(workspace.snapshot()[1], 'O'.repeat(74) + '#');
  assert.equal(workspace.snapshot()[6], '*'.repeat(74) + '#');
  assert.equal(workspace.execute('submit_grid', {}).submitted, true);
  workspace.execute('write_rows', { updates: [{ row: 1, text: ' '.repeat(75) }] });
  assert.equal(workspace.submitted, false);
});

test('invalid writes preserve progress, accepted siblings apply, and reset is atomic', () => {
  const workspace = createWorkspace();
  workspace.execute('create_grid', { width: 75, height: 50, rows: null });
  const result = workspace.execute('write_rows', { updates: [
    { row: 1, text: '@'.repeat(79) }, { row: 2, text: 'O'.repeat(75) }, { row: 3, text: '?'.repeat(75) },
  ] });
  assert.deepEqual(result.accepted, [2]);
  assert.equal(result.rejected[0].actual, 79);
  assert.equal(workspace.snapshot()[0], ' '.repeat(75));
  assert.equal(workspace.snapshot()[1], 'O'.repeat(75));
  assert.equal(workspace.execute('create_grid', { width: 75, height: 50, rows: ['broken'] }).ok, false);
  assert.equal(workspace.snapshot()[1], 'O'.repeat(75));
  assert.equal(workspace.execute('create_grid', { width: 100000, height: 100000, rows: null }).ok, false);
});

test('workspace boundaries, arguments and the feedback switch cannot bypass validation', () => {
  const workspace = createWorkspace();
  assert.equal(workspace.execute('write_rows', { updates: [] }).ok, false);
  assert.equal(workspace.execute('submit_grid', {}).submitted, false);
  workspace.execute('create_grid', { width: 75, height: 50, rows: null });
  for (const args of [{ updates: [{ row: 0, text: '@'.repeat(75) }] }, { updates: [{ row: 51, text: '@'.repeat(75) }] },
    { updates: [{ row: 1, text: '@'.repeat(75), extra: true }] }]) assert.equal(workspace.execute('write_rows', args).ok, false);
  const hidden = workspace.execute('write_rows', { updates: [{ row: 1, text: '@'.repeat(79) }] }, false);
  assert.deepEqual(hidden.rejected, [{ message: 'Rejected.' }]);
  assert.equal(workspace.snapshot()[0], ' '.repeat(75));
  assert.equal(workspace.execute('unknown', {}).ok, false);
});

test('short writes change only addressed cells without padding or cropping', () => {
  const workspace = createWorkspace();
  workspace.execute('create_grid', { width: 75, height: 50, rows: Array(50).fill('.'.repeat(75)) });
  workspace.execute('write_rows', { updates: [{ row: 4, text: '@O' }] });
  assert.equal(workspace.snapshot()[3], '@O' + '.'.repeat(73));
  workspace.execute('write_columns', { updates: [{ column: 75, text: 'ox' }] });
  assert.equal(workspace.snapshot()[0], '.'.repeat(74) + 'o');
  assert.equal(workspace.snapshot()[1], '.'.repeat(74) + 'x');
  assert.equal(workspace.snapshot()[2], '.'.repeat(75));
});

test('create_grid can initialize short row prefixes without coercing invalid glyphs or overflowing', () => {
  const workspace = createWorkspace();
  assert.equal(workspace.execute('create_grid', { width: 75, height: 50, rows: ['O@', '', '  *'] }).ok, true);
  assert.equal(workspace.snapshot()[0], 'O@' + ' '.repeat(73));
  assert.equal(workspace.snapshot()[1], ' '.repeat(75));
  assert.equal(workspace.snapshot()[2], '  *' + ' '.repeat(72));
  const before = workspace.snapshot();
  assert.equal(workspace.execute('create_grid', { width: 75, height: 50, rows: ['@'.repeat(76)] }).ok, false);
  assert.deepEqual(workspace.snapshot(), before);
});
