import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';
import { streamEvents } from './palette.mjs';
import { checkPalette, colorCells, paletteModels, preparePalette } from '../assets/palette-colors.mjs';

const palette = { background: '#031803', inks: ['#246321', '#389b2d', '#59cf48', '#39ff14'] };
const origin = 'https://cameronbeebe.github.io';
const env = { OPENROUTER_API_KEY: 'test-secret', PALETTE_LIMIT: { limit: async () => ({ success: true }) } };
function post(input, headers = {}) {
  return new Request('https://worker.example/palette', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
}
async function run(request, bindings = env) {
  const pending = [];
  const response = await worker.fetch(request, bindings, { waitUntil(promise) { pending.push(promise); } });
  const body = await response.text();
  await Promise.all(pending);
  return { response, body, events: response.ok ? body.trim().split('\n').map(JSON.parse) : [] };
}
function completion(value = palette, { finish = 'stop', done = true } = {}) {
  const content = JSON.stringify(value);
  const data = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
  return new Response(': keep-alive\r\n\r\n'
    + data({ provider: 'Test provider', choices: [{ delta: { reasoning: 'not a content token' } }] })
    + data({ choices: [{ delta: { content: content.slice(0, 10) } }] })
    + data({ choices: [{ delta: { content: content.slice(10) }, finish_reason: finish }] })
    + data({ choices: [{ delta: {}, finish_reason: finish }], usage: { cost: 0.000123, total_tokens: 87 } })
    + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('parallel fixed-model comparison returns validated palettes and actual usage', async t => {
  const calls = [];
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'manual');
    const body = JSON.parse(options.body);
    calls.push(body);
    if (calls.length === 3) release();
    await ready;
    assert.ok(body.max_tokens <= 1024);
    if (body.model === 'qwen/qwen3.6-35b-a3b') assert.equal(body.reasoning.enabled, false);
    else assert.equal(body.reasoning.effort, 'low');
    assert.deepEqual(body.provider.max_price, { prompt: 0.4, completion: 1 });
    assert.equal(body.provider.require_parameters, true);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(JSON.parse(body.messages[1].content).mood, 'cold steel');
    return completion();
  });
  const { response, events } = await run(post({ mood: 'cold steel', model: 'expensive-model', max_tokens: 999999 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Content-Type'), 'application/x-ndjson; charset=utf-8');
  assert.deepEqual(calls.map(c => c.model), paletteModels.map(m => m.id));
  assert.equal(events.filter(e => e.event === 'first').length, 3);
  const results = events.filter(e => e.event === 'result');
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.valid, true);
    assert.deepEqual(result.palette, preparePalette(palette).palette);
    assert.equal(result.cost, 0.000123);
    assert.equal(result.tokens, 87);
    assert.equal(result.provider, 'Test provider');
    assert.ok(result.firstMs <= result.readyMs && result.readyMs <= result.elapsedMs);
  }
  assert.equal(events.at(-1).event, 'done');
});

test('one failed provider does not discard the other results or invent cost', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (_, options) => JSON.parse(options.body).model === paletteModels[0].id
    ? new Response('unavailable', { status: 503 }) : completion());
  const { events } = await run(post({ mood: 'lantern-lit' }));
  const results = events.filter(e => e.event === 'result');
  assert.equal(results.filter(e => e.valid).length, 2);
  const failed = results.find(e => !e.valid);
  assert.equal(failed.cost, null);
  assert.equal(failed.readyMs, null);
  assert.equal(failed.palette, undefined);
});

test('truncated output cannot become an applicable palette, even if JSON was complete', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => completion(palette, { finish: 'length' }));
  const { events } = await run(post({ mood: 'rain' }));
  for (const result of events.filter(e => e.event === 'result')) {
    assert.equal(result.valid, false);
    assert.equal(result.readyMs, null);
    assert.equal(result.cost, 0.000123);
    assert.equal(result.reason, 'Output limit reached');
  }
});

test('a stream ending without its completion marker is reported as incomplete', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => completion(palette, { done: false }));
  const { events } = await run(post({ mood: 'rain' }));
  assert.ok(events.filter(e => e.event === 'result').every(e => !e.valid && e.reason === 'Incomplete response'));
});

test('format and legibility validation reject unsafe or unreadable colors', () => {
  assert.deepEqual(checkPalette(palette), { valid: true });
  for (const value of [null, { ...palette, extra: true }, { ...palette, inks: ['red'] }, { ...palette, background: 'url(x)' },
    { ...palette, background: '#ffffff' }, { ...palette, inks: [...palette.inks].reverse() }, { ...palette, inks: Array(4).fill('#121212') }]) {
    assert.equal(checkPalette(value).valid, false);
  }
});

test('display lightness is computed from model hues, including bright or all-dark proposals', () => {
  for (const value of [palette, { background: '#ffffff', inks: ['#000000', '#010101', '#010101', '#121212'] },
    { background: '#000000', inks: ['#fa2312', '#ee4511', '#ffdd33', '#dd9234'] }]) {
    const result = preparePalette(value);
    assert.equal(result.valid, true);
    assert.equal(checkPalette(result.palette).valid, true);
  }
  assert.equal(preparePalette({ background: 'red', inks: [] }).valid, false);
});

test('recoloring preserves glyphs, density, missing cells, marks, and the source objects for undo', () => {
  const source = [{ glyph: '@', tone: 1, rank: 47, ink: '#aaa', backdrop: '#f00' }, null, { glyph: '.', tone: 0, rank: 0, ink: '#bbb' }];
  const before = structuredClone(source);
  const result = colorCells(source, palette);
  assert.deepEqual(source, before);
  assert.equal(result[1], null);
  assert.equal(result[0].glyph, source[0].glyph);
  assert.equal(result[0].rank, source[0].rank);
  assert.equal(result[0].tone, source[0].tone);
  assert.equal(result[0].backdrop, '#f00');
  assert.equal(result[0].ink, palette.inks[3]);
  assert.equal(result[2].ink, palette.inks[0]);
});

test('SSE decoder preserves split UTF-8 and accepts comments, CRLF, and final partial framing', async () => {
  const encoded = new TextEncoder().encode(': ignore\r\ndata: {"provider":"雪"}\r\n\r\ndata: [DONE]');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const events = [];
  for await (const value of streamEvents(stream)) events.push(value);
  assert.deepEqual(events, ['{"provider":"雪"}', '[DONE]']);
});

test('rejects bad input, origins, missing setup, and rate excess before paid calls', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  for (const input of [{ mood: '' }, { mood: 'x'.repeat(121) }, { mood: 17 }, { mood: 'ok', padding: 'x'.repeat(1024) }]) {
    assert.equal((await run(post(input))).response.status, 400);
  }
  assert.equal((await run(post({ mood: 'rain' }, { Origin: 'https://other.example' }))).response.status, 403);
  assert.equal((await run(post({ mood: 'rain' }), {})).response.status, 503);
  const limited = await run(post({ mood: 'rain' }), { ...env, PALETTE_LIMIT: { limit: async () => ({ success: false }) } });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('Retry-After'), '60');
  assert.equal(fetch.mock.callCount(), 0);
});
