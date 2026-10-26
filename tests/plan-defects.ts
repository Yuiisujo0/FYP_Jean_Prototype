// Plan-defect benchmark: how well do the request-versus-workflow checks and the rule repairs work, with no model involved?
//   node tests/plan-defects.ts [--all] [--verbose]   (default skips the unspent holdouts, holdout2 and holdout3)
//
// Every CORRECT reference workflow gets one typical planning mistake injected (the kinds seen in the saved model runs):
//   dropped_value     one comparison of an "and" filter taken out (half the request ignored)
//   wrong_column      a text value compared with another text column of the same table
//   invented_value    an extra "and <column> == <a value the request never mentions>"
//   no_sort           the sort before a limit taken out ("top 5" = the first 5 in file order)
//   no_brackets       the brackets round an or-group taken out (and binds first)
//   dropped_not       a "!=" / "not in" comparison taken out
//   flipped_not       "!=" turned into "==", "not in" into "in"
//   missing_join      the join step taken out
//   wrong_dataset     the workflow reads a dataset that shares no column with the right one
// A mutant whose result is identical to the reference is not a defect and is skipped. For the rest:
//   detected  the agent's observation raised at least one signal it would act on (REVISE_ON)
//   named     a signal of the kind built for this mistake was among them
//   fixed     the agent loop with the rules only (the model "keeps the workflow as it was") ends with the reference result
// These mutants are made by us, from the same reference workflows the checks were tuned on, so the numbers say what
// the checks cover, not how often a model makes each mistake.
import { readFileSync } from 'node:fs';
import { checkByRunning } from '../src/lib/agent.ts';
import { conditionComparisons, runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { observeRun, REVISE_ON } from '../src/lib/observe.ts';
import type { Step } from '../src/types.ts';

interface Task { id: string; split: string; dataset: string; request: string; verified: boolean; steps: { type: string; config: Record<string, string> }[] }
const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as { datasets: Record<string, Table>; tasks: Task[] };
const names = Object.keys(data.datasets);
const outlines = names.map(n => ({ name: n, columns: data.datasets[n].columns }));
const ctx: RunContext = {
  listDatasets: async () => names.map((n, id) => ({ id, name: n, filename: `${n}.csv`, origin: 'upload' as const })),
  loadDataset: async id => data.datasets[names[id]],
  saveTable: async () => {},
  fetchJson: async () => { throw new Error('no network'); },
};
const all = process.argv.includes('--all');
const verbose = process.argv.includes('--verbose');

const EXPECT: Record<string, string[]> = {
  dropped_value: ['unused_value', 'unused_number'], wrong_column: ['wrong_column'], invented_value: ['invented_value'], no_sort: ['no_sort'],
  no_brackets: ['mixed_logic'], dropped_not: ['unused_value'], flipped_not: ['lost_not'], missing_join: ['missing_join'], wrong_dataset: ['wrong_dataset'],
};

type Raw = { type: string; config: Record<string, string> };
const clone = (steps: Raw[]): Raw[] => steps.map(s => ({ type: s.type, config: { ...s.config } }));
const asSteps = (steps: Raw[], tag: string): Step[] => steps.map((s, i) => ({ id: `${tag}-${i}`, type: s.type, name: s.type, description: '', config: { ...s.config } }));
const isNumeric = (v: string) => v.trim() !== '' && Number.isFinite(Number(v));

/** Top-level "and" terms of a condition with no brackets and no or, or null. */
const andTerms = (c: string) => (/[()]|\bor\b/i.test(c) || !/\band\b/i.test(c) || /\bbetween\b/i.test(c) ? null : c.split(/\s+and\s+/i));

function mutants(t: Task): { kind: string; steps: Raw[] }[] {
  const out: { kind: string; steps: Raw[] }[] = [];
  const table = data.datasets[t.dataset];
  const textColumns = table.columns.filter(c => table.rows.some(r => r[c] && !isNumeric(r[c])));
  t.steps.forEach((s, i) => {
    const c = s.config.condition ?? '';
    const op = s.config.operation ?? '';
    if (s.type === 'FILTER') {
      const terms = andTerms(c);
      if (terms) terms.forEach((term, k) => {
        const kind = /!=|\bnot in\b/i.test(term) ? 'dropped_not' : 'dropped_value';
        const m = clone(t.steps); m[i].config.condition = terms.filter((_, j) => j !== k).join(' and '); out.push({ kind, steps: m });
      });
      if (/!=|\bnot in\b/i.test(c)) { const m = clone(t.steps); m[i].config.condition = c.replace(/!=/g, '==').replace(/\bnot in\b/gi, 'in'); out.push({ kind: 'flipped_not', steps: m }); }
      if (/\(/.test(c) && /\bor\b/i.test(c) && !/\bin\s*\(/i.test(c)) { const m = clone(t.steps); m[i].config.condition = c.replace(/[()]/g, ''); out.push({ kind: 'no_brackets', steps: m }); }
      for (const cmp of conditionComparisons(c, table.columns)) {
        if (!['==', '='].includes(cmp.op) || isNumeric(cmp.literal)) continue;
        const other = textColumns.find(col => col !== cmp.column && !table.rows.some(r => (r[col] ?? '').toLowerCase() === cmp.literal.toLowerCase()));
        if (!other) continue;
        const m = clone(t.steps); m[i].config.condition = c.replace(new RegExp(`\\b${cmp.column}\\b`), other); out.push({ kind: 'wrong_column', steps: m });
        break;
      }
    }
    if (s.type === 'TRANSFORM' && /^\s*sort\b/i.test(op) && t.steps.slice(i + 1).some(x => /^\s*limit\b/i.test(x.config.operation ?? ''))) {
      out.push({ kind: 'no_sort', steps: clone(t.steps).filter((_, j) => j !== i) });
    }
    if (s.type === 'TRANSFORM' && /^\s*join\b/i.test(op)) out.push({ kind: 'missing_join', steps: clone(t.steps).filter((_, j) => j !== i) });
  });
  // An extra comparison with a value of a text column the request never mentions.
  const asked = t.request.toLowerCase();
  for (const col of textColumns) {
    const values = [...new Set(table.rows.map(r => r[col]).filter(Boolean))];
    if (values.length < 3 || values.length > 20) continue;
    const v = values.find(x => !asked.includes(x.toLowerCase()) && x.length >= 3);
    if (!v) continue;
    const m = clone(t.steps);
    const at = m.findIndex(x => x.type === 'FILTER');
    const extra = `${col} == ${/\s/.test(v) ? `"${v}"` : v}`;
    if (at >= 0) m[at].config.condition = `${/\bor\b/i.test(m[at].config.condition ?? '') ? `(${m[at].config.condition})` : m[at].config.condition} and ${extra}`;
    else m.splice(1, 0, { type: 'FILTER', config: { condition: extra } });
    out.push({ kind: 'invented_value', steps: m });
    break;
  }
  // Reading a dataset that shares no column with the right one.
  const unrelated = names.find(n => n !== t.dataset && !data.datasets[n].columns.some(c => table.columns.includes(c)));
  if (unrelated && t.steps[0]?.type === 'READ_CSV') { const m = clone(t.steps); m[0].config.file = unrelated; out.push({ kind: 'wrong_dataset', steps: m }); }
  return out;
}

const fingerprint = (r: { columns: string[]; rows: Record<string, string>[] }) => JSON.stringify([r.columns, r.rows]);
async function result(steps: Step[]): Promise<{ ok: true; r: Awaited<ReturnType<typeof runFlow>> } | { ok: false; error: string }> {
  try { return { ok: true, r: await runFlow(steps, ctx, () => {}, { dryRun: true }) }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

interface Row { pairs: number; detected: number; named: number; fixed: number; missed: string[] }
const tally = new Map<string, Row>();
for (const t of data.tasks) {
  if (!t.verified || (!all && (t.split === 'holdout2' || t.split === 'holdout3'))) continue;
  const ref = await result(asSteps(t.steps, t.id));
  if (!ref.ok) continue;
  const want = fingerprint(ref.r);
  for (const [n, m] of mutants(t).entries()) {
    const steps = asSteps(m.steps, `${t.id}m${n}`);
    const got = await result(steps);
    if (got.ok && fingerprint(got.r) === want) continue;   // not a defect: the answer did not change
    const row = tally.get(m.kind) ?? { pairs: 0, detected: 0, named: 0, fixed: 0, missed: [] };
    tally.set(m.kind, row);
    row.pairs++;
    const obs = observeRun(steps, got.ok ? { result: got.r } : { error: got.error }, t.request, outlines);
    const kinds = new Set(obs.signals.map(s => s.kind));
    const acted = [...kinds].some(k => REVISE_ON.has(k));
    if (acted) row.detected++; else row.missed.push(t.id);
    if (EXPECT[m.kind].some(k => kinds.has(k as never))) row.named++;
    const agent = await checkByRunning(steps, {
      test: async s => { const x = await result(s); return x.ok ? { result: x.r } : { error: x.error }; },
      revise: async s => ({ nodes: s, valid: true, unchanged: true, issues: [] }),
      request: t.request, datasets: outlines,
    });
    const after = await result(agent.steps);
    if (after.ok && fingerprint(after.r) === want) row.fixed++;
    if (verbose) console.log(`${m.kind.padEnd(15)} ${t.id.padEnd(4)} ${acted ? 'detected' : 'MISSED  '} [${[...kinds].join(', ')}] ${after.ok && fingerprint(after.r) === want ? 'fixed' : ''}`);
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
console.log(`\n${'mistake'.padEnd(15)} ${'cases'.padStart(5)}  ${'detected'.padStart(13)}  ${'named'.padStart(13)}  ${'fixed by rules'.padStart(15)}  missed (task ids)`);
let P = 0, D = 0, N = 0, F = 0;
for (const [kind, r] of [...tally].sort()) {
  P += r.pairs; D += r.detected; N += r.named; F += r.fixed;
  console.log(`${kind.padEnd(15)} ${String(r.pairs).padStart(5)}  ${`${r.detected} (${pct(r.detected, r.pairs)})`.padStart(13)}  ${`${r.named} (${pct(r.named, r.pairs)})`.padStart(13)}  ${`${r.fixed} (${pct(r.fixed, r.pairs)})`.padStart(15)}  ${r.missed.slice(0, 8).join(' ')}${r.missed.length > 8 ? ' ...' : ''}`);
}
console.log(`${'all'.padEnd(15)} ${String(P).padStart(5)}  ${`${D} (${pct(D, P)})`.padStart(13)}  ${`${N} (${pct(N, P)})`.padStart(13)}  ${`${F} (${pct(F, P)})`.padStart(15)}`);
