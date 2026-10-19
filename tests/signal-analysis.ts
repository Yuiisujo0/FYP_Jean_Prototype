// How much could the run-and-observe loop catch? Re-runs every saved, scored generation and checks whether any signal
// (src/lib/observe.ts) fires on the wrong ones (recall) and on the right ones (false alarms). No model calls.
// The signals were defined before this script was first run. One decision was made after seeing its output (which
// includes the holdout): undecided_rows no longer triggers a revision (REVISE_ON in observe.ts). Disclose that; tune
// nothing else on this output. It measures detection only: whether the model then FIXES a workflow needs live runs.
// Usage: node tests/signal-analysis.ts
import { readdirSync, readFileSync } from 'node:fs';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { observeRun, REVISE_ON, type TestOutcome } from '../src/lib/observe.ts';
import type { Step } from '../src/types.ts';

const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as { datasets: Record<string, Table> };
const names = Object.keys(data.datasets);
const ctx: RunContext = {
  listDatasets: async () => names.map((name, id) => ({ id, name, filename: `${name}.csv` })),
  loadDataset: async id => data.datasets[names[id]],
  saveTable: async () => {},
  fetchJson: async () => { throw new Error('no network'); },
};

interface Scored { task: string; condition: string; steps?: { type: string; config: Record<string, string> }[]; error?: string; correct: boolean; failure: string }

const files = readdirSync('backend/eval/runs').filter(f => f.endsWith('.scored.json')).sort();
const total = { wrong: 0, caught: 0, right: 0, alarms: 0, genErrors: 0, caughtRevise: 0, alarmsRevise: 0 };
const bySignal = new Map<string, { wrong: number; right: number }>();
const missed: string[] = [];

console.log('run file                              | wrong | caught | right | false alarms');
console.log('--------------------------------------|-------|--------|-------|-------------');
for (const f of files) {
  const rows = JSON.parse(readFileSync(`backend/eval/runs/${f}`, 'utf-8')) as Scored[];
  const t = { wrong: 0, caught: 0, right: 0, alarms: 0, caughtRevise: 0, alarmsRevise: 0 };
  for (const g of rows) {
    if (g.error || !g.steps) { total.genErrors++; continue; }   // no workflow to run: the loop never starts
    const steps: Step[] = g.steps.map((s, i) => ({ id: `s${i}`, type: s.type, name: s.type, description: '', config: s.config }));
    let outcome: TestOutcome;
    try { outcome = { result: await runFlow(steps, ctx, () => {}, { dryRun: true }) }; }
    catch (e) { outcome = { error: e instanceof Error ? e.message : 'failed' }; }
    const kinds = [...new Set(observeRun(steps, outcome).signals.map(s => s.kind))];
    for (const k of kinds) {
      const b = bySignal.get(k) ?? { wrong: 0, right: 0 };
      if (g.correct) b.right++; else b.wrong++;
      bySignal.set(k, b);
    }
    const revise = kinds.some(k => REVISE_ON.has(k));
    if (g.correct) { t.right++; if (kinds.length) t.alarms++; if (revise) t.alarmsRevise++; }
    else {
      t.wrong++;
      if (revise) t.caughtRevise++;
      if (kinds.length) t.caught++;
      else missed.push(`${f.replace('.scored.json', '')} ${g.task} ${g.condition}: ${g.failure}`);
    }
  }
  for (const k of Object.keys(t) as (keyof typeof t)[]) total[k] += t[k];
  console.log(`${f.replace('.scored.json', '').padEnd(37)} | ${String(t.wrong).padStart(5)} | ${String(t.caught).padStart(6)} | ${String(t.right).padStart(5)} | ${String(t.alarms).padStart(12)}`);
}
const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(0) : 0}%`;
console.log(`\nALL: wrong workflows ${total.wrong}, caught by a signal ${total.caught} (${pct(total.caught, total.wrong)});`
  + ` right workflows ${total.right}, false alarms ${total.alarms} (${pct(total.alarms, total.right)}); generation errors (not runnable) ${total.genErrors}.`);
console.log(`Signals that trigger a revision (REVISE_ON): caught ${total.caughtRevise} of ${total.wrong} wrong (${pct(total.caughtRevise, total.wrong)}),`
  + ` false alarms ${total.alarmsRevise} of ${total.right} right (${pct(total.alarmsRevise, total.right)}).`);
console.log('\nper signal (how often it fired on wrong / right workflows):');
for (const [k, b] of [...bySignal].sort()) console.log(`  ${k.padEnd(16)} wrong ${b.wrong}, right ${b.right}`);
console.log('\nwrong workflows no signal caught:');
for (const m of missed) console.log(`  ${m}`);
