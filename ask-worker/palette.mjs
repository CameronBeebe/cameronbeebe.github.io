import { paletteModels, preparePalette } from '../assets/palette-colors.mjs';

const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const encoder = new TextEncoder();
const schema = {
  type: 'object', additionalProperties: false, required: ['background', 'inks'],
  properties: {
    background: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    inks: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } },
  },
};
const instructions = `Create an evocative color palette for a dense ASCII woodblock portrait of a frog samurai under a pine. Interpret the visitor's mood as color direction only. Return exactly the palette JSON. background: a near-black #RRGGBB. inks: four #RRGGBB colors, from shadow glyphs to highlights. Use distinctive, cohesive hues inspired by the mood. The renderer will adjust lightness for readability. No explanations or other fields.`;

async function readInput(request) {
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  for await (const chunk of request.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > 1024) throw new Error('Too much input');
    text += decoder.decode(chunk, { stream: true });
  }
  const input = JSON.parse(text + decoder.decode());
  if (typeof input?.mood !== 'string' || !input.mood.trim() || input.mood.trim().length > 120) throw new Error('Invalid mood');
  return input.mood.trim();
}

// Incremental SSE decoding handles split UTF-8, CRLF, comments, and a final unterminated line.
export async function* streamEvents(body) {
  const decoder = new TextDecoder();
  let pending = '';
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > 512000) throw new Error('Response too large');
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).trimEnd();
      pending = pending.slice(end + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) yield pending.slice(5).trim();
}

async function compareModel(model, mood, apiKey, signal, emit) {
  const start = performance.now();
  // Inkling and GLM reject disabled reasoning; Qwen supports the cheaper non-thinking route.
  const thinking = model.id === 'qwen/qwen3.6-35b-a3b' ? 'off' : 'low';
  const result = { model: model.id, name: model.name, thinking, firstMs: null, readyMs: null, cost: null, tokens: null, provider: null, valid: false };
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'manual', signal,
      headers: {
        Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
        'HTTP-Referer': 'https://cameronbeebe.github.io', 'X-OpenRouter-Title': 'Cameron Beebe · ASCII ink',
      },
      body: JSON.stringify({
        model: model.id, stream: true, max_tokens: thinking === 'off' ? 320 : 1024,
        reasoning: thinking === 'off' ? { enabled: false } : { effort: 'low' },
        provider: { require_parameters: true, sort: 'latency', max_price: { prompt: 0.4, completion: 1 } },
        messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify({ mood }) }],
        response_format: { type: 'json_schema', json_schema: { name: 'ascii_palette', strict: true, schema } },
      }),
    });
    if (!response.ok || !response.body) {
      let text = '';
      if (response.body) for await (const part of response.body) {
        text += new TextDecoder().decode(part);
        if (text.length > 8192) { text = ''; break; }
      }
      let problem;
      try { problem = JSON.parse(text)?.error; } catch { /* Error bodies can be non-JSON. */ }
      const detail = [problem?.message, problem?.metadata?.raw].filter(v => typeof v === 'string').join(' ').replaceAll(apiKey, '[redacted]').slice(0, 600);
      throw Object.assign(new Error('Provider unavailable'), { status: response.status, detail });
    }
    let content = '';
    let finish = null;
    let completed = false;
    for await (const event of streamEvents(response.body)) {
      if (event === '[DONE]') { completed = true; break; }
      const chunk = JSON.parse(event);
      if (chunk.error) throw new Error('Provider interrupted');
      if (typeof chunk.provider === 'string') result.provider = chunk.provider.slice(0, 80);
      if (chunk.usage) {
        const { cost, total_tokens: tokens } = chunk.usage;
        if (Number.isFinite(cost) && cost >= 0) result.cost = cost;
        if (Number.isInteger(tokens) && tokens >= 0) result.tokens = tokens;
      }
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (typeof delta !== 'string' || !delta) continue;
      if (result.firstMs === null) {
        result.firstMs = Math.round(performance.now() - start);
        emit({ event: 'first', ...result });
      }
      content += delta;
      if (content.length > 4096) throw new Error('Response too large');
      // Track usable-data latency independently from the later billing frame.
      if (result.readyMs === null) {
        try {
          if (preparePalette(JSON.parse(content)).valid) result.readyMs = Math.round(performance.now() - start);
        } catch { /* A partial object is expected during generation. */ }
      }
    }
    if (!completed || finish !== 'stop') throw new Error(finish === 'length' ? 'Output limit reached' : 'Incomplete response');
    let palette;
    try { palette = JSON.parse(content); } catch { throw new Error('Invalid palette JSON'); }
    Object.assign(result, preparePalette(palette));
    if (!result.valid) { result.readyMs = null; delete result.palette; }
  } catch (error) {
    result.readyMs = null;
    result.reason = signal.aborted ? 'Request timed out or cancelled' : error.message;
    console.error(JSON.stringify({ message: 'Palette comparison failed', model: model.id, status: error.status, detail: error.detail }));
  }
  emit({ event: 'result', ...result, elapsedMs: Math.round(performance.now() - start) });
}

export async function paletteRequest(request, env, json, headers, ctx) {
  let mood;
  try { mood = await readInput(request); } catch { return json({ error: 'Describe a mood in 1–120 characters.' }, 400); }
  if (!env.OPENROUTER_API_KEY || !env.PALETTE_LIMIT) return json({ error: 'Color comparison is waiting for its OpenRouter connection.' }, 503);
  const { success } = await env.PALETTE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success) {
    headers.set('Retry-After', '60');
    return json({ error: 'Three comparisons per minute. Try again shortly.' }, 429);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let writes = Promise.resolve();
  // Keep order and backpressure for the three producers sharing one response stream.
  const emit = value => {
    writes = writes.then(() => writer.write(encoder.encode(JSON.stringify(value) + '\n')));
    writes.catch(abort);
  };
  const run = (async () => {
    try {
      emit({ event: 'start', models: paletteModels });
      await Promise.all(paletteModels.map(model => compareModel(model, mood, env.OPENROUTER_API_KEY, controller.signal, emit)));
      emit({ event: 'done' });
      await writes;
      await writer.close();
    } catch {
      controller.abort();
      await writer.abort().catch(() => {});
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
    }
  })();
  ctx.waitUntil(run);
  headers.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(readable, { headers });
}
