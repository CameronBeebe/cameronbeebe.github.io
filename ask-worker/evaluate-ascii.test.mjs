import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize } from './evaluate-ascii.mjs';

test('experiment summaries retain failures, incomplete streams, and missing billing', () => {
  const summary = summarize([
    { mode: 'repair', completed: true, elapsedMs: 20, drafts: [{ valid: false, cost: 0.01 }, { valid: true, cost: 0.02 }] },
    { mode: 'repair', completed: true, elapsedMs: 30, drafts: [{ valid: false, cost: null }] },
    { mode: 'repair', completed: false, elapsedMs: 40, drafts: [{ valid: true, cost: null }] },
    { mode: 'repair', completed: false, elapsedMs: 10, drafts: [], startedDrafts: [{ id: 'interrupted' }] },
  ]).repair;
  assert.deepEqual(summary, { runs: 4, completedStreams: 2, firstDraftPasses: 1, finalPasses: 1,
    generationCalls: 5, reportedCost: 0.03, unreportedCosts: 3, elapsedMs: 100 });
});
