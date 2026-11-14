import { boundedJson } from './model-stream.mjs';
import { checkAscii } from '../assets/ascii-contract.mjs';
import { paletteModels } from '../assets/palette-colors.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const switches = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === 'feedback,guidance,optimized,tools'
  && Object.values(value).every(flag => typeof flag === 'boolean') && (!value.guidance || value.tools);

export function checkFeedback(value) {
  if (!value || !uuid(value.feedbackId) || ![1, -1].includes(value.rating)
    || !Number.isInteger(value.sequence) || value.sequence < 1 || value.sequence > 1000000) throw new Error('Invalid feedback.');
  const run = value.run;
  if (!run || run.version !== 3 || !uuid(run.runId) || !Array.isArray(run.attempts)
    || run.attempts.length < 1 || run.attempts.length > 8) throw new Error('A complete run record is required.');
  const first = run.attempts[0];
  if (typeof first.brief !== 'string' || !first.brief.trim() || first.brief.length > 300
    || !paletteModels.some(model => model.id === first.model) || !switches(first.harness)) throw new Error('Invalid run configuration.');
  const ids = new Set();
  for (const [index, attempt] of run.attempts.entries()) {
    if (!uuid(attempt.id) || ids.has(attempt.id) || attempt.runId !== run.runId || attempt.step !== index + 1
      || attempt.model !== first.model || attempt.brief !== first.brief || !switches(attempt.harness)
      || Object.keys(first.harness).some(key => attempt.harness[key] !== first.harness[key])
      || !Array.isArray(attempt.prompt) || typeof attempt.raw !== 'string' || typeof attempt.valid !== 'boolean') throw new Error('Invalid run trace.');
    ids.add(attempt.id);
    if (attempt.valid && !checkAscii({ rows: attempt.rows }).valid) throw new Error('Invalid submitted grid.');
    if (attempt.workspaceRows && !checkAscii({ rows: attempt.workspaceRows }).valid) throw new Error('Invalid workspace.');
    if (attempt.image !== undefined && (typeof attempt.image !== 'string' || attempt.image.length > 900000
      || !/^iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(attempt.image))) throw new Error('Invalid image record.');
  }
  return value;
}

export async function feedbackRequest(request, env, json, headers) {
  if (!env.ASCII_FEEDBACK || !env.FEEDBACK_LIMIT) return json({ error: 'Feedback is not connected yet.' }, 503);
  const { success } = await env.FEEDBACK_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success) { headers.set('Retry-After', '60'); return json({ error: 'Please wait a moment before voting again.' }, 429); }
  let value;
  try { value = checkFeedback(await boundedJson(request.body, 8000000)); }
  catch (error) { return json({ error: error.message }, 400); }
  const id = crypto.randomUUID();
  const record = { version: 1, id, receivedAt: new Date().toISOString(), feedbackId: value.feedbackId,
    sequence: value.sequence, rating: value.rating, run: value.run,
    provenance: 'Anonymous visitor feedback with a client-supplied run snapshot; review before optimization.' };
  try {
    // One immutable event per vote avoids concurrent overwrites and per-key write limits.
    // Keep the snapshot private; no IP address, cookie, or public read endpoint is added.
    await env.ASCII_FEEDBACK.put(`feedback/${value.run.runId}/${id}`, JSON.stringify(record));
    return json({ saved: true, id }, 201);
  } catch {
    console.error(JSON.stringify({ message: 'ASCII feedback save failed' }));
    return json({ error: 'Your vote was not saved. Please try again.' }, 503);
  }
}
