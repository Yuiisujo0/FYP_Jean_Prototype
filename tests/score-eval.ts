// Executes the workflows saved by backend/eval/run_eval.py on the real datasets and scores them.
// Usage: node tests/score-eval.ts backend/eval/runs/<name>.json
import { readFileSync, writeFileSync } from 'node:fs';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import type { Step } from '../src/types.ts';

interface Gen { task: string; condition: string; steps: { type: string; config: Record<string, string> }[]; valid: boolean; first_try_valid: boolean; seconds: number; prompt_tokens: number; error?: string }
const path = process.argv[2];
if (!path) throw new Error('Usage: node tests/score-eval.ts <run.json>');
const run = JSON.parse(readFileSync(path, 'utf-8')) as { model: string; rows: Gen[] };
const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as {
  datasets: Record<string, Table>;
  tasks: { id: string; steps: { type: string }[]; expected?: Table }[];
};
const names = Object.keys(data.datasets);
const ctx: RunContext = {
  listDatasets: async () => names.map((name, id) => ({ id, name, filename: `${name}.csv` })),
  loadDataset: async id => data.datasets[names[id]],
  saveTable: async () => {},
  fetchJson: async () => { throw new Error('no network'); },
};

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number, d: number) => `${((100 * n) / Math.max(d, 1)).toFixed(0)}%`;

const scored = [];
for (const g of run.rows) {
  const task = data.tasks.find(t => t.id === g.task)!;
  if (g.error) { scored.push({ ...g, ran: false, correct: false, rowsRight: false, sequence: false, failure: `generation error: ${g.error}` }); continue; }
  const steps: Step[] = g.steps.map((s, i) => ({ id: `${g.task}-${i}`, type: s.type, name: s.type, description: '', config: s.config }));
  const sequence = g.steps.map(s => s.type).join('>') === task.steps.map(s => s.type).join('>');
  let ran = false, correct = false, rowsRight = false, failure = '';
  try {
    const out = await runFlow(steps, ctx, () => {});
    ran = true;
    correct = JSON.stringify(out.columns) === JSON.stringify(task.expected!.columns) && JSON.stringify(out.rows) === JSON.stringify(task.expected!.rows);
    // Secondary, added AFTER seeing results: are the rows right, ignoring extra column selection? The result's columns must be a
    // non-empty subset of the expected columns, and the expected rows restricted to them must equal the result rows, in order.
    const exp = task.expected!;
    const subset = out.columns.length > 0 && out.columns.every(c => exp.columns.includes(c));
    rowsRight = correct || (subset && JSON.stringify(exp.rows.map(r => Object.fromEntries(out.columns.map(c => [c, r[c]])))) === JSON.stringify(out.rows));
    if (!correct) failure = `ran, wrong result (${out.rows.length} rows, expected ${task.expected!.rows.length})${rowsRight ? ' [rows right, columns differ]' : ''}`;
  } catch (e) {
    failure = e instanceof Error ? e.message.replace(/^“[^”]*” stopped the run\. /, '').slice(0, 110) : 'failed';
  }
  scored.push({ ...g, ran, correct, rowsRight, sequence, failure });
}

const conditions = [...new Set(scored.map(s => s.condition))];
console.log(`\nmodel ${run.model}   tasks per condition: ${scored.filter(s => s.condition === conditions[0]).length}\n`);
console.log('condition  | valid 1st try | valid final | ran OK | CORRECT result | rows right* | same op sequence | median s | mean prompt tokens');
console.log('-----------|---------------|-------------|--------|----------------|-------------|------------------|----------|-------------------');
for (const c of conditions) {
  const r = scored.filter(s => s.condition === c);
  console.log([
    c.padEnd(10),
    pct(r.filter(x => x.first_try_valid).length, r.length).padEnd(13),
    pct(r.filter(x => x.valid).length, r.length).padEnd(11),
    pct(r.filter(x => x.ran).length, r.length).padEnd(6),
    `${r.filter(x => x.correct).length}/${r.length} (${pct(r.filter(x => x.correct).length, r.length)})`.padEnd(14),
    `${r.filter(x => x.rowsRight).length}/${r.length}`.padEnd(11),
    pct(r.filter(x => x.sequence).length, r.length).padEnd(16),
    median(r.map(x => x.seconds)).toFixed(1).padEnd(8),
    mean(r.map(x => x.prompt_tokens)).toFixed(0),
  ].join(' | '));
}
console.log('\n* rows right = the strict result, OR the right rows with extra columns dropped. Added after seeing results; strict CORRECT is the pre-set metric.');
console.log('\nfailures:');
for (const s of scored.filter(s => !s.correct)) console.log(`  ${s.task.padEnd(3)} ${s.condition.padEnd(9)} ${s.failure}`);
writeFileSync(path.replace(/\.json$/, '.scored.json'), JSON.stringify(scored, null, 1));
