import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';

const origin = 'https://cameronbeebe.github.io';
const picture = 'iVBORw0KGgoAAA==';
const env = { TYPESAFE_API_KEY: 'test-secret', ASK_LIMIT: { limit: async () => ({ success: true }) } };
const input = {
  operation: 'compare', target: 'sword', model: 'jev-latest', view: 'image',
  context: false, tools: true, guidance: '', image: picture, grid: ['@@', '..'],
  patches: [{ id: 'r0', rect: [0, 0, 0.5, 1], image: picture }, { id: 'r1', rect: [0.5, 0, 1, 1], image: picture }],
  available: ['compare', 'restore'], events: ['selected sort'],
};

function post(value, headers = {}) {
  return new Request('https://worker.example/portrait', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
}

function answerQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'box') return [id, { type: 'box', box: { left: 0.1, top: 0.2, right: 0.8, bottom: 0.9 }, confidence: 0.8 }];
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria);
      return [id, { type: 'choice', choice: options.at(-1), probabilities: Object.fromEntries(options.map((option, i) => [option, i === options.length - 1 ? 1 : 0])) }];
    }
    return [id, { type: 'noul', noul: id === 'r0' ? 0.2 : 0.8 }];
  }));
}

test('compares rendered evidence with independent box and patch judgments', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.headers['TypeSafe-Danger-Zone-Images'], 'true');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'manual');
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(body.assets[body.state.current_view].data_base64, picture);
    assert.equal(body.state.artwork_context, undefined);
    // Split batches must not include unused image assets.
    const references = JSON.stringify({ state: body.state, questions: body.questions });
    assert.ok(Object.keys(body.assets).every(id => references.includes(id)));
    return Response.json({ answers: answerQuestions(body.questions) });
  });
  const response = await worker.fetch(post(input), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  const data = await response.json();
  assert.equal(data.visible, 0.8);
  assert.deepEqual(data.box, [0.1, 0.2, 0.8, 0.9]);
  assert.deepEqual(data.patches.map(p => p.probability), [0.2, 0.8]);
  assert.equal(calls.length, 2);
  const patchQuestion = calls.find(call => call.questions.r0).questions.r0;
  assert.ok(patchQuestion.instructions.region.crop);
});

test('raw grid comparisons work without image or Box questions', async t => {
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.state.current_view, '@@\n..');
    assert.equal(body.assets, undefined);
    assert.ok(Object.values(body.questions).every(q => q.type !== 'box'));
    return Response.json({ answers: answerQuestions(body.questions) });
  });
  const response = await worker.fetch(post({ ...input, view: 'grid', image: undefined, tools: false }), env);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.box, null);
});

test('shared human marks and artwork reference are opt-in evidence', async t => {
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.state.visitor_mark.cells, ['10', '01']);
    assert.ok(body.state.artwork_context.includes('frog samurai'));
    assert.ok(body.assets[body.state.original_portrait]);
    return Response.json({ answers: answerQuestions(body.questions) });
  });
  const response = await worker.fetch(post({ ...input, context: true, reference: picture, mark: [0, 0, 1, 1], mask: ['10', '01'] }), env);
  assert.equal(response.status, 200);
});

test('prediction uses the hypothetical probability for the chosen region', async t => {
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const { questions } = JSON.parse(options.body);
    return Response.json({ answers: answerQuestions(questions) });
  });
  const response = await worker.fetch(post({ ...input, operation: 'predict' }), env);
  const data = await response.json();
  assert.equal(data.region, 'r1');
  assert.equal(data.remaining, 0.8);
});

test('next-step suggestions are constrained to available controls and include corrections', async t => {
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const { state, questions } = JSON.parse(options.body);
    assert.equal(state.visitor_goal, 'Undo damage or recover the original portrait.');
    assert.deepEqual(state.interactions, ['selected sort']);
    assert.deepEqual(Object.keys(questions.next.criteria), ['compare', 'restore']);
    return Response.json({ answers: answerQuestions(questions) });
  });
  const response = await worker.fetch(post({ ...input, operation: 'suggest', goal: 'recovery' }), env);
  assert.equal((await response.json()).next.choice, 'restore');
});

test('malformed inputs and rate limits fail before any model call', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected model request'));
  for (const invalid of [null, { ...input, model: 'arbitrary-model' }, { ...input, patches: [null] },
    { ...input, patches: [{ id: 'r0', rect: [0.5, 0, 0.2, 1] }] },
    { ...input, available: ['delete-account'] }, { ...input, image: 'not-an-image' }, { ...input, mask: ['xxx'] }]) {
    assert.equal((await worker.fetch(post(invalid), env)).status, 400);
  }
  assert.equal((await worker.fetch(post(input, { Origin: 'https://other.example' }), env)).status, 403);
  const limited = { ...env, ASK_LIMIT: { limit: async () => ({ success: false }) } };
  const response = await worker.fetch(post(input), limited);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(upstream.mock.callCount(), 0);
});

test('invalid model probabilities do not become visual highlights', async t => {
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const { questions } = JSON.parse(options.body);
    const answers = answerQuestions(questions);
    if (answers.r0) answers.r0.noul = 3;
    return Response.json({ answers });
  });
  assert.equal((await worker.fetch(post(input), env)).status, 503);
});

test('oversized model batches split without losing image evidence', async t => {
  let splitRequests = 0;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.assets[body.state.current_view]);
    if (Object.keys(body.questions).length > 1) {
      splitRequests++;
      return Response.json({ detail: { code: 'max_tokens_exceeded' } }, { status: 400 });
    }
    return Response.json({ answers: answerQuestions(body.questions) });
  });
  const response = await worker.fetch(post(input), env);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(splitRequests, 2);
  assert.equal(data.patches.length, 2);
  assert.deepEqual(data.box, [0.1, 0.2, 0.8, 0.9]);
});
