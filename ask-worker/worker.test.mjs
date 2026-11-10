import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cvPassages } from '../assets/cv-passages.mjs';
import worker from './worker.mjs';

const origin = 'https://cameronbeebe.github.io';
const cv = readFileSync(new URL('../cv.md', import.meta.url), 'utf8');
const env = { TYPESAFE_API_KEY: 'test-secret', ASK_LIMIT: { limit: async () => ({ success: true }) } };

function post(body, headers = {}) {
  return new Request('https://worker.example/ask', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('extracts public CV passages with headings and readable text', () => {
  const passages = cvPassages(cv);
  assert.ok(passages.some(p => p.heading.includes('Appy.AI') && p.text.includes('eval dashboard')));
  assert.ok(passages.some(p => p.text.startsWith('fungi_fortress / fungi_chromatic')));
  assert.ok(passages.every(p => !p.text.includes('mailto:') && p.text.length));
});

test('returns only ranked CV excerpts or an empty result when evidence is weak', async t => {
  let score = 0.95;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === `${origin}/cv.md`) {
      assert.equal(options.headers, undefined);
      return new Response(cv);
    }
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const { state, questions } = JSON.parse(options.body);
    assert.equal(state.visitor_question, 'What did Cameron build?');
    assert.ok(Object.values(questions).every(q => q.type === 'noul'));
    calls++;
    const answers = Object.fromEntries(Object.entries(state.passages).map(([id, passage]) => [id, {
      type: 'noul', noul: passage.heading.includes('Appy.AI') ? score : 0.1,
    }]));
    answers.unknown = { type: 'noul', noul: 1, text: 'Fake passage' };
    return Response.json({ answers });
  });

  const match = await worker.fetch(post({ question: 'What did Cameron build?' }), env);
  assert.equal(match.headers.get('Access-Control-Allow-Origin'), origin);
  assert.deepEqual(await match.json(), {
    excerpts: cvPassages(cv).filter(p => p.heading.includes('Appy.AI')),
  });
  score = 0.6;
  const miss = await worker.fetch(post({ question: 'What did Cameron build?' }), env);
  assert.deepEqual(await miss.json(), { excerpts: [] });
  assert.equal(calls, 2);
});

test('rejects invalid and rate-limited requests before calling upstream', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected upstream request'));
  assert.equal((await worker.fetch(post({ question: 'valid' }, { Origin: 'https://other.example' }), env)).status, 403);
  assert.equal((await worker.fetch(post({ question: ' ' }), env)).status, 400);
  assert.equal((await worker.fetch(post({ question: 'x'.repeat(281) }), env)).status, 400);
  assert.equal((await worker.fetch(post({ question: 'x'.repeat(4096) }), env)).status, 413);
  assert.equal((await worker.fetch(post({ question: 'valid' }), {})).status, 503);
  const limited = { ...env, ASK_LIMIT: { limit: async () => ({ success: false }) } };
  assert.equal((await worker.fetch(post({ question: 'valid' }), limited)).status, 429);
  assert.equal(upstream.mock.callCount(), 0);
});

test('reports malformed model output as an outage', async t => {
  t.mock.method(globalThis, 'fetch', async url => url === `${origin}/cv.md`
    ? new Response(cv) : Response.json({ answers: {} }));
  const response = await worker.fetch(post({ question: 'What did Cameron build?' }), env);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /unavailable/);
});
