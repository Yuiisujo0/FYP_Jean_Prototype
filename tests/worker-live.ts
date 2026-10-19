// End-to-end check of the Worker's code against the REAL Workers AI, using the REST API in place of the binding.
// It costs neurons from the free daily allowance. Usage:
//   node tests/worker-live.ts [split=dev] [maxNeurons=600] [models=@cf/openai/gpt-oss-20b,@cf/meta/llama-3.1-8b-instruct]
// Credentials come from backend/.env and are never printed.
import { readFileSync } from 'node:fs';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import type { Step } from '../src/types.ts';
import { handle } from '../worker/src/index.ts';

const [split = 'dev', maxNeurons = '600', models = '@cf/openai/gpt-oss-20b,@cf/meta/llama-3.1-8b-instruct'] = process.argv.slice(2);

const dotenv = Object.fromEntries(
  readFileSync('backend/.env', 'utf-8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
if (!dotenv.CF_ACCOUNT_ID || !dotenv.CF_API_TOKEN) throw new Error('Set CF_ACCOUNT_ID and CF_API_TOKEN in backend/.env');

/** Behaves like the Workers AI binding: returns the result, throws on failure. */
const AI = {
  async run(model: string, inputs: unknown) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${dotenv.CF_ACCOUNT_ID}/ai/run/${model}`, {
      method: 'POST', headers: { Authorization: `Bearer ${dotenv.CF_API_TOKEN}` }, body: JSON.stringify(inputs),
    });
    const body = await res.json() as { success?: boolean; result?: unknown; errors?: { message: string }[] };
    if (!res.ok || !body.success) throw new Error((body.errors ?? []).map(e => e.message).join('; ') || `HTTP ${res.status}`);
    return body.result;
  },
};
const env = { AI, MODELS: models, ALLOWED_ORIGINS: '*', MAX_REQUESTS_PER_MINUTE: '1000' };

const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as {
  datasets: Record<string, Table>;
  tasks: { id: string; split: string; request: string; verified: boolean; steps: { type: string }[]; expected?: Table }[];
};
const names = Object.keys(data.datasets);
const datasets = names.map(name => ({ name, columns: data.datasets[name].columns }));
const ctx: RunContext = {
  listDatasets: async () => names.map((name, id) => ({ id, name, filename: `${name}.csv` })),
  loadDataset: async id => data.datasets[names[id]],
  saveTable: async () => {},
  fetchJson: async () => { throw new Error('no network'); },
};

const tasks = data.tasks.filter(t => t.split === split && t.verified);
let neurons = 0, strict = 0, rowsRight = 0, ran = 0, valid = 0;
const seconds: number[] = [];
const failures: string[] = [];

for (const t of tasks) {
  if (neurons >= Number(maxNeurons)) { console.log(`STOPPED: budget of ${maxNeurons} neurons reached`); break; }
  const started = Date.now();
  const res = await handle(new Request('https://w.test/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' }, body: JSON.stringify({ prompt: t.request, datasets }),
  }), env);
  const body = await res.json() as any;
  seconds.push((Date.now() - started) / 1000);
  if (res.status !== 200) { failures.push(`${t.id}: HTTP ${res.status} ${body.detail}`); neurons += 0; continue; }
  neurons += body.neurons ?? 0;
  if (body.valid) valid++;
  const steps: Step[] = body.flow.nodes.map((n: Step) => ({ ...n }));
  try {
    const out = await runFlow(steps, ctx, () => {});
    ran++;
    const exp = t.expected!;
    const same = JSON.stringify(out.columns) === JSON.stringify(exp.columns) && JSON.stringify(out.rows) === JSON.stringify(exp.rows);
    const subset = out.columns.length > 0 && out.columns.every(c => exp.columns.includes(c));
    const lenient = same || (subset && JSON.stringify(exp.rows.map(r => Object.fromEntries(out.columns.map(c => [c, r[c]])))) === JSON.stringify(out.rows));
    if (same) strict++;
    if (lenient) rowsRight++;
    console.log(`${t.id.padEnd(4)} ${same ? 'correct ' : lenient ? 'rows ok ' : 'WRONG   '} ${body.model.split('/').pop()}  ${(body.neurons ?? 0).toFixed(1)} neurons  ${body.flow.nodes.map((n: Step) => n.type).join(' > ')}`);
    if (!same) failures.push(`${t.id}: ${lenient ? 'rows right, columns differ' : 'wrong result'}`);
  } catch (e) {
    failures.push(`${t.id}: ${e instanceof Error ? e.message.slice(0, 100) : 'failed'}`);
    console.log(`${t.id.padEnd(4)} did not run  ${e instanceof Error ? e.message.slice(0, 90) : ''}`);
  }
}
seconds.sort((a, b) => a - b);
console.log(`\n${split}: ${tasks.length} tasks through the Worker code, real Workers AI (${models})`);
console.log(`valid ${valid}   ran ${ran}   strict correct ${strict}   rows right* ${rowsRight}   median ${seconds[Math.floor(seconds.length / 2)]?.toFixed(1)} s   neurons spent ${neurons.toFixed(0)}`);
console.log('* rows right = strict, or right rows with extra columns dropped (post-hoc measure)');
if (failures.length) console.log('not exactly right:\n  ' + failures.join('\n  '));
