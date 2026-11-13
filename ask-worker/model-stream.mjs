// Incremental SSE decoding, bounded before provider framing can consume excessive memory.
export async function* streamEvents(body, maxBytes = 512000) {
  const decoder = new TextDecoder();
  let pending = '', bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('Response too large');
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).trimEnd(); pending = pending.slice(end + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) yield pending.slice(5).trim();
}

export async function boundedJson(body, limit) {
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  for await (const chunk of body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error('Request too large');
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

export function modelStream(request, headers, ctx, work, timeoutMs = 70000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let writes = Promise.resolve();
  const emit = data => {
    writes = writes.then(() => writer.write(new TextEncoder().encode(JSON.stringify(data) + '\n')));
    writes.catch(abort);
  };
  ctx.waitUntil((async () => {
    try {
      await work(controller.signal, emit);
      emit({ event: 'done' });
      await writes; await writer.close();
    } catch {
      abort(); await writer.abort().catch(() => {});
    } finally {
      clearTimeout(timeout); request.signal.removeEventListener('abort', abort);
    }
  })());
  headers.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(readable, { headers });
}
