import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';

function fixture(valid = true) {
  const runId = crypto.randomUUID();
  return { feedbackId: crypto.randomUUID(), sequence: 1, rating: -1, run: { version: 3, runId,
    optimization: { id: 'gepa-example', instructions: 'Composition advice.' },
    attempts: [{ id: crypto.randomUUID(), runId, step: 1, model: 'qwen/qwen3.6-35b-a3b', name: 'Qwen 3.6', brief: 'A diamond.',
      harness: { tools: false, guidance: false, feedback: true, optimized: true }, valid,
      prompt: [{ role: 'system', content: 'The exact system message.' }, { role: 'user', content: 'A diamond.' }],
      raw: '{"rows":[]}', rows: valid ? Array(50).fill('O'.repeat(75)) : undefined,
      cost: 0.001, provider: 'A provider', reasoningTokens: 12,
      judge: { judgments: { match: { score: 1, probabilities: { 0: .5, 2: .5 } } } },
    }],
  } };
}
function request(body, origin = 'https://cameronbeebe.github.io') {
  return new Request('https://worker.example/ascii/feedback', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify(body) });
}
function bindings() {
  const stored = [];
  return { stored, FEEDBACK_LIMIT: { limit: async () => ({ success: true }) },
    ASCII_FEEDBACK: { async put(key, value) { stored.push([key, JSON.parse(value)]); } } };
}

test('a vote privately preserves the entire package and acknowledges only a successful write', async t => {
  const paid = t.mock.method(globalThis, 'fetch', async () => { throw Error('No model call should be made'); });
  const env = bindings(), input = fixture();
  const response = await worker.fetch(request(input), env, {});
  assert.equal(response.status, 201); assert.equal((await response.json()).saved, true);
  assert.equal(env.stored.length, 1);
  const [key, record] = env.stored[0];
  assert.ok(key.startsWith(`feedback/${input.run.runId}/`));
  assert.deepEqual(record.run, input.run); assert.equal(record.rating, -1);
  assert.equal(record.feedbackId, input.feedbackId); assert.equal(record.sequence, 1);
  assert.equal(JSON.stringify(record).includes('192.0.2.1'), false);
  assert.match(record.provenance, /client-supplied/); assert.equal(paid.mock.callCount(), 0);
});

test('changing a vote appends an event so offline analysis can select its latest sequence', async () => {
  const env = bindings(), value = fixture();
  await worker.fetch(request(value), env, {});
  await worker.fetch(request({ ...value, rating: 1, sequence: 2 }), env, {});
  assert.notEqual(env.stored[0][0], env.stored[1][0]);
  assert.equal(env.stored[0][1].feedbackId, env.stored[1][1].feedbackId);
  assert.deepEqual(env.stored.map(([, value]) => [value.sequence, value.rating]), [[1, -1], [2, 1]]);
});

test('unfinished runs can be labeled without pretending that they passed validation', async () => {
  const env = bindings(), value = fixture(false);
  value.run.attempts[0].workspaceRows = Array(50).fill(' '.repeat(75));
  assert.equal((await worker.fetch(request(value), env, {})).status, 201);
  assert.equal(env.stored[0][1].run.attempts[0].valid, false);
});

test('malformed configurations, mixed traces, and fake passing grids are rejected before storage', async () => {
  const cases = [value => { value.rating = 0; }, value => { value.sequence = 0; }, value => { value.feedbackId = 'bad'; },
    value => { value.run.attempts[0].rows = ['broken']; }, value => { value.run.attempts[0].runId = crypto.randomUUID(); },
    value => { value.run.attempts[0].harness.guidance = true; }, value => { value.run.attempts[0].model = 'unknown'; },
    value => { value.run.attempts.push({ ...value.run.attempts[0], id: crypto.randomUUID(), step: 2, brief: 'Another task' }); }];
  const env = bindings();
  for (const change of cases) { const value = fixture(); change(value); assert.equal((await worker.fetch(request(value), env, {})).status, 400); }
  assert.equal(env.stored.length, 0);
});

test('origin, rate, request size, and storage failure cannot produce a false saved response', async t => {
  const env = bindings();
  assert.equal((await worker.fetch(request(fixture(), 'https://other.example'), env, {})).status, 403);
  assert.equal((await worker.fetch(request(fixture()), {}, {})).status, 503);
  assert.equal((await worker.fetch(request(fixture()), { ...env, FEEDBACK_LIMIT: { limit: async () => ({ success: false }) } }, {})).status, 429);
  const large = fixture(); large.padding = 'x'.repeat(8000000);
  assert.equal((await worker.fetch(request(large), env, {})).status, 400);
  t.mock.method(console, 'error', () => {});
  const failed = await worker.fetch(request(fixture()), { ...env, ASCII_FEEDBACK: { put: async () => { throw Error('unavailable'); } } }, {});
  assert.equal(failed.status, 503); assert.equal((await failed.json()).saved, undefined);
  assert.equal(env.stored.length, 0);
});
