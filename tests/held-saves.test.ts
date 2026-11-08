// A run writes nothing: a "save to table" step waits for the person's approval. Run through the real engine on the
// real library logic over an in-memory store. Run with: node --test tests/held-saves.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFlow, type RunContext } from '../src/lib/engine.ts';
import { applySaves, holdSaves, markHeld, withMessages } from '../src/lib/heldSaves.ts';
import { createLibrary, memoryStore, type ParsedFile } from '../src/lib/library.ts';
import { parseUpload } from '../src/lib/tables.ts';
import type { Step } from '../src/types.ts';

const csv = (filename: string, text: string): ParsedFile => ({ ...parseUpload(filename, { text }), filename });
const step = (id: string, type: string, config: Record<string, string>): Step => ({ id, type, name: type, description: '', config });
const quiet = () => {};

async function setup() {
  let t = 1000;
  const lib = createLibrary(memoryStore(), () => ++t);
  const ctx: RunContext = {
    listDatasets: () => lib.list(),
    loadDataset: async id => { const d = await lib.get(id); return { columns: d!.columns, rows: d!.rows }; },
    saveTable: (name, table, mode) => lib.saveResult(name, table, mode),
    fetchJson: async () => [],
  };
  await lib.upload(csv('stock.csv', 'item,stock\nBolts,3\nNuts,80\nWashers,2\n'), { name: 'stock' });
  return { lib, ctx };
}
const flow = (table: string, mode = 'replace') => [
  step('r', 'READ_CSV', { file: 'stock' }), step('f', 'FILTER', { condition: 'stock < 5' }),
  step('s', 'DATABASE', { table, mode }), step('o', 'OUTPUT', { format: 'table' }),
];
const names = async (lib: Awaited<ReturnType<typeof setup>>['lib']) => (await lib.list()).map(d => d.name);

test('a run writes nothing, and the step says it will save once the result is approved', async () => {
  const { lib, ctx } = await setup();
  const held = holdSaves(ctx);
  const out = await runFlow(flow('low_stock'), held.ctx, quiet);
  assert.deepEqual(await names(lib), ['stock'], 'nothing is saved by Run');
  const { result, saves } = markHeld(out, held.held);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].stepId, 's');
  assert.equal(result.trace.find(t => t.stepId === 's')!.message, 'Will save 2 rows to “low_stock” when you approve the result (nothing is saved yet)');
  assert.equal(result.rows.length, 2, 'the result on screen is the same as an unheld run');
});

test('approving writes the held saves in order and says what each did', async () => {
  const { lib, ctx } = await setup();
  const held = holdSaves(ctx);
  const { result, saves } = markHeld(await runFlow(flow('low_stock', 'append'), held.ctx, quiet), held.held);
  const done = await applySaves(ctx, saves);
  assert.deepEqual(done, [{ stepId: 's', message: 'Created “low_stock” in the Data library with 2 rows' }]);
  const saved = await lib.get((await lib.list()).find(d => d.name === 'low_stock')!.id);
  assert.equal(saved!.rows.length, 2);
  assert.equal(withMessages(result, done).trace.find(t => t.stepId === 's')!.message, done[0].message);
  // Approved again (the same result): append adds to it, as a run did before.
  assert.deepEqual(await applySaves(ctx, saves), [{ stepId: 's', message: 'Added 2 rows to “low_stock”, which now has 4 rows' }]);
});

test('a save that would be refused is still refused at Run, before any approval', async () => {
  const { ctx } = await setup();
  const held = holdSaves(ctx);
  await assert.rejects(runFlow(flow('stock'), held.ctx, quiet), /dataset this workflow reads/);
  assert.equal(held.held.length, 0);
});

test('a workflow without a save step holds nothing', async () => {
  const { ctx } = await setup();
  const held = holdSaves(ctx);
  const out = await runFlow([step('r', 'READ_CSV', { file: 'stock' }), step('o', 'OUTPUT', { format: 'table' })], held.ctx, quiet);
  const { result, saves } = markHeld(out, held.held);
  assert.deepEqual(saves, []);
  assert.deepEqual(result.trace, out.trace);
});
