// Offline experiment runner; never bundled into the Worker or shipped to the browser.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { checkAscii } from '../assets/ascii-contract.mjs';

export function summarize(runs) {
  return Object.fromEntries(['single', 'retry', 'repair'].map(mode => {
    const group = runs.filter(run => run.mode === mode);
    const drafts = group.flatMap(run => run.drafts);
    const calls = group.reduce((sum, run) => sum + (run.startedDrafts?.length ?? run.drafts.length), 0);
    return [mode, {
      runs: group.length,
      completedStreams: group.filter(run => run.completed).length,
      firstDraftPasses: group.filter(run => run.drafts[0]?.valid).length,
      finalPasses: group.filter(run => run.completed && run.drafts.at(-1)?.valid).length,
      generationCalls: calls,
      reportedCost: drafts.reduce((sum, draft) => sum + (draft.cost ?? 0), 0),
      unreportedCosts: calls - drafts.filter(draft => draft.cost != null).length,
      elapsedMs: group.reduce((sum, run) => sum + run.elapsedMs, 0),
    }];
  }));
}

async function main() {
  const [briefsFile, outputFile, model = 'qwen/qwen3.6-35b-a3b', repeats = '1', endpoint = 'https://cameron-portfolio-ask.cameronbeebe.workers.dev/ascii/generate'] = process.argv.slice(2);
  if (!briefsFile || !outputFile || !/^[1-9]\d?$/.test(repeats)) throw new Error('Usage: node ask-worker/evaluate-ascii.mjs BRIEFS.json OUTPUT.json [MODEL] [REPEATS] [ENDPOINT]');
  const briefs = JSON.parse(await readFile(briefsFile, 'utf8'));
  if (!Array.isArray(briefs) || !briefs.length || briefs.some(brief => typeof brief !== 'string' || !brief.trim() || brief.length > 300)) throw new Error('BRIEFS.json must be an array of nonempty briefs, each at most 300 characters.');
  const report = { version: 1, created: new Date().toISOString(), model, endpoint,
    scope: 'Format reliability only. Visual quality is not measured. Equal maximum call/token ceilings for repair and fresh retry, with early stopping on structural success. Provider routing can vary.',
    runs: [], summary: {} };
  const jobs = briefs.flatMap(brief => Array.from({ length: Number(repeats) }, (_, repeat) =>
    ['single', 'retry', 'repair'].map(mode => ({ brief, repeat, mode })))).flat();
  // Randomize order so one strategy is not always measured first.
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  for (const job of jobs) {
    const started = performance.now();
    const run = { ...job, drafts: [], startedDrafts: [], events: [], completed: false };
    try {
      const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(310000),
        headers: { Origin: 'https://cameronbeebe.github.io', 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: job.brief, model, mode: job.mode }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      let pending = ''; const decoder = new TextDecoder();
      for await (const bytes of response.body) {
        pending += decoder.decode(bytes, { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line) continue;
          const event = JSON.parse(line);
          run.events.push(event);
          if (event.event === 'draft') run.startedDrafts.push(event);
          if (event.event === 'result') {
            if (!event.id || event.mode !== job.mode) throw new Error('The endpoint does not support the current experiment protocol.');
            if (event.valid && !checkAscii({ rows: event.rows }).valid) throw new Error('A passing draft failed independent validation.');
            run.drafts.push(event);
          }
          if (event.event === 'done') run.completed = true;
        }
      }
      if (!run.completed || !run.drafts.length) throw new Error('The result stream was incomplete.');
    } catch (error) { run.error = error.message; }
    run.elapsedMs = Math.round(performance.now() - started);
    report.runs.push(run); report.summary = summarize(report.runs);
    await writeFile(outputFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ brief: job.brief, mode: job.mode, drafts: run.drafts.length,
      valid: run.completed && Boolean(run.drafts.at(-1)?.valid), error: run.error ?? null }));
    // Keep outages/rate limits in the evidence, then stop rather than retrying them invisibly.
    if (run.error) break;
    if (report.runs.length < jobs.length) await new Promise(resolve => setTimeout(resolve, Math.max(0, 21000 - run.elapsedMs)));
  }
  console.log(JSON.stringify(report.summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
