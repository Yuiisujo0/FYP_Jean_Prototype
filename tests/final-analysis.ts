// The analysis fixed in backend/eval/FREEZE.md (section 5.5), read from saved run files only.
//   node tests/final-analysis.ts                                   the final holdout runs (final-*)
//   node tests/final-analysis.ts --prefix r1101b --splits dev,dev2,dev3,fresh --models qwen25-7b,gemma3-4b,qwen3-4b,gptoss
//                                                                  the same analysis on development runs (to check the script)
// Each task's outcome for the tests is "correct in at least 2 of its 3 runs". McNemar's exact test (two-sided) compares
// conditions task by task; Holm's correction runs across the models within each comparison and split.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const prefix = arg('prefix', 'final');
const splits = arg('splits', 'holdout2,holdout3').split(',');
const models = arg('models', 'gptoss,qwen25-7b,gemma3-4b,qwen3-4b,llama32-3b').split(',');
const dir = 'backend/eval/runs';

type Outcome = { ran: boolean; correct: boolean; rowsRight: boolean };
interface Row {
  task: string; split: string; flagged?: boolean; error?: string;
  oneShot?: Outcome; repair?: Outcome; agent?: Outcome; tools?: Outcome;
  ms?: { generate?: number; agent?: number; tools?: number };
}
const CONDITIONS = { oneShot: 'One-shot', repair: 'Validator repair', agent: 'Agent, model only', tools: 'Agent, rules first' } as const;
type Condition = keyof typeof CONDITIONS;

/* ---------- statistics ---------- */
function logChoose(n: number, k: number) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}
/** McNemar's exact test: b and c are the tasks right under only one of the two conditions. Two-sided. */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k++) tail += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}
/** Holm's step-down correction: adjusted p-values in the original order. */
export function holm(ps: number[]): number[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array<number>(ps.length);
  let running = 0;
  order.forEach(({ p, i }, rank) => { running = Math.max(running, Math.min(1, p * (ps.length - rank))); out[i] = running; });
  return out;
}
/** Wilson's 95% interval for k successes out of n. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const pct = (k: number, n: number) => (n ? `${Math.round(100 * k / n)}%` : '-');
const f1 = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const pv = (p: number) => (p < 0.001 ? '<0.001' : p.toFixed(3));

/* ---------- reading ---------- */
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function runsOf(slug: string): Row[][] {
  const out: Row[][] = [];
  for (let i = 1; existsSync(`${dir}/${prefix}-${slug}-r${i}.json`); i++) out.push(json(`${dir}/${prefix}-${slug}-r${i}.json`).rows);
  return out;
}
/** Per task, whether it was right in at least 2 of the runs (half or more when the number of runs is not 3). */
function majority(runs: Row[][], split: string, pick: (r: Row) => boolean): Map<string, boolean> {
  const votes = new Map<string, number>();
  for (const rows of runs) for (const r of rows) if (r.split === split) votes.set(r.task, (votes.get(r.task) ?? 0) + (pick(r) ? 1 : 0));
  return new Map([...votes].map(([t, v]) => [t, v * 2 > runs.length]));
}
function paired(a: Map<string, boolean>, b: Map<string, boolean>) {
  let onlyA = 0, onlyB = 0;
  for (const [t, x] of a) { const y = b.get(t) ?? false; if (x && !y) onlyA++; if (y && !x) onlyB++; }
  return { onlyA, onlyB, p: mcnemar(onlyA, onlyB) };
}

/* ---------- the analysis ---------- */
const report: Record<string, unknown> = { prefix, splits, made: new Date().toISOString() };
const lines: string[] = [];
const out = (s = '') => lines.push(s);
const present = models.filter(m => runsOf(m).length);
out(`# Final analysis (${prefix}-*, ${splits.join(' and ')})`);
out(`Models with runs: ${present.join(', ') || 'none'}. A task counts as correct for the tests when it was right in at least 2 of its 3 runs.`);

for (const split of splits) {
  out(`\n## ${split}`);
  const n = (() => { const r = runsOf(present[0] ?? '')[0]; return r ? r.filter(x => x.split === split).length : 0; })();
  out(`\n${n} tasks. Exact correct, mean of the runs (range); right rows (extra columns allowed) after the slash; majority outcome with its 95% interval.\n`);
  out('| Model | ' + Object.values(CONDITIONS).join(' | ') + ' |');
  out('|---|' + Object.keys(CONDITIONS).map(() => '---').join('|') + '|');
  const perModel: Record<string, unknown> = {};
  for (const m of present) {
    const runs = runsOf(m);
    const cells: string[] = [];
    const conds: Record<string, unknown> = {};
    for (const c of Object.keys(CONDITIONS) as Condition[]) {
      const exact = runs.map(rows => rows.filter(r => r.split === split && r[c]?.correct).length);
      const right = runs.map(rows => rows.filter(r => r.split === split && r[c]?.rowsRight).length);
      const maj = [...majority(runs, split, r => !!r[c]?.correct).values()].filter(Boolean).length;
      const [lo, hi] = wilson(maj, n);
      const mean = exact.reduce((a, b) => a + b, 0) / exact.length;
      cells.push(`${f1(+mean.toFixed(1))} (${Math.min(...exact)}-${Math.max(...exact)}) ${pct(mean, n)} / ${f1(+(right.reduce((a, b) => a + b, 0) / right.length).toFixed(1))}; majority ${maj} [${pct(lo * n, n)}-${pct(hi * n, n)}]`);
      conds[c] = { exact, rowsRight: right, majority: maj, ci95: [lo, hi] };
    }
    out(`| ${m} | ${cells.join(' | ')} |`);
    perModel[m] = conds;
  }

  // McNemar, Holm across the models within each comparison.
  const comparisons: [Condition, Condition, string][] = [['tools', 'oneShot', 'Rules first vs one-shot'], ['agent', 'oneShot', 'Model only vs one-shot'], ['tools', 'agent', 'Rules first vs model only']];
  out('\nMcNemar\'s exact test on the majority outcomes (tasks right only under the first / only under the second; p, then Holm-adjusted p):\n');
  out('| Comparison | ' + present.join(' | ') + ' |');
  out('|---|' + present.map(() => '---').join('|') + '|');
  const tests: Record<string, unknown> = {};
  for (const [a, b, label] of comparisons) {
    const res = present.map(m => { const runs = runsOf(m); return paired(majority(runs, split, r => !!r[a]?.correct), majority(runs, split, r => !!r[b]?.correct)); });
    const adj = holm(res.map(r => r.p));
    out(`| ${label} | ${res.map((r, i) => `${r.onlyA}/${r.onlyB}; p ${pv(r.p)}, adj. ${pv(adj[i])}${adj[i] < 0.05 ? ' *' : ''}`).join(' | ')} |`);
    tests[label] = present.map((m, i) => ({ model: m, ...res[i], holm: adj[i] }));
  }

  // Detection and repair, summed over the runs.
  out('\nAgent, rules first, summed over the runs: wrong first drafts flagged; right first drafts flagged (false alarms); wrong drafts fixed; right drafts broken.\n');
  out('| Model | Wrong flagged | False alarms | Fixed | Broken |');
  out('|---|---|---|---|---|');
  const detection: Record<string, unknown> = {};
  for (const m of present) {
    let wrong = 0, flaggedWrong = 0, right = 0, falseAlarms = 0, fixed = 0, broken = 0;
    for (const rows of runsOf(m)) for (const r of rows.filter(x => x.split === split && x.oneShot?.ran !== undefined)) {
      const ok = !!r.oneShot?.correct;
      if (ok) { right++; if (r.flagged) falseAlarms++; if (!r.tools?.correct) broken++; }
      else { wrong++; if (r.flagged) flaggedWrong++; if (r.tools?.correct) fixed++; }
    }
    out(`| ${m} | ${flaggedWrong} of ${wrong} | ${falseAlarms} of ${right} | ${fixed} | ${broken} |`);
    detection[m] = { wrong, flaggedWrong, right, falseAlarms, fixed, broken };
  }

  // Time.
  out('\nSeconds per task over all runs, median / 90th percentile.\n');
  out('| Model | One-shot | Rules first |');
  out('|---|---|---|');
  const time: Record<string, unknown> = {};
  for (const m of present) {
    const rows = runsOf(m).flat().filter(r => r.split === split && r.ms);
    const one = rows.map(r => (r.ms!.generate ?? 0) / 1000), rules = rows.map(r => ((r.ms!.generate ?? 0) + (r.ms!.tools ?? 0)) / 1000);
    out(`| ${m} | ${quantile(one, 0.5).toFixed(1)} / ${quantile(one, 0.9).toFixed(1)} | ${quantile(rules, 0.5).toFixed(1)} / ${quantile(rules, 0.9).toFixed(1)} |`);
    time[m] = { oneShot: [quantile(one, 0.5), quantile(one, 0.9)], rulesFirst: [quantile(rules, 0.5), quantile(rules, 0.9)] };
  }

  // With and without retrieval (Python pipeline, one run).
  const retr = present.map(m => ({ m, path: `${dir}/${prefix}-retrieval-${m}-${split}.scored.json` })).filter(x => existsSync(x.path));
  const retrieval: Record<string, unknown> = {};
  if (retr.length) {
    out('\nWith and without retrieval (Python pipeline, one run): exact correct; McNemar with retrieval vs without.\n');
    out('| Model | Without | With | Right only with / only without; p, Holm-adjusted |');
    out('|---|---|---|---|');
    const res = retr.map(({ m, path }) => {
      const rows: { task: string; condition: string; correct: boolean }[] = json(path);
      const by = (c: string) => new Map(rows.filter(r => r.condition === c).map(r => [r.task, !!r.correct]));
      const none = by('none'), patterns = by('patterns');
      return { m, none: [...none.values()].filter(Boolean).length, patterns: [...patterns.values()].filter(Boolean).length, total: patterns.size, ...paired(patterns, none) };
    });
    const adj = holm(res.map(r => r.p));
    res.forEach((r, i) => {
      out(`| ${r.m} | ${r.none} of ${r.total} | ${r.patterns} of ${r.total} | ${r.onlyA} / ${r.onlyB}; p ${pv(r.p)}, adj. ${pv(adj[i])}${adj[i] < 0.05 ? ' *' : ''} |`);
      retrieval[r.m] = { ...r, holm: adj[i] };
    });
  }

  // Baselines: the code and direct answers against the workflow system (rules first, majority).
  const base = present.map(m => ({ m, path: `${dir}/${prefix}-baseline-${m}.json` })).filter(x => existsSync(x.path));
  const baselines: Record<string, unknown> = {};
  if (base.length) {
    out('\nBaselines (one run) against the workflow system (rules first, majority): exact correct; McNemar workflow vs baseline.\n');
    out('| Model | Method | Baseline | Workflow | Right only with workflow / only with baseline; p, Holm-adjusted |');
    out('|---|---|---|---|---|');
    for (const method of ['code', 'direct']) {
      const res = base.map(({ m, path }) => {
        const results: (Record<string, Outcome> & { id: string; split: string })[] = json(path).results.filter((r: { split: string }) => r.split === split);
        const b = new Map(results.map(r => [r.id, !!r[method]?.correct]));
        const w = majority(runsOf(m), split, r => !!r.tools?.correct);
        return { m, baseline: [...b.values()].filter(Boolean).length, workflow: [...w.values()].filter(Boolean).length, total: b.size, ran: results.some(r => r[method]), ...paired(w, b) };
      }).filter(r => r.ran);
      const adj = holm(res.map(r => r.p));
      res.forEach((r, i) => {
        out(`| ${r.m} | ${method} | ${r.baseline} of ${r.total} | ${r.workflow} of ${r.total} | ${r.onlyA} / ${r.onlyB}; p ${pv(r.p)}, adj. ${pv(adj[i])}${adj[i] < 0.05 ? ' *' : ''} |`);
        baselines[`${r.m}:${method}`] = { ...r, holm: adj[i] };
      });
    }
  }
  report[split] = { models: perModel, tests, detection, time, retrieval, baselines };
}

console.log(lines.join('\n'));
const path = `${dir}/${prefix}-analysis.json`;
writeFileSync(path, JSON.stringify(report, null, 1));
writeFileSync(path.replace(/\.json$/, '.md'), lines.join('\n') + '\n');
console.log(`\nsaved ${path} and ${path.replace(/\.json$/, '.md')}`);
