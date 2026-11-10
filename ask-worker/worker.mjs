import { cvUrl, maxQuestionLength } from '../assets/cv-passages.mjs';
import { publicPassages } from './sources.mjs';

const typeSafeUrl = 'https://api.typesafe.ai/v1/systemone';
const allowedOrigins = new Set([
  new URL(cvUrl).origin,
  'http://127.0.0.1:8741',
  'http://localhost:8741',
]);
const maxBodyBytes = 4096;

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

    try {
      const { success } = await env.ASK_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
      if (!success) {
        headers.set('Retry-After', '60');
        return json({ error: 'Too many questions. Try again in a minute.' }, 429);
      }

      const { passages, unavailableSources } = await publicPassages(question);
      if (!passages.length) throw new Error('Public sources unavailable');

      const candidates = Object.fromEntries(passages.map((passage, i) => [`p${i + 1}`, passage]));
      const questions = Object.fromEntries(Object.entries(candidates).map(([id, { section, heading, text }]) => [id, {
        type: 'noul',
        instructions: {
          task: 'Does the excerpt directly answer part of the visitor question about Cameron Beebe? Use its heading and section to resolve what it refers to.',
          excerpt: { section, heading, text },
        },
        criteria: {
          true: 'The text supplies a specific answer about the entity, event, or time asked about, including when the question uses different wording.',
          false: 'The text only shares a topic, supplies the fact for a different entity, event, or time, or would require speculation.',
        },
      }]));
      const response = await fetch(typeSafeUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state: { visitor_question: question, current_date: new Date().toISOString().slice(0, 10) }, questions }),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Jev unavailable');
      const { answers } = await response.json();
      const ranked = Object.entries(candidates).map(([id, passage]) => {
        const answer = answers?.[id];
        const relevance = answer?.noul;
        if (answer?.type !== 'noul' || !Number.isFinite(relevance) || relevance < 0 || relevance > 1) {
          throw new Error('Unexpected Jev answer');
        }
        return { passage, relevance };
      });
      ranked.sort((a, b) => b.relevance - a.relevance);
      const excerpts = ranked.slice(0, 3).map(({ passage, relevance }) => ({ ...passage, relevance }));
      return json({ excerpts, unavailableSources });
    } catch {
      return json({ error: 'Public source lookup is temporarily unavailable. Try again shortly.' }, 503);
    }
  },
};
