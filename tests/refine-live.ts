// A smoke test of "Ask" (refine) against a real model: 10 edit requests on real workflows. The model's edited workflow is
// RUN on the data and compared with a hand-written reference of the intended result.
//   node tests/refine-live.ts worker [maxNeurons=400]    the Worker's code with the real Workers AI over REST (costs neurons)
//   node tests/refine-live.ts python                      the Python backend on localhost:8000 with the local model (free, slower)
// Credentials for `worker` come from backend/.env and are never printed. 10 cases is a smoke test, not a benchmark.
import { readFileSync } from 'node:fs';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { describeChanges, reconcile } from '../src/lib/refine.ts';
import type { Step } from '../src/types.ts';
import { handle } from '../worker/src/index.ts';

const [target = 'worker', maxNeurons = '400'] = process.argv.slice(2);
const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as { datasets: Record<string, Table>; tasks: { id: string; steps: { type: string; config: Record<string, string> }[] }[] };
const ref = (id: string) => data.tasks.find(t => t.id === id)!.steps;
type S = { type: string; config: Record<string, string> };
const st = (type: string, config: Record<string, string> = {}): S => ({ type, config });
const names = Object.keys(data.datasets);
const ctx: RunContext = {
  listDatasets: async () => names.map((name, id) => ({ id, name, filename: `${name}.csv` })),
  loadDataset: async id => data.datasets[names[id]],
  saveTable: async () => {},
  fetchJson: async () => { throw new Error('no network'); },
};
const asSteps = (steps: S[], tag: string): Step[] => steps.map((s, i) => ({ id: `${tag}-${i}`, type: s.type, name: s.type, description: '', config: s.config }));
const datasets = names.map(name => ({ name, columns: data.datasets[name].columns }));

const withEnd = (steps: S[], extra: S[]) => [...steps.slice(0, -1), ...extra, steps[steps.length - 1]];
const swap = (steps: S[], at: number, config: Record<string, string>) => steps.map((s, i) => (i === at ? { ...s, config } : s));

const cases: { id: string; before: S[]; instruction: string; after: S[]; impossible?: boolean }[] = [
  { id: 'R1', before: ref('S1'), instruction: 'Change the score limit to 40', after: swap(ref('S1'), 1, { condition: 'score < 40' }) },
  { id: 'R2', before: ref('S1'), instruction: 'Also keep only the name and score columns', after: withEnd(ref('S1'), [st('TRANSFORM', { operation: 'select columns name, score' })]) },
  { id: 'R3', before: ref('O7'), instruction: 'Remove the step that saves to the database', after: ref('O7').filter(s => s.type !== 'DATABASE') },
  { id: 'R4', before: ref('E3'), instruction: 'Sort the result by salary, highest first', after: withEnd(ref('E3'), [st('TRANSFORM', { operation: 'sort by salary desc' })]) },
  { id: 'R5', before: ref('O2'), instruction: 'Make the quantity limit 20 instead', after: swap(ref('O2'), 1, { condition: 'quantity > 20 and unit_price > 20' }) },
  { id: 'R6', before: ref('I1'), instruction: 'Only show the first 5 rows', after: withEnd(ref('I1'), [st('TRANSFORM', { operation: 'limit 5' })]) },
  { id: 'R7', before: ref('S2'), instruction: 'Show everyone with at least 70 instead', after: swap(ref('S2'), 1, { condition: 'score >= 70' }) },
  { id: 'R8', before: ref('E1'), instruction: 'Add a condition that years is at least 5', after: swap(ref('E1'), 1, { condition: 'department == Engineering and salary > 5000 and years >= 5' }) },
  { id: 'R9', before: ref('S1'), instruction: 'Send me an email when it finishes', after: ref('S1'), impossible: true },
  { id: 'R10', before: ref('S1'), instruction: 'asdf qwerty', after: ref('S1'), impossible: true },
];

/* ---------------- the two targets ---------------- */
type Reply = { nodes: Step[]; unchanged: boolean; valid: boolean; model: string; neurons: number };

async function viaWorker(): Promise<(steps: S[], instruction: string) => Promise<Reply>> {
  const dotenv = Object.fromEntries(readFileSync('backend/.env', 'utf-8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  if (!dotenv.CF_ACCOUNT_ID || !dotenv.CF_API_TOKEN) throw new Error('Set CF_ACCOUNT_ID and CF_API_TOKEN in backend/.env');
  const AI = {
    async run(model: string, inputs: unknown) {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${dotenv.CF_ACCOUNT_ID}/ai/run/${model}`, { method: 'POST', headers: { Authorization: `Bearer ${dotenv.CF_API_TOKEN}` }, body: JSON.stringify(inputs) });
      const body = await res.json() as { success?: boolean; result?: unknown; errors?: { message: string }[] };
      if (!res.ok || !body.success) throw new Error((body.errors ?? []).map(e => e.message).join('; ') || `HTTP ${res.status}`);
      return body.result;
    },
  };
  const env = { AI, MODELS: '@cf/openai/gpt-oss-20b,@cf/meta/llama-3.1-8b-instruct', ALLOWED_ORIGINS: '*', MAX_REQUESTS_PER_MINUTE: '1000' };
  return async (steps, instruction) => {
    const res = await handle(new Request('https://w.test/api/refine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps, instruction, datasets }) }), env);
    const body = await res.json() as any;
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${body.detail}`);
    return body;
  };
}

function viaPython(): (steps: S[], instruction: string) => Promise<Reply> {
  return async (steps, instruction) => {
    const res = await fetch('http://localhost:8000/api/refine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps, instruction, datasets }) });
    const body = await res.json() as any;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail).slice(0, 100)}`);
    return { ...body, neurons: 0 };
  };
}

const refine = target === 'python' ? viaPython() : await viaWorker();
let neurons = 0, correct = 0, rowsRight = 0, changedWhenImpossible = 0, ranOk = 0, refused = 0;
const seconds: number[] = [];
const notes: string[] = [];

for (const c of cases) {
  if (neurons >= Number(maxNeurons)) { console.log(`STOPPED: budget of ${maxNeurons} neurons reached`); break; }
  const t0 = Date.now();
  let reply: Reply;
  try { reply = await refine(c.before, c.instruction); } catch (e) { refused++; notes.push(`${c.id}: ${e instanceof Error ? e.message.slice(0, 110) : 'failed'}`); console.log(`${c.id.padEnd(4)} ERROR  ${e instanceof Error ? e.message.slice(0, 90) : ''}`); continue; }
  seconds.push((Date.now() - t0) / 1000);
  neurons += reply.neurons ?? 0;

  const current = asSteps(c.before, 'old');
  const applied = reply.unchanged || !reply.valid ? current : reconcile(current, reply.nodes).steps;
  const expected = await runFlow(asSteps(c.after, 'ref'), ctx, () => {});
  try {
    const got = await runFlow(applied, ctx, () => {});
    ranOk++;
    const same = JSON.stringify([got.columns, got.rows]) === JSON.stringify([expected.columns, expected.rows]);
    const subset = got.columns.length > 0 && got.columns.every(col => expected.columns.includes(col));
    const lenient = same || (subset && JSON.stringify(expected.rows.map(r => Object.fromEntries(got.columns.map(col => [col, r[col]])))) === JSON.stringify(got.rows));
    if (same) correct++;
    if (lenient) rowsRight++;
    if (c.impossible && !reply.unchanged && reply.valid) changedWhenImpossible++;
    const message = reply.unchanged ? '(unchanged)' : !reply.valid ? '(invalid, would be refused)' : describeChanges(reconcile(current, reply.nodes));
    console.log(`${c.id.padEnd(4)} ${same ? 'correct ' : lenient ? 'rows ok ' : 'WRONG   '} ${(Date.now() - t0) / 1000 < 100 ? ((Date.now() - t0) / 1000).toFixed(1) : '>100'}s  "${c.instruction}"\n       -> ${message.slice(0, 150)}`);
    if (!same) notes.push(`${c.id}: ${lenient ? 'rows right, columns differ' : 'wrong result'} (${got.rows.length} rows, expected ${expected.rows.length})`);
  } catch (e) {
    notes.push(`${c.id}: the refined workflow did not run: ${e instanceof Error ? e.message.slice(0, 90) : ''}`);
    console.log(`${c.id.padEnd(4)} did not run`);
  }
}
seconds.sort((a, b) => a - b);
console.log(`\nrefine via ${target}: ${cases.length} cases   correct ${correct}   rows right* ${rowsRight}   ran ${ranOk}   errors ${refused}   median ${seconds[Math.floor(seconds.length / 2)]?.toFixed(1)} s${target === 'worker' ? `   neurons ${neurons.toFixed(0)}` : ''}`);
console.log(`impossible requests (R9, R10) that still changed the workflow: ${changedWhenImpossible} of 2`);
console.log('* rows right = same result, or the right rows with extra columns dropped (post-hoc measure). Correct means the refined workflow produces exactly the reference result.');
if (notes.length) console.log('not exactly right:\n  ' + notes.join('\n  '));
