// Measures what the engine reports when one defect is injected into the data. No model is involved: every task runs
// its REFERENCE workflow, so the numbers show the engine's review layer, not the model.
//   node tests/defect-check.ts          (needs backend/eval/defects.json from make_defects.py)
//
// For every (variant, task) pair: run the workflow on the clean data and on the defective data. If the two results
// differ in the rows or values that matter, the defect changed the answer ("silent error": the run itself reports no failure). It counts as DETECTED when
// the engine raised an exception about the injected row (or, for a lookup table with a repeated key, a join_multiple
// exception). Pairs where the result did not change are not errors; critical exceptions raised on them are counted
// separately as noise.
import { readFileSync } from 'node:fs';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import type { Step } from '../src/types.ts';

interface TaskFile { datasets: Record<string, Table>; tasks: { id: string; split: string; dataset: string; steps: { type: string; config: Record<string, string> }[]; verified: boolean }[] }
interface Variant { id: string; dataset: string; kind: string; target: string; row: number; column: string; was: string; columns: string[]; rows: Record<string, string>[] }

const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as TaskFile;
const { variants } = JSON.parse(readFileSync(`backend/eval/${process.argv[2] ?? 'defects.json'}`, 'utf-8')) as { variants: Variant[] };
const names = Object.keys(data.datasets);

const ctx = (swap?: { name: string; table: Table }): RunContext => ({
  listDatasets: async () => names.map((name, id) => ({ id, name, filename: `${name}.csv` })),
  loadDataset: async id => (swap && names[id] === swap.name ? swap.table : data.datasets[names[id]]),
  saveTable: async () => {}, fetchJson: async () => [],
});
const asSteps = (t: TaskFile['tasks'][number]): Step[] => t.steps.map((s, i) => ({ id: `s${i}`, type: s.type, name: s.type, config: s.config }) as Step);
const fingerprint = (r: { columns: string[]; rows: Record<string, string>[] }) => JSON.stringify([r.columns, r.rows]);

interface Tally { pairs: number; silent: number; detected: number; critical: number; noise: number; missed: string[] }
const tally = new Map<string, Tally>();
const get = (k: string) => { if (!tally.has(k)) tally.set(k, { pairs: 0, silent: 0, detected: 0, critical: 0, noise: 0, missed: [] }); return tally.get(k)!; };

const joinsLookup = (t: TaskFile['tasks'][number], lookup: string) =>
  t.steps.some(s => s.type === 'TRANSFORM' && new RegExp(`^join\\s+${lookup}\\b`, 'i').test(s.config.operation ?? ''));

// A misspelled join key only matters to workflows that join on it.
const JOIN_LOOKUP: Record<string, string> = { student_marks: 'courses', inventory: 'suppliers' };

for (const v of variants) {
  const swap = { name: v.dataset, table: { columns: v.columns, rows: v.rows } };
  const lookupOf = v.kind === 'orphan' ? JOIN_LOOKUP[v.dataset] : undefined;
  const tasks = data.tasks.filter(t => t.verified && (v.target === 'lookup' ? joinsLookup(t, v.dataset)
    : v.kind === 'orphan' ? t.dataset === v.dataset && !!lookupOf && joinsLookup(t, lookupOf) : t.dataset === v.dataset));
  for (const t of tasks) {
    const clean = await runFlow(asSteps(t), ctx(), () => {}, { dryRun: true });
    const bad = await runFlow(asSteps(t), ctx(swap), () => {}, { dryRun: true });
    const row = get(v.kind);
    row.pairs++;
    // A defective cell that is only shown as it is (blank or "n/a" in the output) is visible, not silent. Silent means
    // the wrong rows are in the result (rows or order changed) or, after a group or join, a calculated or added value changed.
    const ops = t.steps.filter(x => x.type === 'TRANSFORM').map(x => x.config.operation ?? '');
    const grouped = ops.some(o => /^(group|summari[sz]e|aggregate)/i.test(o));
    const joined = ops.some(o => /^join/i.test(o));
    // Columns the join added: a changed value there is silent, a changed value in a column of the original table is only the defect showing.
    const added = clean.columns.filter(c => !data.datasets[t.dataset].columns.includes(c));
    const addedValues = (r: typeof clean) => JSON.stringify(r.rows.map(x => added.map(c => x[c] ?? '')));
    const silent = grouped ? fingerprint(clean) !== fingerprint(bad)
      : JSON.stringify(clean.lineage) !== JSON.stringify(bad.lineage) || (joined && addedValues(clean) !== addedValues(bad));
    const about = bad.exceptions.filter(e => (v.target === 'lookup' ? e.kind === 'join_multiple' : e.rows.includes(v.row)));
    const dupGone = v.kind === 'duplicate' && bad.register?.rows[v.row - 1]?.reason?.startsWith('duplicate of');
    const seen = about.length > 0 || !!dupGone;
    const critical = bad.exceptions.filter(e => e.severity === 'critical' && !clean.exceptions.some(c => c.id === e.id && c.rows.join() === e.rows.join()));
    if (silent) {
      row.silent++;
      if (seen) row.detected++; else row.missed.push(t.id);
      if (about.some(e => e.severity === 'critical')) row.critical++;
    } else if (critical.length) row.noise++;
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
console.log(`${variants.length} variants, one defect each. Reference workflows only (no model).\n`);
console.log('kind        pairs  changed answer  reported (recall)   of which critical   critical but answer unchanged');
let S = 0, D = 0;
for (const [kind, t] of tally) {
  S += t.silent; D += t.detected;
  console.log(`${kind.padEnd(10)} ${String(t.pairs).padStart(6)} ${String(t.silent).padStart(15)} ${`${t.detected} (${pct(t.detected, t.silent)})`.padStart(19)} ${String(t.critical).padStart(19)} ${String(t.noise).padStart(30)}`);
}
console.log(`\nall kinds: the defect changed the answer in ${S} cases; the engine reported the row in ${D} (${pct(D, S)}).`);
for (const [kind, t] of tally) {
  if (t.missed.length) console.log(`  not reported, ${kind}: ${t.missed.length} cases, tasks ${[...new Set(t.missed)].slice(0, 12).join(', ')}`);
}
