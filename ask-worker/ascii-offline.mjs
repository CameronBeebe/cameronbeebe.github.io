// Private stdin/stdout bridge for DSPy. Never registered as an HTTP route.
import { createInterface } from 'node:readline';
import { generateAscii, baselineInstructions } from './ascii.mjs';
import { asciiRubrics } from '../assets/ascii-contract.mjs';

for await (const line of createInterface({ input: process.stdin })) {
  try {
    const value = JSON.parse(line);
    if (value.operation === 'info') { console.log(JSON.stringify({ baselineInstructions, asciiRubrics })); continue; }
    const drafts = [], started = performance.now();
    await generateAscii({ brief: value.brief, model: value.model, mode: 'harness', harness: value.harness }, process.env,
      AbortSignal.timeout(300000), event => { if (event.event === 'result') drafts.push(event); }, value.instructions);
    console.log(JSON.stringify({ drafts, elapsedMs: Math.round(performance.now() - started) }));
  } catch (error) { console.log(JSON.stringify({ error: error.message })); }
}
