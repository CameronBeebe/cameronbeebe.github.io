import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cvPassages } from '../assets/cv-passages.mjs';
import worker from './worker.mjs';

const origin = 'https://cameronbeebe.github.io';
const cv = readFileSync(new URL('../cv.md', import.meta.url), 'utf8');
const env = { TYPESAFE_API_KEY: 'test-secret', ASK_LIMIT: { limit: async () => ({ success: true }) } };
const lmuUrl = 'https://edoc.ub.uni-muenchen.de/28655/';

function publicSource(url, options) {
  assert.equal(options.headers?.Authorization, undefined);
  if (url === `${origin}/cv.md`) return new Response(cv);
  if (url === lmuUrl) return new Response(
    '<meta name="DC.title" content="Knowledge transfer &amp; control" />\n'
    + '<meta name="eprints.abstract_name" content="Knowledge transfer concerns models and adaptive control." />',
  );
  if (url.startsWith('https://api.github.com/users/CameronBeebe/repos?')) return Response.json([
    { name: 'fungi_chromatic', description: 'A Game Boy Color cartridge.', pushed_at: '2026-11-07T00:00:00Z', archived: false },
    { name: 'old-game', pushed_at: '2026-11-07T00:00:00Z', archived: true },
  ]);
  assert.match(url, /^https:\/\/api\.github\.com\/repos\/CameronBeebe\/[\w.-]+\/readme$/);
  assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
  return new Response('# Project\n\nAn **experimental Game Boy Color game** that runs on the ModRetro Chromatic.');
}

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
    if (url !== 'https://api.typesafe.ai/v1/systemone') return publicSource(url, options);
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const { state, questions } = JSON.parse(options.body);
    assert.equal(state.visitor_question, 'What did Cameron build?');
    assert.ok(Object.keys(questions).length <= 32);
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
    unavailableSources: [],
  });
  score = 0.6;
  const miss = await worker.fetch(post({ question: 'What did Cameron build?' }), env);
  assert.deepEqual(await miss.json(), { excerpts: [], unavailableSources: [] });
  assert.equal(calls, 2);
});

test('returns GitHub and LMU links when the CV is unavailable', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === `${origin}/cv.md`) return new Response(null, { status: 503 });
    if (url !== 'https://api.typesafe.ai/v1/systemone') return publicSource(url, options);
    const { state } = JSON.parse(options.body);
    const entries = Object.entries(state.passages);
    assert.ok(entries.some(([, p]) => p.heading === 'Recently pushed public repositories'));
    assert.ok(entries.every(([, p]) => p.heading !== 'old-game'));
    const answers = Object.fromEntries(entries.map(([id, p]) => [id, {
      type: 'noul',
      noul: p.source.url === lmuUrl || p.source.url.endsWith('/fungi_chromatic#readme') ? 0.95 : 0.1,
    }]));
    return Response.json({ answers });
  });
  const response = await worker.fetch(post({ question: 'Where is the dissertation and Game Boy Color project?' }), env);
  assert.equal(response.status, 200);
  const { excerpts, unavailableSources } = await response.json();
  assert.deepEqual(unavailableSources, ['CV']);
  assert.deepEqual(excerpts.map(p => p.source.url), [lmuUrl, 'https://github.com/CameronBeebe/fungi_chromatic#readme']);
  assert.equal(excerpts[0].heading, 'Knowledge transfer & control');
  assert.match(excerpts[1].text, /experimental Game Boy Color game/);
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
  t.mock.method(globalThis, 'fetch', async (url, options) => url === 'https://api.typesafe.ai/v1/systemone'
    ? Response.json({ answers: {} }) : publicSource(url, options));
  const response = await worker.fetch(post({ question: 'What did Cameron build?' }), env);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /unavailable/);
});
