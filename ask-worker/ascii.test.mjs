import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';
import { checkAscii, asciiRubrics } from '../assets/ascii-contract.mjs';

const rows = Array.from({ length: 50 }, (_, i) => ' '.repeat(5) + (i % 2 ? 'O' : '@').repeat(65) + ' '.repeat(5));
const input = { brief: 'frog samurai', model: 'qwen/qwen3.6-35b-a3b', mode: 'single' };
const env = { OPENROUTER_API_KEY: 'openrouter-test', TYPESAFE_API_KEY: 'jev-test', ASCII_LIMIT: { limit: async () => ({ success: true }) } };
const image = 'iVBORw0KGgoAAA==';
function post(value, judge = false, headers = {}) {
  return new Request(`https://worker.example/ascii/${judge ? 'judge' : 'generate'}`, {
    method: 'POST', headers: { Origin: 'https://cameronbeebe.github.io', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
}
async function run(request, bindings = env) {
  const pending = [];
  const response = await worker.fetch(request, bindings, { waitUntil(promise) { pending.push(promise); } });
  const body = await response.text(); await Promise.all(pending);
  return { response, body, events: response.ok && response.headers.get('Content-Type').includes('ndjson') ? body.trim().split('\n').map(JSON.parse) : [] };
}
function completion(value, finish = 'stop') {
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  const chunks = [];
  for (let i = 0; i < content.length; i += 110) chunks.push({ provider: 'Test provider', choices: [{ delta: { content: content.slice(i, i + 110) } }] });
  chunks.push({ choices: [{ delta: {}, finish_reason: finish }], usage: { cost: 0.003, total_tokens: 3900 } });
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
}

test('grid contract checks every literal cell and preserves edge spaces', () => {
  assert.equal(checkAscii({ rows }).valid, true);
  for (const value of [{ rows: rows.slice(1) }, { rows: [...rows, rows[0]] }, { rows: ['@'.repeat(74), ...rows.slice(1)] },
    { rows: ['?'.repeat(75), ...rows.slice(1)] }, { rows, explanation: 'extra' }]) assert.equal(checkAscii(value).valid, false);
});

test('direct generation returns exact model-written rows, costs, provider, and prompt', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer openrouter-test');
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.properties.rows.minItems, 50);
    assert.equal(body.response_format.json_schema.schema.properties.rows.items.minLength, 75);
    assert.equal(body.max_tokens, 32768);
    assert.equal(body.reasoning.enabled, false);
    assert.ok(body.messages.every(m => typeof m.content === 'string'));
    assert.equal(body.messages.length, 2);
    return completion({ rows });
  });
  const { response, events } = await run(post(input));
  assert.equal(response.status, 200);
  const partial = events.find(e => e.event === 'progress');
  assert.ok(partial.raw.length > 0);
  assert.ok(JSON.stringify({ rows }).startsWith(partial.raw));
  const started = events.find(e => e.event === 'draft');
  assert.equal(started.name, 'Qwen 3.6');
  assert.equal(started.cost, null);
  assert.equal(started.prompt.length, 2);
  const result = events.find(e => e.event === 'result');
  assert.equal(result.valid, true);
  assert.deepEqual(result.rows, rows);
  assert.equal(result.rows[0].length, 75);
  assert.equal(result.cost, 0.003);
  assert.equal(result.tokens, 3900);
  assert.equal(result.provider, 'Test provider');
  assert.equal(result.strategy, 'Initial prompt');
  assert.ok(result.readyMs >= result.firstMs);
});

test('invalid or truncated grids remain failed attempts with raw evidence', async t => {
  t.mock.method(console, 'error', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion({ rows: rows.slice(1) }));
  let result = (await run(post(input))).events.find(e => e.event === 'result');
  assert.equal(result.valid, false);
  assert.equal(result.rows, undefined);
  assert.match(result.reason, /49/);
  assert.ok(result.raw.includes('rows'));
  fetch.mock.mockImplementation(async () => completion({ rows }, 'length'));
  result = (await run(post(input))).events.find(e => e.event === 'result');
  assert.equal(result.valid, false);
  assert.equal(result.rows, undefined);
  assert.equal(result.cost, 0.003);
});

test('validator reports every incorrect width and forbidden character with coordinates', () => {
  const broken = [...rows]; broken[0] = '@'.repeat(79); broken[4] = '😀' + 'O'.repeat(73);
  const result = checkAscii({ rows: broken });
  assert.deepEqual(result.errors.map(e => [e.code, e.row, e.actual]), [
    ['row_length', 1, 79], ['row_length', 5, 74], ['alphabet', 5, undefined],
  ]);
  assert.deepEqual(result.errors[2].invalid, [{ column: 1, character: '😀' }]);
});

test('repair sends actual failed output and all validator errors back, with immutable lineage', async t => {
  const broken = [...rows]; broken[0] = '@'.repeat(79); broken[6] = '?'.repeat(75);
  const prompts = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body); prompts.push(body.messages);
    if (prompts.length === 1) return completion({ rows: broken });
    assert.equal(body.reasoning.effort, 'minimal');
    assert.deepEqual(JSON.parse(body.messages[2].content), { rows: broken });
    const feedback = JSON.parse(body.messages[3].content);
    assert.equal(feedback.source, 'Deterministic grid validator');
    assert.deepEqual(feedback.errors, checkAscii({ rows: broken }).errors);
    assert.equal(feedback.judgments, undefined);
    return completion({ rows });
  });
  const { events } = await run(post({ ...input, mode: 'repair', model: 'thinkingmachines/inkling-2-small' }));
  const drafts = events.filter(e => e.event === 'result');
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].valid, false); assert.equal(drafts[1].valid, true);
  assert.equal(drafts[1].parentId, drafts[0].id);
  assert.equal(drafts[1].runId, drafts[0].runId);
  assert.equal(drafts[0].prompt.length, 2); assert.equal(drafts[1].prompt.length, 4);
  assert.equal(drafts[0].stopReason, null); assert.equal(drafts[1].stopReason, 'structure_passed');
  assert.equal(drafts[0].cost, 0.003); assert.equal(drafts[1].cost, 0.003);
  assert.deepEqual(drafts[1].rows, rows); // No code-side padding, cropping, or substitution.
  assert.equal(prompts.length, 2);
});

test('repair can recover invalid JSON and stops at three drafts if it cannot', async t => {
  t.mock.method(console, 'error', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => completion('not JSON'));
  const { events } = await run(post({ ...input, mode: 'repair' }));
  const drafts = events.filter(e => e.event === 'result');
  assert.equal(drafts.length, 3); assert.equal(fetch.mock.callCount(), 3);
  assert.equal(drafts[2].stopReason, 'draft_budget');
  assert.equal(drafts[2].valid, false); assert.equal(drafts[2].raw, 'not JSON');
  assert.equal(JSON.parse(drafts[1].prompt[3].content).errors[0].code, 'json');
  assert.equal(drafts[2].prompt[2].content, 'not JSON');
  assert.equal(drafts[2].prompt.length, 6);
});

test('fresh retry control gets the same initial prompt without feedback and the same draft ceiling', async t => {
  const prompts = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    prompts.push(JSON.parse(options.body).messages);
    return completion({ rows: rows.slice(1) });
  });
  const { events } = await run(post({ ...input, mode: 'retry' }));
  const drafts = events.filter(e => e.event === 'result');
  assert.equal(drafts.length, 3); assert.equal(drafts[2].stopReason, 'draft_budget');
  assert.deepEqual(prompts[0], prompts[1]); assert.deepEqual(prompts[1], prompts[2]);
  assert.equal(drafts[1].strategy, 'Fresh retry');
});

test('provider errors and exhausted output budgets do not trigger paid repair calls', async t => {
  t.mock.method(console, 'error', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  let drafts = (await run(post({ ...input, mode: 'repair' }))).events.filter(e => e.event === 'result');
  assert.equal(drafts.length, 1); assert.equal(drafts[0].stopReason, 'provider_failure');
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => completion({ rows }, 'length'));
  drafts = (await run(post({ ...input, mode: 'repair' }))).events.filter(e => e.event === 'result');
  assert.equal(drafts.length, 1); assert.equal(drafts[0].stopReason, 'provider_failure');
  assert.equal(drafts[0].rows, undefined);
});

test('Jev judges one rendered image with parallel rubric questions, without generator identity', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers['TypeSafe-Danger-Zone-Images'], 'true');
    assert.equal(options.headers.Authorization, 'Bearer jev-test');
    const body = JSON.parse(options.body);
    assert.equal(body.assets[body.state.artwork].data_base64, image);
    assert.equal(body.state.brief, input.brief);
    assert.equal(body.state.model, undefined);
    assert.equal(Object.keys(body.assets).length, 1);
    assert.deepEqual(Object.keys(body.questions), ['match', 'readability']);
    return Response.json({ model: 'jev-1.14.0', usage: { input_tokens: 1200 }, answers: Object.fromEntries(['match', 'readability'].map(id => [id,
      { type: 'score', score: 2.2, confidence: 0.6, probabilities: { 0: 0, 1: 0, 2: 0.8, 3: 0.2 } }])) });
  });
  const { response, body } = await run(post({ brief: input.brief, rows, image }, true));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(body).judgments.match.score, 2.2);
});

test('invalid scores are surfaced as judge failures, not optimistic defaults', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ answers: { match: { type: 'score', score: 9 } } }));
  assert.equal((await run(post({ brief: input.brief, rows, image }, true))).response.status, 503);
});

test('bad inputs, origins, configuration, and rate limits do not reach paid services', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('must not call'); });
  for (const value of [{ ...input, model: 'expensive' }, { ...input, brief: '' }, { ...input, brief: 'x'.repeat(301) },
    { ...input, mode: 'infinite' }, { ...input, previous: ['broken'] }, { ...input, previous: rows, feedback: { match: 99, readability: 1 } }]) assert.equal((await run(post(value))).response.status, 400);
  assert.equal((await run(post(input, false, { Origin: 'https://other.example' }))).response.status, 403);
  assert.equal((await run(post(input), {})).response.status, 503);
  const limited = { ...env, ASCII_LIMIT: { limit: async () => ({ success: false }) } };
  assert.equal((await run(post(input), limited)).response.status, 429);
  assert.equal((await run(post({ brief: input.brief, rows, image }, true), limited)).response.status, 429);
  assert.equal(fetch.mock.callCount(), 0);
});
