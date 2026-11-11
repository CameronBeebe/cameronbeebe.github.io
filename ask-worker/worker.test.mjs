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
  assert.equal(options.redirect, 'manual');
  if (url === `${origin}/cv.md`) return new Response(cv);
  if (url === lmuUrl) return new Response(
    '<meta name="DC.title" content="Knowledge transfer &amp; control" />\n'
    + '<meta name="DC.date" content="2021-01-22" />\n'
    + '<meta name="eprints.abstract_name" content="Knowledge transfer concerns models and adaptive control." />',
  );
  if (url.startsWith('https://api.github.com/users/CameronBeebe/repos?')) return Response.json([
    { name: 'fungi_chromatic', description: 'A Game Boy Color cartridge.', pushed_at: '2026-11-07T00:00:00Z', archived: false },
    { name: 'old-game', pushed_at: '2026-11-07T00:00:00Z', archived: true },
  ]);
  if (url === 'https://raw.githubusercontent.com/CameronBeebe/intent-controller/HEAD/README.md') {
    return new Response('# Intent Controller\n\nThe fork requires a declared objective before reading a file when the feature is enabled.');
  }
  if (url === 'https://raw.githubusercontent.com/CameronBeebe/Structural_Idealism/HEAD/README.md') {
    return new Response(null, { status: 404 });
  }
  if (url === 'https://api.github.com/repos/CameronBeebe/Structural_Idealism/readme') {
    assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
  } else {
    assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/CameronBeebe\/[\w.-]+\/HEAD\/README\.md$/);
  }
  const intro = '# Project\n\nAn **experimental Game Boy Color game** that runs on the ModRetro Chromatic.';
  const guide = '\n\n## Try it without hardware\n\nThe example runs in an emulator without requiring a cartridge or API credentials.';
  return new Response(url.includes('/fungi_chromatic/') ? intro + guide : intro);
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
  assert.ok(passages.some(p => p.text.includes('B.A. in Philosophy') && p.text.includes('Montana State University')));
  assert.ok(passages.some(p => p.text.startsWith('fungi_fortress / fungi_chromatic')));
  assert.ok(passages.every(p => !p.text.includes('mailto:') && p.text.length));
});

test('returns the top three source excerpts even when all matches are weak', async t => {
  const cvEntries = cvPassages(cv);
  const expected = cvEntries.slice(0, 3).reverse().map((passage, i) => ({
    ...passage, relevance: [0.6, 0.4, 0.2][i],
  }));
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url !== 'https://api.typesafe.ai/v1/systemone') return publicSource(url, options);
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'manual');
    const { state, questions } = JSON.parse(options.body);
    assert.equal(state.visitor_question, 'What did Cameron build?');
    if (questions.p1.instructions.source) {
      return Response.json({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.1 }])) });
    }
    const candidates = Object.entries(questions).map(([id, q]) => {
      assert.equal(q.type, 'noul');
      return [id, q.instructions.excerpt];
    });
    assert.deepEqual(candidates.slice(0, cvEntries.length).map(([, p]) => p),
      cvEntries.map(({ section, heading, text }) => ({ section, heading, text })));
    const answers = Object.fromEntries(candidates.map(([id, passage]) => [id, {
      type: 'noul', noul: expected.find(entry => entry.text === passage.text)?.relevance ?? 0.1,
    }]));
    answers.unknown = { type: 'noul', noul: 1, text: 'Fake passage' };
    return Response.json({ answers });
  });

  const response = await worker.fetch(post({ question: 'What did Cameron build?' }), env);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.deepEqual(await response.json(), { excerpts: expected, unavailableSources: [] });
  const batches = upstream.mock.calls
    .filter(call => call.arguments[0] === 'https://api.typesafe.ai/v1/systemone')
    .map(call => JSON.parse(call.arguments[1].body).questions.p1.instructions);
  assert.ok(batches.filter(batch => batch.source).length > 1);
  assert.ok(batches.at(-1).excerpt);
});

test('routes GitHub repository groups before ranking their excerpts alongside LMU', async t => {
  const routes = new Map();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === `${origin}/cv.md`) return new Response(null, { status: 503 });
    if (url !== 'https://api.typesafe.ai/v1/systemone') return publicSource(url, options);
    const { questions } = JSON.parse(options.body);
    if (questions.p1.instructions.source) {
      const branches = Object.entries(questions).map(([id, q]) => [id, q.instructions.source]);
      for (const [, source] of branches) routes.set(source.heading, source);
      return Response.json({ answers: Object.fromEntries(branches.map(([id, source]) => [id, {
        type: 'noul', noul: ['Recently pushed public repositories', 'fungi_chromatic', 'fungi_fortress', 'scipfs'].includes(source.heading) ? 0.8 : 0.01,
      }])) });
    }
    const entries = Object.entries(questions).map(([id, q]) => [id, q.instructions.excerpt]);
    assert.ok(entries.some(([, p]) => p.heading === 'Recently pushed public repositories'));
    assert.ok(entries.some(([, p]) => p.section === 'Try it without hardware' && p.text.includes('emulator')));
    assert.ok(entries.every(([, p]) => p.heading !== 'old-game'));
    assert.ok(entries.every(([, p]) => p.heading !== 'Structural_Idealism'));
    const answers = Object.fromEntries(entries.map(([id, p]) => [id, {
      type: 'noul',
      noul: p.text.includes('Knowledge transfer concerns') ||
        (p.heading === 'fungi_chromatic' && p.text.includes('experimental Game Boy Color')) ? 0.95 : 0.1,
    }]));
    return Response.json({ answers });
  });
  const response = await worker.fetch(post({ question: 'Where can I read his thesis and find the handheld console game?' }), env);
  assert.equal(response.status, 200);
  const project = routes.get('fungi_chromatic');
  assert.equal(project.preview.length, 3, 'repository metadata and README sections share a group');
  assert.ok(project.preview[1].includes('ModRetro Chromatic'));
  assert.ok(project.preview[2].includes('Try it without hardware'));
  assert.ok([...routes.keys()].some(heading => heading.includes('Sequent Calculus')));
  const { excerpts, unavailableSources } = await response.json();
  assert.deepEqual(unavailableSources, ['CV']);
  assert.deepEqual(excerpts.slice(0, 2).map(p => p.source.url), [lmuUrl, 'https://github.com/CameronBeebe/fungi_chromatic#readme']);
  assert.equal(excerpts[0].heading, 'Knowledge transfer & control');
  assert.equal(excerpts[0].source.year, 2021);
  assert.match(excerpts[1].text, /experimental Game Boy Color game/);
});

test('finds a passage from the Intent Controller README', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url !== 'https://api.typesafe.ai/v1/systemone') return publicSource(url, options);
    const { questions } = JSON.parse(options.body);
    const answers = Object.fromEntries(Object.entries(questions).map(([id, { instructions }]) => {
      const candidate = instructions.source ?? instructions.excerpt;
      return [id, { type: 'noul', noul: candidate.heading === 'intent-controller' ? 0.95 : 0.1 }];
    }));
    return Response.json({ answers });
  });
  const response = await worker.fetch(post({ question: 'What kind of harness mod is Intent Controller?' }), env);
  assert.equal(response.status, 200);
  const { excerpts } = await response.json();
  assert.match(excerpts[0].text, /declared objective before reading/);
  assert.equal(excerpts[0].source.url, 'https://github.com/CameronBeebe/intent-controller#readme');
});

test('routes a paper chapter and returns a passage with a PDF page citation', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url !== 'https://api.typesafe.ai/v1/systemone') return publicSource(url, options);
    const { questions } = JSON.parse(options.body);
    const answers = Object.fromEntries(Object.entries(questions).map(([id, { instructions }]) => {
      const relevant = (instructions.source ?? instructions.excerpt).heading.includes('Interference and Non-monotonicity');
      return [id, { type: 'noul', noul: relevant ? 0.95 : 0.1 }];
    }));
    return Response.json({ answers });
  });
  const response = await worker.fetch(post({ question: 'How does interference affect the quantum sequent calculus?' }), env);
  assert.equal(response.status, 200);
  const { excerpts } = await response.json();
  assert.match(excerpts[0].source.url, /^https:\/\/arxiv\.org\/pdf\/1606\.06799#page=\d+$/);
  assert.match(excerpts[0].section, /Interference and Non-monotonicity/);
  assert.equal(excerpts[0].source.year, 2016);
});

test('routes the full dissertation chapter and finds a short passage deep in it', async t => {
  const evidence = 'since there are finite levels in the hierarchy';
  let fullChapter;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url !== 'https://api.typesafe.ai/v1/systemone') return publicSource(url, options);
    const { questions } = JSON.parse(options.body);
    const answers = Object.fromEntries(Object.entries(questions).map(([id, { instructions }]) => {
      const { source, excerpt } = instructions;
      const relevant = (source ?? excerpt).text?.includes(evidence);
      if (source && relevant) {
        fullChapter = source.text;
        assert.match(source.heading, / · Model-Based Computation$/);
      }
      return [id, { type: 'noul', noul: relevant ? 0.95 : 0.1 }];
    }));
    return Response.json({ answers });
  });
  const response = await worker.fetch(post({ question: 'How does the model avoid an infinite regress of homunculi?' }), env);
  assert.equal(response.status, 200);
  const { excerpts } = await response.json();
  assert.ok(fullChapter.indexOf(evidence) > 30000);
  assert.match(fullChapter, /What is Analog Computation\?/);
  assert.match(fullChapter, /Conclusion/);
  assert.ok(excerpts[0].text.includes(evidence));
  assert.ok(excerpts[0].text.length <= 750);
  assert.equal(excerpts[0].section, 'Bayesian Brain and Generative Modeling');
  assert.match(excerpts[0].source.url, /Beebe_Cameron\.pdf#page=5[12]$/);
  assert.equal(excerpts[0].source.year, 2021);
});

test('uses the default-branch README even when the GitHub REST API is blocked', async t => {
  const requests = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 403 });
    if (url !== 'https://api.typesafe.ai/v1/systemone') return publicSource(url, options);
    const { questions } = JSON.parse(options.body);
    const answers = Object.fromEntries(Object.entries(questions).map(([id, { instructions }]) => [id, {
      type: 'noul', noul: (instructions.excerpt ?? instructions.source).heading === 'fungi_chromatic' ? 0.95 : 0.1,
    }]));
    return Response.json({ answers });
  });
  const response = await worker.fetch(post({ question: 'What hardware runs the handheld game?' }), env);
  assert.equal(response.status, 200);
  const { excerpts, unavailableSources } = await response.json();
  assert.ok(unavailableSources.includes('GitHub project list'));
  assert.equal(excerpts[0].source.url, 'https://github.com/CameronBeebe/fungi_chromatic#readme');
  assert.match(excerpts[0].text, /runs on the ModRetro Chromatic/);
  assert.ok(requests.mock.calls.some(call =>
    call.arguments[0] === 'https://raw.githubusercontent.com/CameronBeebe/fungi_chromatic/HEAD/README.md'));
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
