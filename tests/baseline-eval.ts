// RQ1 baselines on the SAME model and the SAME tasks as the workflow system, so the comparison is about the method:
//   direct = the model is given the whole table and the question and writes the answer rows itself;
//   code   = the model writes a short Python function over the table, which is then run (standard library only).
// Both are scored exactly like workflows (same columns, same rows as the reference answer computed in Python).
// The workflow system's own numbers come from tests/agent-eval.ts on the same splits.
//
//   node tests/baseline-eval.ts --model gemma3:4b --splits dev,dev2,dev3 --name baseline-gemma3-4b-dev
// Holdout splits need --final (run once per frozen configuration).
//
// The code baseline is NOT a security sandbox: the generated code runs in a separate Python process with a time limit, in
// an empty temporary folder, with a minimal environment, on invented data only. Do not point it at real data.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Table } from '../src/lib/engine.ts';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const model = arg('model', 'gemma3:4b');
const splits = arg('splits', 'dev,dev2,dev3').split(',');
const name = arg('name', `baseline-${model.replace(/[^a-z0-9]+/gi, '-')}`);
const limit = Number(arg('limit', '0'));
const NUM_CTX = Number(arg('ctx', '8192'));
if (splits.some(s => s.startsWith('holdout')) && !process.argv.includes('--final')) {
  throw new Error('Holdout splits are for the final, single run of a frozen configuration. Add --final if that is what this is.');
}

interface Task { id: string; split: string; dataset: string; request: string; verified: boolean; expected?: { columns: string[]; rows: Record<string, string>[] } }
const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as { datasets: Record<string, Table>; tasks: Task[] };
let tasks = data.tasks.filter(t => t.verified && splits.includes(t.split));
if (limit) tasks = tasks.slice(0, limit);

const url = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
async function chat(system: string, user: string, json: boolean) {
  const t0 = Date.now();
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model, stream: false, think: false, keep_alive: '10m',
      ...(json ? { format: 'json' } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      options: { temperature: 0.1, num_ctx: NUM_CTX, num_predict: 3000 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const b = await res.json() as { message: { content: string }; prompt_eval_count?: number; eval_count?: number };
  return { text: b.message.content, ms: Date.now() - t0, promptTokens: b.prompt_eval_count ?? 0, outputTokens: b.eval_count ?? 0 };
}

const csv = (t: Table) => [t.columns.join(','), ...t.rows.map(r => t.columns.map(c => (/[",\n]/.test(r[c] ?? '') ? `"${(r[c] ?? '').replaceAll('"', '""')}"` : r[c] ?? '')).join(','))].join('\n');
const same = (a: { columns: string[]; rows: Record<string, string>[] }, e: { columns: string[]; rows: Record<string, string>[] }) =>
  JSON.stringify(a.columns) === JSON.stringify(e.columns) && JSON.stringify(a.rows) === JSON.stringify(e.rows);
const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const clean = (o: { columns?: unknown; rows?: unknown }) => {
  if (!Array.isArray(o.columns) || !Array.isArray(o.rows)) return null;
  const columns = o.columns.map(norm);
  return { columns, rows: (o.rows as Record<string, unknown>[]).map(r => Object.fromEntries(columns.map(c => [c, norm(r?.[c])]))) };
};

/* ---------------- direct answer ---------------- */
async function direct(t: Task) {
  const table = data.datasets[t.dataset];
  const system = 'You answer questions about a table. Reply with JSON only: {"columns": [column names of your answer], "rows": [one object per answer row, keyed by those column names]}. Keep the original column names and the original text of the values. Include every matching row.';
  const r = await chat(system, `Table (CSV):\n${csv(table)}\n\nQuestion: ${t.request}`, true);
  let parsed: ReturnType<typeof clean> = null;
  try { parsed = clean(JSON.parse(r.text)); } catch { /* unreadable */ }
  return { ...r, answer: parsed, error: parsed ? undefined : 'unreadable answer' };
}

/* ---------------- model-written code ---------------- */
const PY = process.platform === 'win32' ? 'backend/.venv/Scripts/python.exe' : 'backend/.venv/bin/python';
const RUNNER = `
import json, sys
rows = json.load(open("data.json"))
ns = {}
exec(open("solution.py").read(), ns)
cols, out = ns["solve"](rows)
print(json.dumps({"columns": list(cols), "rows": [{k: ("" if v is None else str(v)) for k, v in r.items()} for r in out]}))
`;
async function code(t: Task) {
  const table = data.datasets[t.dataset];
  const system = 'You write Python. Reply with one Python code block defining solve(rows) and nothing else. rows is a list of dicts; every value is a string (empty string when blank). solve returns (columns, result_rows): the column names of the answer, and a list of dicts keyed by those names. Use only the standard library. Keep the original column names and the original text of values; whole numbers print without ".0" and other numbers with at most 2 decimals.';
  const sample = table.rows.slice(0, 3).map(r => JSON.stringify(r)).join('\n');
  const r = await chat(system, `Columns: ${table.columns.join(', ')}\nFirst rows:\n${sample}\n\nTask: ${t.request}`, false);
  const m = /```(?:python)?\s*([\s\S]*?)```/i.exec(r.text);
  const source = (m ? m[1] : r.text).trim();
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  try {
    writeFileSync(join(dir, 'data.json'), JSON.stringify(table.rows));
    writeFileSync(join(dir, 'solution.py'), source);
    writeFileSync(join(dir, 'runner.py'), RUNNER);
    const run = spawnSync(join(process.cwd(), PY), ['-I', 'runner.py'], { cwd: dir, timeout: 10_000, encoding: 'utf-8', env: { SystemRoot: process.env.SystemRoot ?? '' } });
    if (run.status !== 0) return { ...r, answer: null, error: (run.error?.message ?? run.stderr ?? 'failed').trim().split('\n').pop()?.slice(0, 160) ?? 'failed' };
    const parsed = clean(JSON.parse(run.stdout));
    return { ...r, answer: parsed, error: parsed ? undefined : 'unreadable output' };
  } catch (e) {
    return { ...r, answer: null, error: e instanceof Error ? e.message.slice(0, 160) : 'failed' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- run ---------------- */
interface Row { id: string; split: string; direct: Result; code: Result }
interface Result { correct: boolean; ran: boolean; ms: number; promptTokens: number; outputTokens: number; error?: string }
const results: Row[] = [];
console.log(`model=${model} splits=${splits.join(',')} tasks=${tasks.length} num_ctx=${NUM_CTX}`);
for (const t of tasks) {
  const line: Row = { id: t.id, split: t.split } as Row;
  for (const [key, fn] of [['direct', direct], ['code', code]] as const) {
    let res: Result;
    try {
      const r = await fn(t);
      res = { ran: !!r.answer, correct: !!r.answer && same(r.answer, t.expected!), ms: r.ms, promptTokens: r.promptTokens, outputTokens: r.outputTokens, error: r.error };
    } catch (e) {
      res = { ran: false, correct: false, ms: 0, promptTokens: 0, outputTokens: 0, error: e instanceof Error ? e.message.slice(0, 160) : 'failed' };
    }
    line[key] = res;
  }
  results.push(line);
  console.log(`${t.id.padEnd(4)} direct ${line.direct.correct ? 'OK' : line.direct.ran ? 'wr' : '--'}  code ${line.code.correct ? 'OK' : line.code.ran ? 'wr' : '--'}  ${(line.direct.ms + line.code.ms) / 1000}s`);
}

const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const summary = (k: 'direct' | 'code') => `${k}: correct ${pct(results.filter(r => r[k].correct).length, results.length)}, answer produced ${pct(results.filter(r => r[k].ran).length, results.length)}, median ${med(results.map(r => r[k].ms)) / 1000}s, prompt tokens ${med(results.map(r => r[k].promptTokens))}`;
console.log(`\n${model} on ${splits.join('+')}: ${results.length} tasks\n${summary('direct')}\n${summary('code')}`);
writeFileSync(`backend/eval/runs/${name}.json`, JSON.stringify({ model, splits, numCtx: NUM_CTX, results }, null, 1));
console.log(`saved backend/eval/runs/${name}.json`);

