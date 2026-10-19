// Runs every verified reference workflow in backend/eval/tasks.json through the real engine and compares the result
// with the answer computed independently in Python. Run with: npm run test:patterns
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import type { Step } from '../src/types.ts';

interface Task {
  id: string; split: string; request: string; verified: boolean;
  steps: { type: string; config: Record<string, string> }[];
  expected?: { columns: string[]; rows: Record<string, string>[] };
}
const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as { datasets: Record<string, Table>; tasks: Task[] };

export const toSteps = (t: Task): Step[] => t.steps.map((s, i) => ({ id: `${t.id}-${i}`, type: s.type, name: s.type, description: '', config: s.config }));
export const contextFor = (saved: Record<string, Table> = {}): RunContext => ({
  listDatasets: async () => Object.keys(data.datasets).map((name, id) => ({ id, name, filename: `${name}.csv` })),
  loadDataset: async id => data.datasets[Object.keys(data.datasets)[id]],
  saveTable: async (name, table) => { saved[name] = table; },
  fetchJson: async () => { throw new Error('no network in tests'); },
});

for (const task of data.tasks.filter(t => t.verified)) {
  test(`${task.id} (${task.split}): ${task.request}`, async () => {
    const result = await runFlow(toSteps(task), contextFor(), () => {});
    assert.deepEqual(result.columns, task.expected!.columns);
    assert.deepEqual(result.rows, task.expected!.rows);
  });
}
