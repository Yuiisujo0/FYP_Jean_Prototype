// Each step's trace keeps the first rows it passed on (and their source row numbers), for the Logs panel under the canvas.
// It is only for the screen: the AI is shown counts, never these rows (see observe.ts).
// Run with: node --test tests/step-sample.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFlow, STEP_SAMPLE_ROWS, type RunContext } from '../src/lib/engine.ts';
import { observeRun } from '../src/lib/observe.ts';
import type { Step } from '../src/types.ts';

const columns = ['item', 'stock'];
const rows = Array.from({ length: 60 }, (_, i) => ({ item: `I${i + 1}`, stock: i === 2 ? '' : String(i % 10) }));
const ctx = {
  listDatasets: async () => [{ id: 1, name: 'stock', filename: 'stock.csv' }],
  loadDataset: async () => ({ columns, rows }),
} as RunContext;
const step = (id: string, type: string, config: Record<string, string>): Step => ({ id, type, name: type, description: '', config });
const flow = [step('a', 'READ_CSV', { file: 'stock' }), step('b', 'FILTER', { condition: 'stock < 2' }), step('c', 'OUTPUT', {})];

test('every step keeps a sample of what it passed on, with source row numbers', async () => {
  const r = await runFlow(flow, ctx, () => {});
  const [read, filter, out] = r.trace;
  assert.equal(read.sample?.rows.length, STEP_SAMPLE_ROWS, 'capped');
  assert.equal(read.rowsOut, 60);
  assert.deepEqual(filter.sample?.rows.map(x => x.item), r.rows.map(x => x.item));
  assert.deepEqual(filter.sample?.source, r.lineage);
  assert.ok(filter.sample?.rows.every(x => Number(x.stock) < 2));
  assert.deepEqual(out.sample?.rows, filter.sample?.rows);
});

test('the sample never reaches what is sent to the AI', async () => {
  const r = await runFlow(flow, ctx, () => {});
  const text = observeRun(flow, { result: r }).text;
  assert.ok(!/I1\b|I11\b/.test(text), 'no cell values in the observation');
});
