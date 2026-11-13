import { cvUrl, maxQuestionLength } from '../assets/cv-passages.mjs';
import { chapterPassages, publicPassages } from './sources.mjs';
import { paletteRequest } from './palette.mjs';

const typeSafeUrl = 'https://api.typesafe.ai/v1/systemone';
const allowedOrigins = new Set([
  new URL(cvUrl).origin,
  'http://127.0.0.1:8741',
  'http://localhost:8741',
]);
const maxBodyBytes = 4096;
const sourceGroupLimit = 4;
const maxJevBatchBytes = 110000;
const concurrentJevBatches = 4;
const utf8 = new TextEncoder();

async function scoreBatch(batch, stateJson, apiKey, signal) {
  const questions = batch.map(({ id, question }) => `"${id}":${question}`).join(',');
  const response = await fetch(typeSafeUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: `{"model":"jev-latest","state":${stateJson},"questions":{${questions}}}`,
    signal,
    redirect: 'manual',
  });
  if (!response.ok) {
    const problem = response.status === 400 ? await response.json().catch(() => null) : null;
    const code = problem?.detail?.code ?? problem?.code;
    if (code === 'max_tokens_exceeded' && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      return [
        ...await scoreBatch(batch.slice(0, mid), stateJson, apiKey, signal),
        ...await scoreBatch(batch.slice(mid), stateJson, apiKey, signal),
      ];
    }
    if (!response.bodyUsed) await response.body?.cancel();
    throw Object.assign(new Error('Jev unavailable'), { status: response.status });
  }
  const { answers } = await response.json();
  return batch.map(({ id, item }) => {
    const answer = answers?.[id];
    const relevance = answer?.noul;
    if (answer?.type !== 'noul' || !Number.isFinite(relevance) || relevance < 0 || relevance > 1) {
      throw new Error('Unexpected Jev answer');
    }
    return { item, relevance };
  });
}

async function rankWithJev(items, judgment, state, apiKey, signal) {
  const stateJson = JSON.stringify(state);
  const overhead = utf8.encode(stateJson).length + 64;
  const batches = [];
  let batch = [];
  let bytes = overhead;
  for (const item of items) {
    const question = JSON.stringify({ type: 'noul', ...judgment(item) });
    const questionBytes = utf8.encode(question).length + 16;
    if (batch.length && bytes + questionBytes > maxJevBatchBytes) {
      batches.push(batch);
      batch = [];
      bytes = overhead;
    }
    batch.push({ id: `p${batch.length + 1}`, item, question });
    bytes += questionBytes;
  }
  if (batch.length) batches.push(batch);

  const scored = [];
  for (let i = 0; i < batches.length; i += concurrentJevBatches) {
    const parallel = batches.slice(i, i + concurrentJevBatches);
    scored.push(...(await Promise.all(parallel.map(entries => scoreBatch(entries, stateJson, apiKey, signal)))).flat());
  }
  return scored.sort((a, b) => b.relevance - a.relevance);
}

function sourceJudgment({ heading, text, preview }) {
  return {
    instructions: {
      task: 'Could this source contain a passage that answers part of the visitor question? Questions can be about Cameron Beebe, his projects, or concepts discussed in his work. Read the supplied source text for relevant evidence.',
      source: { heading, text, preview },
    },
    criteria: {
      true: 'The text or headings indicate the source could contain a specific answer, including when it uses different words.',
      false: 'This source concerns a different work or subject and is unlikely to answer the question.',
    },
  };
}

function excerptJudgment({ section, heading, text }) {
  return {
    instructions: {
      task: 'Does the excerpt directly answer part of the visitor question? The question may be about Cameron Beebe, his projects, or concepts discussed in his work. Use the heading and section to identify the subject.',
      excerpt: { section, heading, text },
    },
    criteria: {
      true: 'The text supplies a specific answer about the entity, event, or time asked about, including when the question uses different wording.',
      false: 'The text only shares a topic, supplies the fact for a different entity, event, or time, or would require speculation.',
    },
  };
}

async function readBody(request) {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for await (const chunk of request.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > maxBodyBytes) return { tooLarge: true };
    text += decoder.decode(chunk, { stream: true });
  }
  const data = JSON.parse(text + decoder.decode());
  return { question: typeof data?.question === 'string' ? data.question.trim() : '' };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ Vary: 'Origin', 'Cache-Control': 'no-store' });
    if (allowedOrigins.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
    const json = (body, status = 200) => Response.json(body, { status, headers });
    const path = new URL(request.url).pathname;
    if (!['/ask', '/palette'].includes(path)) return json({ error: 'Unknown endpoint.' }, 404);
    if (!allowedOrigins.has(origin)) return json({ error: 'Origin is not allowed.' }, 403);
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'POST');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST') {
      headers.set('Allow', 'POST, OPTIONS');
      return json({ error: 'Send a POST request.' }, 405);
    }
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: 'Send a JSON question.' }, 415);
    }
    if (path === '/palette') return paletteRequest(request, env, json, headers, ctx);

    let body;
    try {
      body = await readBody(request);
    } catch {
      return json({ error: 'The question could not be read.' }, 400);
    }
    if (body.tooLarge) return json({ error: 'The request is too large.' }, 413);
    const { question } = body;
    if (!question || question.length > maxQuestionLength) {
      return json({ error: `Enter a question of up to ${maxQuestionLength} characters.` }, 400);
    }
    if (!env.TYPESAFE_API_KEY || !env.ASK_LIMIT) {
      return json({ error: 'Live questions are temporarily unavailable.' }, 503);
    }

    let phase = 'rate limit';
    try {
      const { success } = await env.ASK_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
      if (!success) {
        headers.set('Retry-After', '60');
        return json({ error: 'Too many questions. Try again in a minute.' }, 429);
      }

      phase = 'source lookup';
      const { referencePassages, routes, unavailableSources } = await publicPassages();
      const state = { visitor_question: question, current_date: new Date().toISOString().slice(0, 10) };
      const signal = AbortSignal.timeout(18000);
      phase = 'source routing';
      const rankedRoutes = await rankWithJev(routes, sourceJudgment, state, env.TYPESAFE_API_KEY, signal);
      const selected = [...new Set(rankedRoutes.map(({ item }) => item.chapter ?? item))].slice(0, sourceGroupLimit);
      const passages = [...referencePassages, ...selected.flatMap(group => group.passages ?? chapterPassages(group))];
      if (!passages.length) throw new Error('Public sources unavailable');

      phase = 'excerpt ranking';
      const ranked = await rankWithJev(passages, excerptJudgment, state, env.TYPESAFE_API_KEY, signal);
      const excerpts = ranked.slice(0, 3).map(({ item, relevance }) => ({ ...item, relevance }));
      return json({ excerpts, unavailableSources });
    } catch (error) {
      console.error(JSON.stringify({ message: 'Ask lookup failed', phase, status: error?.status }));
      return json({ error: 'Public source lookup is temporarily unavailable. Try again shortly.' }, 503);
    }
  },
};
