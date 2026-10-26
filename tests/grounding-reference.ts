// False-positive check: the grounding checks must stay quiet on the REFERENCE (correct) workflows.
// Usage: node tests/grounding-reference.ts [--all]   (default skips the unspent holdouts, holdout2 and holdout3, so nobody looks at them)
import { readFileSync } from 'node:fs';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { groundingFindings } from '../src/lib/grounding.ts';
import type { Step } from '../src/types.ts';

const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as { datasets: Record<string, Table>; tasks: { id: string; split: string; request: string; verified: boolean; steps: { type: string; config: Record<string, string> }[] }[] };
const names = Object.keys(data.datasets);
const ctx: RunContext = {
  listDatasets: async () => names.map((n, id) => ({ id, name: n, filename: `${n}.csv`, origin: 'upload' as const })),
  loadDataset: async id => data.datasets[names[id]],
  saveTable: async () => {},
  fetchJson: async () => { throw new Error('no network'); },
};
const outlines = names.map(n => ({ name: n, columns: data.datasets[n].columns }));
const all = process.argv.includes('--all');
let n = 0, flagged = 0;
for (const t of data.tasks) {
  if (!t.verified || t.split === 'library' && false) continue;
  if (!all && (t.split === 'holdout2' || t.split === 'holdout3')) continue;
  const steps: Step[] = t.steps.map((s, i) => ({ id: `${t.id}-${i}`, type: s.type, name: s.type, description: '', config: s.config }));
  const r = await runFlow(steps, ctx, () => {}, { dryRun: true });
  const f = groundingFindings(t.request, steps, r.input, outlines, r.rows.length);
  n++;
  if (f.length) { flagged++; console.log(`${t.id.padEnd(4)} ${t.split.padEnd(8)} ${t.request}\n     ${f.map(x => `[${x.kind}] ${x.text}`).join('\n     ')}`); }
}
console.log(`\n${flagged} of ${n} correct reference workflows raised a finding`);
