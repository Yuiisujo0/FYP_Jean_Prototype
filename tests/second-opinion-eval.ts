// Does a second plan catch wrong answers, or does it only question right ones? For each task: write a plan and test it
// (rules first, as the app does), get the second opinion from --second-model (revisions stay with --model, as in the app), and compare with the reference answer, which the app never sees.
// Development tasks only: the holdouts are refused. A wrong answer counts as caught when the two plans disagree.
//
// Usage: node tests/second-opinion-eval.ts --model qwen2.5:7b --second-model gemma3:4b --splits dev,dev2,dev3,fresh [--limit 5]
// Without --second-model the same model writes both, at a warmer temperature. Writes backend/eval/runs/so-<model>[-by-<second>].json.
import { readFileSync, writeFileSync } from 'node:fs';
import { checkByRunning, type AgentDeps } from '../src/lib/agent.ts';
import { PreviewStop, runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { orderSteps } from '../src/lib/flowGraph.ts';
import { secondOpinion } from '../src/lib/secondOpinion.ts';
import type { AiLike } from '../src/pipeline/ai.ts';
import { generateWorkflow } from '../src/pipeline/generate.ts';
import { reviseWorkflow } from '../src/pipeline/refine.ts';
import type { Step } from '../src/types.ts';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const model = arg('model', 'qwen2.5:7b');
const second = arg('second-model');
const splits = arg('splits', 'dev,dev2,dev3,fresh').split(',');
const limit = Number(arg('limit', '0'));
if (splits.some(s => s.startsWith('holdout'))) throw new Error('The holdouts are for the final, single run of a frozen configuration.');

interface Task { id: string; split: string; request: string; verified: boolean; expected?: { columns: string[]; rows: Record<string, string>[] } }
const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as { datasets: Record<string, Table>; tasks: Task[] };
const names = Object.keys(data.datasets);
const ctx: RunContext = {
  listDatasets: async () => names.map((n, id) => ({ id, name: n, filename: `${n}.csv`, origin: 'upload' as const })),
  loadDataset: async id => data.datasets[names[id]],
  saveTable: async () => {},
  fetchJson: async () => { throw new Error('no network in the evaluation'); },
};
const datasets = names.map(n => ({ name: n, columns: data.datasets[n].columns }));
let tasks = data.tasks.filter(t => t.verified && splits.includes(t.split));
if (limit) tasks = tasks.slice(0, limit);

const ai: AiLike = {
  async run(m, inputs) {
    const i = inputs as { messages: unknown; response_format: { json_schema: unknown }; temperature: number };
    const res = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      body: JSON.stringify({ model: m, messages: i.messages, stream: false, format: i.response_format.json_schema, keep_alive: '10m', think: false, options: { temperature: i.temperature } }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const body = await res.json() as { message: { content: string } };
    return { response: body.message.content, usage: {} };
  },
};
const options = { ai, models: [model], datasets, maxRepairs: 2 };

const dryRun: AgentDeps['test'] = async steps => {
  try { return { result: await runFlow(steps, ctx, () => {}, { dryRun: true }) }; }
  catch (e) {
    if (e instanceof PreviewStop) return { blocked: 'it fetches data from the web' };
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
const draft = async (request: string, overrides: { firstTemperature?: number; models?: string[] } = {}): Promise<Step[] | null> => {
  const g = await generateWorkflow(request, { ...options, ...overrides });
  return g.valid ? orderSteps(g.flow.nodes, g.flow.edges) : null;
};
/** The rows are what a reader relies on, so extra columns do not make an answer wrong here. */
async function rowsRight(steps: Step[], task: Task): Promise<boolean> {
  try {
    const out = await runFlow(steps, ctx, () => {});
    const exp = task.expected!;
    if (!out.columns.length || !out.columns.every(c => exp.columns.includes(c))) return false;
    return JSON.stringify(exp.rows.map(r => Object.fromEntries(out.columns.map(c => [c, r[c]])))) === JSON.stringify(out.rows.map(r => Object.fromEntries(out.columns.map(c => [c, r[c]]))));
  } catch { return false; }
}

const rows: { task: string; right: boolean; outcome: string; seconds: number }[] = [];
for (const task of tasks) {
  const revise: AgentDeps['revise'] = async (steps, observation) => {
    const r = await reviseWorkflow(task.request, steps.map(s => ({ type: s.type, config: s.config })), observation.slice(0, 2000), options);
    return { nodes: r.nodes, valid: r.valid, unchanged: r.unchanged, issues: r.issues };
  };
  const tools = { test: dryRun, revise, request: task.request, datasets };
  try {
    const started = Date.now();
    const drafted = await draft(task.request);
    if (!drafted) { console.log(task.id.padEnd(5), 'no valid first plan'); continue; }
    const first = (await checkByRunning(drafted, tools)).steps;
    const secondStarted = Date.now();
    const o = await secondOpinion(first, {
      draft: () => draft(task.request, second ? { models: [second] } : { firstTemperature: 0.5 }),
      check: async steps => (await checkByRunning(steps, tools)).steps,
      test: dryRun,
    });
    const right = await rowsRight(first, task);
    rows.push({ task: task.id, right, outcome: o.outcome, seconds: (Date.now() - secondStarted) / 1000 });
    console.log(task.id.padEnd(5), right ? 'right' : 'WRONG', o.outcome.padEnd(15), `${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (e) {
    console.log(task.id.padEnd(5), 'failed', e instanceof Error ? e.message.slice(0, 90) : e);
  }
}

const count = (right: boolean, ...outcomes: string[]) => rows.filter(r => r.right === right && outcomes.includes(r.outcome)).length;
const wrong = rows.filter(r => !r.right).length;
const right = rows.length - wrong;
const compared = ['different', 'same_answer', 'similar_answer'];
const seconds = rows.map(r => r.seconds).sort((a, b) => a - b);
const summary = {
  model, second, splits, tasks: rows.length, wrong, right,
  caught: count(false, 'different'),
  falseAlarms: count(true, 'different'),
  falseComfort: count(false, 'same_answer', 'similar_answer'),
  samePlan: { wrong: count(false, 'same_plan'), right: count(true, 'same_plan') },
  notDone: { wrong: count(false, 'not_done'), right: count(true, 'not_done') },
  compared: { wrong: count(false, ...compared), right: count(true, ...compared) },
  medianExtraSeconds: seconds[Math.floor(seconds.length / 2)] ?? 0,
};
console.log(`\n${model}: ${rows.length} tasks, ${wrong} wrong, ${right} right`);
console.log(`wrong answers caught ${summary.caught} of ${wrong}; right answers questioned ${summary.falseAlarms} of ${right}`);
console.log(`wrong answers the second plan agreed with ${summary.falseComfort}; same plan twice ${summary.samePlan.wrong} wrong, ${summary.samePlan.right} right; not done ${summary.notDone.wrong} wrong, ${summary.notDone.right} right`);
console.log(`median extra wait ${summary.medianExtraSeconds} s`);
const file = `backend/eval/runs/so-${[model, second].filter(Boolean).join('-by-').replace(/[^a-z0-9]+/gi, '-')}.json`;
writeFileSync(file, JSON.stringify({ summary, rows }, null, 1));
console.log(`saved ${file}`);
