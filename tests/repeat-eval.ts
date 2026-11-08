// Runs tests/agent-eval.ts several times with the same code and model, then reports each condition as mean, spread and
// range across the runs. One run is not enough: the same configuration varies by about ±4 of 60 tasks between runs.
// A run whose file already exists is not repeated, so an interrupted series picks up where it stopped.
//
// Usage (every argument other than --runs and --name goes to agent-eval unchanged):
//   node tests/repeat-eval.ts --runs 3 --name r-qwen25-7b --model qwen2.5:7b --splits dev,dev2,dev3,fresh
//   node tests/repeat-eval.ts --runs 3 --name r-gptoss --provider cloudflare --model @cf/openai/gpt-oss-20b --splits dev,dev2,dev3,fresh
//   node tests/repeat-eval.ts --summary r-qwen25-7b          (only summarise the runs already saved)
// Writes backend/eval/runs/<name>-r1.json ... -rN.json and <name>-summary.json.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const take = (flag: string) => {
  const i = argv.indexOf(`--${flag}`);
  if (i < 0) return '';
  const [, value] = argv.splice(i, 2);
  return value;
};
const summaryOnly = take('summary');
const name = summaryOnly || take('name');
const runs = Number(take('runs') || '3');
if (!name) throw new Error('Give --name (the run files become <name>-r1.json, ...) or --summary <name>.');
const file = (i: number) => `backend/eval/runs/${name}-r${i}.json`;

/** Tasks the AI service never answered (out of allowance, down). Those are not wrong answers, so the run says nothing about the model. */
const MAX_SERVICE_FAILURES = 2;
const serviceFailures = (run: { rows: { error?: string; oneShot: { ran: boolean } }[] }) =>
  run.rows.filter(r => r.error && !r.oneShot.ran && !/^invalid after repairs|did not return a usable workflow/.test(r.error));

if (!summaryOnly) {
  for (let i = 1; i <= runs; i++) {
    if (existsSync(file(i))) { console.log(`run ${i}: ${file(i)} exists, kept`); continue; }
    console.log(`\n=== run ${i} of ${runs} ===`);
    const r = spawnSync(process.execPath, ['tests/agent-eval.ts', ...argv, '--name', `${name}-r${i}`], { stdio: 'inherit' });
    if (r.status !== 0) { console.error(`run ${i} failed (exit ${r.status}); run the same command again to resume`); process.exit(1); }
    const failed = serviceFailures(JSON.parse(readFileSync(file(i), 'utf-8')));
    if (failed.length > MAX_SERVICE_FAILURES) {
      rmSync(file(i));
      console.error(`run ${i} removed: the AI service failed on ${failed.length} tasks (${failed[0].error?.slice(0, 90)}). Fix that and run the same command again.`);
      process.exit(1);
    }
  }
}

/* ---------------- summary across runs ---------------- */
interface Score { correct: boolean; rowsRight: boolean }
interface Row {
  task: string; oneShot: Score; repair: Score; agent: Score; tools: Score; flagged: boolean;
  ms: { generate: number; agent: number; tools: number }; neurons: number;
}
interface Run { model: string; provider: string; splits: string[]; date: string; rows: Row[] }

const loaded: Run[] = [];
for (let i = 1; existsSync(file(i)); i++) loaded.push(JSON.parse(readFileSync(file(i), 'utf-8')) as Run);
if (!loaded.length) throw new Error(`No run files found for ${name}.`);
if (loaded.some(r => serviceFailures(r).length > MAX_SERVICE_FAILURES)) throw new Error(`The AI service failed during a run of ${name}, so no summary was written.`);
const n = loaded[0].rows.length;
if (loaded.some(r => r.rows.length !== n)) throw new Error('The runs have different numbers of tasks, so they cannot be compared.');

const stats = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { values: xs, mean: Math.round(mean * 10) / 10, sd: Math.round(sd * 10) / 10, min: Math.min(...xs), max: Math.max(...xs) };
};
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const per = (f: (r: Row) => boolean) => stats(loaded.map(run => run.rows.filter(f).length));

const conditions = {
  oneShot: per(r => r.oneShot.correct),
  modelOnlyAgent: per(r => r.agent.correct),
  rulesFirstAgent: per(r => r.tools.correct),
};
const rowsRight = {
  oneShot: per(r => r.oneShot.rowsRight),
  modelOnlyAgent: per(r => r.agent.rowsRight),
  rulesFirstAgent: per(r => r.tools.rowsRight),
};
// How often the agent noticed a wrong first draft, and how often it raised a false alarm on a right one.
const detection = loaded.map(run => {
  const wrong = run.rows.filter(r => !r.repair.correct);
  const right = run.rows.filter(r => r.repair.correct);
  return { wrong: wrong.length, flagged: wrong.filter(r => r.flagged).length, right: right.length, falseAlarms: right.filter(r => r.flagged).length };
});
const seconds = {
  oneShotMedian: stats(loaded.map(run => median(run.rows.map(r => r.ms.generate)) / 1000)),
  rulesFirstMedian: stats(loaded.map(run => median(run.rows.map(r => r.ms.generate + r.ms.tools)) / 1000)),
};
// Tasks whose answer (rules-first agent) was right in some runs and wrong in others: where the variation comes from.
const unstable = loaded[0].rows.map(r => r.task).filter((_, i) => {
  const right = loaded.filter(run => run.rows[i].tools.correct).length;
  return right > 0 && right < loaded.length;
});

const summary = {
  name, model: loaded[0].model, provider: loaded[0].provider, splits: loaded[0].splits, tasks: n, runs: loaded.length,
  dates: loaded.map(r => r.date), conditions, rowsRight, detection, seconds, unstable,
  neurons: loaded.map(run => Math.round(run.rows.reduce((a, r) => a + (r.neurons ?? 0), 0))),
};
writeFileSync(`backend/eval/runs/${name}-summary.json`, JSON.stringify(summary, null, 1));

const show = (label: string, s: ReturnType<typeof stats>) =>
  console.log(`  ${label.padEnd(20)} ${String(s.mean).padStart(5)} of ${n} (${Math.round((100 * s.mean) / n)}%)  sd ${s.sd}  range ${s.min}-${s.max}  runs ${s.values.join(', ')}`);
console.log(`\n${summary.model} (${summary.provider}) on ${summary.splits.join('+')}: ${n} tasks, ${loaded.length} runs`);
console.log('exact correct');
show('one-shot', conditions.oneShot);
show('agent, model only', conditions.modelOnlyAgent);
show('agent, rules first', conditions.rulesFirstAgent);
console.log('right rows (extra columns allowed)');
show('one-shot', rowsRight.oneShot);
show('agent, rules first', rowsRight.rulesFirstAgent);
console.log(`flagged wrong drafts: ${detection.map(d => `${d.flagged}/${d.wrong}`).join(', ')}; false alarms on right drafts: ${detection.map(d => `${d.falseAlarms}/${d.right}`).join(', ')}`);
console.log(`median seconds per task: one-shot ${seconds.oneShotMedian.values.join(', ')}; rules-first agent ${seconds.rulesFirstMedian.values.join(', ')}`);
console.log(`tasks that changed between runs (rules first): ${unstable.length}${unstable.length ? ` (${unstable.join(', ')})` : ''}`);
console.log(`saved backend/eval/runs/${name}-summary.json`);
