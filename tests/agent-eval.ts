// RQ2 (and RQ4): does running the workflow on the data and revising it help? For every task, ONE generation is scored
// three ways, so the conditions are paired on the same first draft:
//   one-shot  = the model's first draft as it came;
//   repair    = after the validator's repair loop (up to 2 repairs), what the app had before the agent existed;
//   agent     = after the bounded agent loop with the MODEL as its only repair tool (dry run → observe → ask the model, at most 2 revisions);
//   tools     = the same loop with the rule-based repairs tried first (src/lib/repair.ts) and the model only for what is left.
// With --samples K (K > 1) two more conditions are scored, from K candidates drawn at different temperatures:
//   consensus       = the candidate chosen by running them all and keeping the table most of them return (src/lib/consensus.ts);
//   consensusAgent  = the agent loop applied to that choice.
// Every workflow is executed on the task's data and compared with the reference answer computed in Python.
// It also records which signals fired, whether a revision fixed or broke a workflow, time, tokens and GPU memory.
//
// Usage:
//   node tests/agent-eval.ts --model gemma3:4b --splits dev,dev2 --name agent-gemma3-4b-dev
//   node tests/agent-eval.ts --provider cloudflare --model @cf/openai/gpt-oss-20b --splits dev,dev2 --name agent-gptoss-dev
// Holdout splits are refused unless --final is given: run them ONCE per configuration, after everything is frozen.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { checkByRunning, type AgentDeps } from '../src/lib/agent.ts';
import { pickByAgreement } from '../src/lib/consensus.ts';
import { PreviewStop, runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { orderSteps } from '../src/lib/flowGraph.ts';
import type { AiLike } from '../src/pipeline/ai.ts';
import { generateWorkflow } from '../src/pipeline/generate.ts';
import { reviseWorkflow } from '../src/pipeline/refine.ts';
import type { AgentRound, Step } from '../src/types.ts';

/* ---------------- arguments ---------------- */
const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const provider = arg('provider', 'ollama');
const model = arg('model', 'gemma3:4b');
const splits = arg('splits', 'dev,dev2').split(',');
const name = arg('name', `agent-${model.replace(/[^a-z0-9]+/gi, '-')}`);
const limit = Number(arg('limit', '0'));
const samples = Number(arg('samples', '1'));
const SAMPLE_TEMPERATURES = [0.1, 0.5, 0.8, 0.3, 0.65];
const final = process.argv.includes('--final');
if (splits.some(s => s.startsWith('holdout')) && !final) {
  throw new Error('Holdout splits are for the final, single run of a frozen configuration. Add --final if that is what this is.');
}

/* ---------------- tasks and data ---------------- */
interface Task {
  id: string; split: string; request: string; verified: boolean;
  steps: { type: string; config: Record<string, string> }[];
  expected?: { columns: string[]; rows: Record<string, string>[] };
}
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

/* ---------------- the model ---------------- */
interface CallLog { stage: string; ms: number; promptTokens: number; outputTokens: number; neurons: number; loadMs: number }
let stage = 'generate';
let calls: CallLog[] = [];

function ollama(): AiLike {
  const url = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  let thinkFlag = true;
  return {
    async run(m, inputs) {
      const i = inputs as { messages: unknown; response_format: { json_schema: unknown }; temperature: number };
      // The same request the Python backend sends (backend/app/llm.py chat_json).
      const payload: Record<string, unknown> = { model: m, messages: i.messages, stream: false, format: i.response_format.json_schema, keep_alive: '10m', options: { temperature: i.temperature, num_ctx: 2048 } };
      if (thinkFlag) payload.think = false;
      const t0 = Date.now();
      let res = await fetch(`${url}/api/chat`, { method: 'POST', body: JSON.stringify(payload) });
      if (res.status === 400 && thinkFlag && /think/i.test(await res.clone().text())) {
        thinkFlag = false;
        delete payload.think;
        res = await fetch(`${url}/api/chat`, { method: 'POST', body: JSON.stringify(payload) });
      }
      if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json() as { message: { content: string }; prompt_eval_count?: number; eval_count?: number; load_duration?: number };
      calls.push({ stage, ms: Date.now() - t0, promptTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0, neurons: 0, loadMs: Math.round((body.load_duration ?? 0) / 1e6) });
      return { response: body.message.content, usage: { prompt_tokens: body.prompt_eval_count ?? 0, completion_tokens: body.eval_count ?? 0 } };
    },
  };
}

/** Workers AI over REST, with the credentials in backend/.env (never printed). */
function cloudflare(): AiLike {
  const env: Record<string, string> = {};
  if (existsSync('backend/.env')) {
    for (const line of readFileSync('backend/.env', 'utf-8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const account = process.env.CF_ACCOUNT_ID ?? env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN ?? env.CF_API_TOKEN;
  if (!account || !token) throw new Error('Set CF_ACCOUNT_ID and CF_API_TOKEN in backend/.env to use --provider cloudflare.');
  return {
    async run(m, inputs) {
      const t0 = Date.now();
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${m}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(inputs),
      });
      const body = await res.json() as { success?: boolean; errors?: { message?: string }[]; result?: Record<string, any> };
      const detail = (body.errors ?? []).map(e => e.message ?? '').join('; ');
      if (/json mode/i.test(detail)) throw new Error(detail);
      if (!res.ok || !body.success) throw new Error(`Workers AI returned ${res.status}: ${detail}`.slice(0, 300));
      const usage = body.result?.usage ?? {};
      calls.push({ stage, ms: Date.now() - t0, promptTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, neurons: Number(usage.neurons ?? 0), loadMs: 0 });
      return body.result;
    },
  };
}
const ai = provider === 'cloudflare' ? cloudflare() : ollama();
const options = { ai, models: [model], datasets, maxRepairs: 2 };

/* ---------------- measuring ---------------- */
const toSteps = (steps: { type: string; config: Record<string, string> }[], tag: string): Step[] =>
  steps.map((s, i) => ({ id: `${tag}-${i}`, type: s.type, name: s.type, description: '', config: s.config }));

interface Score { ran: boolean; correct: boolean; rowsRight: boolean; rows?: number; error?: string }
async function score(steps: Step[] | null, task: Task): Promise<Score> {
  if (!steps) return { ran: false, correct: false, rowsRight: false, error: 'no workflow' };
  try {
    const out = await runFlow(steps, ctx, () => {});
    const exp = task.expected!;
    const correct = JSON.stringify(out.columns) === JSON.stringify(exp.columns) && JSON.stringify(out.rows) === JSON.stringify(exp.rows);
    const subset = out.columns.length > 0 && out.columns.every(c => exp.columns.includes(c));
    const rowsRight = correct || (subset && JSON.stringify(exp.rows.map(r => Object.fromEntries(out.columns.map(c => [c, r[c]])))) === JSON.stringify(out.rows));
    return { ran: true, correct, rowsRight, rows: out.rows.length };
  } catch (e) {
    return { ran: false, correct: false, rowsRight: false, error: (e instanceof Error ? e.message : String(e)).replace(/^“[^”]*” stopped the run\. /, '').slice(0, 140) };
  }
}

const dryRun = async (steps: Step[]) => {
  try { return { result: await runFlow(steps, ctx, () => {}, { dryRun: true }) }; }
  catch (e) {
    if (e instanceof PreviewStop) return { blocked: 'it fetches data from the web' };
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

/** GPU memory and how much of the model sits on the GPU, for RQ4. Best effort: missing tools give nulls. */
async function resources(): Promise<{ gpuMemUsedMb: number | null; gpuMemTotalMb: number | null; modelOnGpu: number | null }> {
  let gpuMemUsedMb: number | null = null, gpuMemTotalMb: number | null = null, modelOnGpu: number | null = null;
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf-8', timeout: 5000 });
    const [used, total] = out.trim().split(/\s*,\s*/).map(Number);
    gpuMemUsedMb = used; gpuMemTotalMb = total;
  } catch { /* no NVIDIA tools */ }
  if (provider === 'ollama') {
    try {
      const ps = await (await fetch('http://localhost:11434/api/ps')).json() as { models?: { name: string; size: number; size_vram: number }[] };
      const m = ps.models?.find(x => x.name === model);
      if (m?.size) modelOnGpu = Math.round((m.size_vram / m.size) * 100) / 100;
    } catch { /* not reachable */ }
  }
  return { gpuMemUsedMb, gpuMemTotalMb, modelOnGpu };
}

/* ---------------- the run ---------------- */
let currentTask: Task;
const revise: AgentDeps['revise'] = async (steps, observation) => {
  const r = await reviseWorkflow(currentTask.request, steps.map(s => ({ type: s.type, config: s.config })), observation.slice(0, 2000), options);
  return { nodes: r.nodes, valid: r.valid, unchanged: r.unchanged, issues: r.issues };
};
console.log(`provider=${provider} model=${model} splits=${splits.join(',')} tasks=${tasks.length}`);
if (provider === 'ollama') {
  stage = 'warm-up';
  await generateWorkflow('warm up the model', options).catch(() => {});
}

const rows: unknown[] = [];
for (const task of tasks) {
  currentTask = task;
  calls = [];
  const t0 = Date.now();
  let oneShotSteps: Step[] | null = null, repairSteps: Step[] | null = null, error = '';
  stage = 'generate';
  try {
    const g = await generateWorkflow(task.request, options);
    const first = g.attempts.find(a => a.flow)?.flow;
    oneShotSteps = first && g.attempts[0].flow ? orderSteps(first.nodes, first.edges) : null;   // the very first attempt only
    repairSteps = g.valid ? orderSteps(g.flow.nodes, g.flow.edges) : null;
    if (!g.valid) error = `invalid after repairs: ${g.issues.find(i => i.level === 'ERROR')?.message ?? ''}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const genMs = Date.now() - t0;

  let agentSteps = repairSteps, rounds: AgentRound[] = [], status = 'not run';
  const t1 = Date.now();
  if (repairSteps) {
    stage = 'revise';
    const r = await checkByRunning(repairSteps, {
      test: dryRun,
      revise,
      request: task.request, datasets,
      rules: false,
    });
    agentSteps = r.steps;
    rounds = r.rounds;
    status = r.status;
  }
  const agentMs = Date.now() - t1;

  // The same first draft, with rules first and the model second.
  let toolsSteps: Step[] | null = repairSteps, toolRounds: AgentRound[] = [];
  const t3 = Date.now();
  if (repairSteps) {
    stage = 'revise-tools';
    const tr = await checkByRunning(repairSteps, { test: dryRun, revise, request: task.request, datasets });
    toolsSteps = tr.steps;
    toolRounds = tr.rounds;
  }
  const toolsMs = Date.now() - t3;

  // Consensus: more candidates at other temperatures, then keep the one whose run most others agree with.
  let consensusSteps: Step[] | null = repairSteps, consensusAgentSteps: Step[] | null = agentSteps;
  let pick: { index: number; reason: string; verdicts: string[]; votes: number[] } | null = null, consensusMs = 0;
  if (samples > 1 && repairSteps) {
    const t2 = Date.now();
    stage = 'sample';
    const candidates: Step[][] = [repairSteps];
    for (let k = 1; k < samples; k++) {
      try {
        const g = await generateWorkflow(task.request, { ...options, firstTemperature: SAMPLE_TEMPERATURES[k] });
        if (g.valid) candidates.push(orderSteps(g.flow.nodes, g.flow.edges));
      } catch { /* a failed draw is simply one candidate fewer */ }
    }
    const p = await pickByAgreement(candidates, dryRun, task.request);
    consensusSteps = candidates[p.index];
    pick = { index: p.index, reason: p.reason, verdicts: p.judged.map(j => j.verdict), votes: p.judged.map(j => j.votes) };
    stage = 'revise';
    const cr = await checkByRunning(consensusSteps, { test: dryRun, revise, request: task.request, datasets });
    consensusAgentSteps = cr.steps;
    consensusMs = Date.now() - t2;
  }

  const oneShot = await score(oneShotSteps, task);
  const repair = await score(repairSteps, task);
  const agent = await score(agentSteps, task);
  const tools = await score(toolsSteps, task);
  const consensus = await score(consensusSteps, task);
  const consensusAgent = await score(consensusAgentSteps, task);
  const flagged = rounds.length > 0 && rounds[0].outcome !== 'clean' && rounds[0].outcome !== 'untestable';
  const row = {
    task: task.id, split: task.split, request: task.request, error,
    oneShot, repair, agent, tools, consensus, consensusAgent, pick, flagged, agentStatus: status,
    rounds: rounds.map(r => ({ outcome: r.outcome, signals: r.signals })),
    steps: {
      oneShot: oneShotSteps?.map(s => ({ type: s.type, config: s.config })) ?? null,
      repair: repairSteps?.map(s => ({ type: s.type, config: s.config })) ?? null,
      agent: agentSteps?.map(s => ({ type: s.type, config: s.config })) ?? null,
      tools: toolsSteps?.map(s => ({ type: s.type, config: s.config })) ?? null,
      consensus: consensusSteps?.map(s => ({ type: s.type, config: s.config })) ?? null,
      consensusAgent: consensusAgentSteps?.map(s => ({ type: s.type, config: s.config })) ?? null,
    },
    toolRounds: toolRounds.map(r => ({ outcome: r.outcome, signals: r.signals })),
    ms: { generate: genMs, agent: agentMs, tools: toolsMs, consensus: consensusMs },
    calls: { generate: calls.filter(c => c.stage === 'generate').length, sample: calls.filter(c => c.stage === 'sample').length, revise: calls.filter(c => c.stage === 'revise').length, reviseTools: calls.filter(c => c.stage === 'revise-tools').length },
    tokens: { prompt: calls.reduce((s, c) => s + c.promptTokens, 0), output: calls.reduce((s, c) => s + c.outputTokens, 0) },
    neurons: Math.round(calls.reduce((s, c) => s + c.neurons, 0) * 10) / 10,
    loadMs: calls.reduce((s, c) => s + c.loadMs, 0),
    resources: await resources(),
  };
  rows.push(row);
  const mark = (s: Score) => (s.correct ? 'OK ' : s.ran ? 'wr ' : '-- ');
  console.log(`${task.id.padEnd(4)} one-shot ${mark(oneShot)} repair ${mark(repair)} agent ${mark(agent)} tools ${mark(tools)} ${toolRounds.map(r => r.outcome).join('>')} |${samples > 1 ? ` consensus ${mark(consensus)} cons+agent ${mark(consensusAgent)} pick:${pick?.reason ?? '-'} ` : ' '}${flagged ? `flagged:${rounds[0].signals.join('+')}` : ''} ${rounds.map(r => r.outcome).join('>')} ${((genMs + agentMs) / 1000).toFixed(1)}s ${error.slice(0, 60)}`);
}

/* ---------------- summary ---------------- */
type Row = { oneShot: Score; repair: Score; agent: Score; tools: Score; consensus: Score; consensusAgent: Score; flagged: boolean; ms: { generate: number; agent: number }; calls: { revise: number }; tokens: { prompt: number; output: number }; neurons: number; resources: { gpuMemUsedMb: number | null; modelOnGpu: number | null } };
const R = rows as Row[];
const n = R.length;
const count = (f: (r: Row) => boolean) => R.filter(f).length;
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const wrongAfterRepair = R.filter(r => !r.repair.correct);
const rightAfterRepair = R.filter(r => r.repair.correct);
const summary = {
  correct: { oneShot: count(r => r.oneShot.correct), repair: count(r => r.repair.correct), agent: count(r => r.agent.correct), tools: count(r => r.tools.correct), consensus: count(r => r.consensus.correct), consensusAgent: count(r => r.consensusAgent.correct) },
  rowsRight: { oneShot: count(r => r.oneShot.rowsRight), repair: count(r => r.repair.rowsRight), agent: count(r => r.agent.rowsRight) },
  detected: wrongAfterRepair.filter(r => r.flagged).length, wrong: wrongAfterRepair.length,
  falseFlags: rightAfterRepair.filter(r => r.flagged).length, right: rightAfterRepair.length,
  fixed: count(r => !r.repair.correct && r.agent.correct), broken: count(r => r.repair.correct && !r.agent.correct),
  medianSeconds: { generate: median(R.map(r => r.ms.generate)) / 1000, agent: median(R.map(r => r.ms.agent)) / 1000, total: median(R.map(r => r.ms.generate + r.ms.agent)) / 1000 },
  meanReviseCalls: n ? Math.round((R.reduce((s, r) => s + r.calls.revise, 0) / n) * 100) / 100 : 0,
  meanTokens: n ? { prompt: Math.round(R.reduce((s, r) => s + r.tokens.prompt, 0) / n), output: Math.round(R.reduce((s, r) => s + r.tokens.output, 0) / n) } : null,
  neurons: Math.round(R.reduce((s, r) => s + r.neurons, 0)),
  maxGpuMemMb: Math.max(0, ...R.map(r => r.resources.gpuMemUsedMb ?? 0)),
  modelOnGpu: R.map(r => r.resources.modelOnGpu).find(v => v !== null) ?? null,
};
console.log(`\n${provider} ${model} on ${splits.join('+')}: ${n} tasks`);
console.log(`exact correct   one-shot ${pct(summary.correct.oneShot, n)}   repair ${pct(summary.correct.repair, n)}   agent ${pct(summary.correct.agent, n)}`);
if (samples > 1) console.log(`consensus of ${samples}: exact correct ${pct(summary.correct.consensus, n)}; with the agent on top ${pct(summary.correct.consensusAgent, n)}; fixed ${count(r => !r.repair.correct && r.consensus.correct)}, broke ${count(r => r.repair.correct && !r.consensus.correct)}`);
{
  const R2 = R as unknown as { ms: { generate: number; agent: number; tools: number }; calls: { revise: number; reviseTools: number }; repair: Score; tools: Score; agent: Score }[];
  const secs = (f: (r: typeof R2[number]) => number) => { const xs = R2.map(f).sort((a, b) => a - b); const at = (p: number) => xs[Math.min(xs.length - 1, Math.round(p * (xs.length - 1)))] / 1000; return `median ${at(0.5).toFixed(1)}s, mean ${(xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1) / 1000).toFixed(1)}s, p90 ${at(0.9).toFixed(1)}s`; };
  console.log(`agent, model only:  exact correct ${pct(summary.correct.agent, n)}; seconds per task ${secs(r => r.ms.generate + r.ms.agent)}; model revise calls per task ${(R2.reduce((a, r) => a + r.calls.revise, 0) / Math.max(n, 1)).toFixed(2)}`);
  console.log(`agent, rules first: exact correct ${pct(summary.correct.tools, n)}; seconds per task ${secs(r => r.ms.generate + r.ms.tools)}; model revise calls per task ${(R2.reduce((a, r) => a + r.calls.reviseTools, 0) / Math.max(n, 1)).toFixed(2)}; fixed ${R2.filter(r => !r.repair.correct && r.tools.correct).length}, broke ${R2.filter(r => r.repair.correct && !r.tools.correct).length}`);
}
console.log(`rows right      one-shot ${pct(summary.rowsRight.oneShot, n)}   repair ${pct(summary.rowsRight.repair, n)}   agent ${pct(summary.rowsRight.agent, n)}`);
console.log(`agent: flagged ${pct(summary.detected, summary.wrong)} of the wrong ones, ${pct(summary.falseFlags, summary.right)} of the right ones; fixed ${summary.fixed}, broke ${summary.broken}`);
console.log(`median seconds: generate ${summary.medianSeconds.generate}, agent ${summary.medianSeconds.agent}, total ${summary.medianSeconds.total}; revise calls per task ${summary.meanReviseCalls}; tokens per task ${JSON.stringify(summary.meanTokens)}${provider === 'cloudflare' ? `; neurons ${summary.neurons}` : `; GPU memory up to ${summary.maxGpuMemMb} MB, model on GPU ${summary.modelOnGpu}`}`);

const out = `backend/eval/runs/${name}.json`;
writeFileSync(out, JSON.stringify({ provider, model, splits, samples, date: new Date().toISOString(), summary, rows }, null, 1));
console.log(`saved ${out}`);
