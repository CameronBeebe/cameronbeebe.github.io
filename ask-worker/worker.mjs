import { cvUrl, maxQuestionLength } from '../assets/cv-passages.mjs';
import { publicPassages } from './sources.mjs';

const typeSafeUrl = 'https://api.typesafe.ai/v1/systemone';
const allowedOrigins = new Set([
  new URL(cvUrl).origin,
  'http://127.0.0.1:8741',
  'http://localhost:8741',
]);
const maxBodyBytes = 4096;
const sourceGroupLimit = 4;

async function rankWithJev(items, judgment, state, apiKey, signal) {
  const questions = Object.fromEntries(items.map((item, i) => [`p${i + 1}`, {
    type: 'noul',
    ...judgment(item),
  }]));
  const response = await fetch(typeSafeUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions }),
    signal,
    redirect: 'manual',
  });
  if (!response.ok) throw Object.assign(new Error('Jev unavailable'), { status: response.status });
  const { answers } = await response.json();
  return items.map((item, i) => {
    const answer = answers?.[`p${i + 1}`];
    const relevance = answer?.noul;
    if (answer?.type !== 'noul' || !Number.isFinite(relevance) || relevance < 0 || relevance > 1) {
      throw new Error('Unexpected Jev answer');
    }
    return { item, relevance };
  }).sort((a, b) => b.relevance - a.relevance);
}

function sourceJudgment(group) {
  return {
    instructions: {
      task: 'Could this public source contain evidence that answers part of the visitor question about Cameron Beebe or his work?',
      source: {
        heading: group[0].heading,
        preview: group.map(({ section, text }) => section ? section + ' — ' + text.slice(0, 120) : text.slice(0, 240)),
      },
    },
    criteria: {
      true: 'The source title, section headings, or previews suggest the source could answer the question, even when it uses different words.',
      false: 'This source concerns a different work or subject and is unlikely to answer the question.',
    },
  };
}

function excerptJudgment({ section, heading, text }) {
  return {
    instructions: {
      task: 'Does the excerpt directly answer part of the visitor question about Cameron Beebe? Use its heading and section to resolve what it refers to.',
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
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ Vary: 'Origin', 'Cache-Control': 'no-store' });
    if (allowedOrigins.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
    const json = (body, status = 200) => Response.json(body, { status, headers });
    if (new URL(request.url).pathname !== '/ask') return json({ error: 'Unknown endpoint.' }, 404);
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
      const { referencePassages, sourceGroups, unavailableSources } = await publicPassages();
      const state = { visitor_question: question, current_date: new Date().toISOString().slice(0, 10) };
      const signal = AbortSignal.timeout(8000);
      let selectedGroups = sourceGroups;
      if (sourceGroups.length > sourceGroupLimit) {
        phase = 'source routing';
        const routes = await rankWithJev(sourceGroups, sourceJudgment, state, env.TYPESAFE_API_KEY, signal);
        selectedGroups = routes.slice(0, sourceGroupLimit).map(({ item }) => item);
      }
      const passages = [...referencePassages, ...selectedGroups.flat()];
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
