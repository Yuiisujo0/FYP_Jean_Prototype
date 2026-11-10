// A run works out the answer and plans what it would change; nothing is written until the plan is carried out, which
// the app does only after the result is approved. Through the real engine on the real library logic over an in-memory
// store. Run with: node --test tests/actions.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carryOut, runFlow, type RunContext } from '../src/lib/engine.ts';
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
    fetchJson: async () => [],
  };
  const act = { saveTable: lib.saveResult.bind(lib) };
  await lib.upload(csv('stock.csv', 'item,stock\nBolts,3\nNuts,80\nWashers,2\n'), { name: 'stock' });
  return { lib, ctx, act };
}
const flow = (table: string, mode = 'replace') => [
  step('r', 'READ_CSV', { file: 'stock' }), step('f', 'FILTER', { condition: 'stock < 5' }),
  step('s', 'DATABASE', { table, mode }), step('o', 'OUTPUT', { format: 'table' }),
];
const names = async (lib: Awaited<ReturnType<typeof setup>>['lib']) => (await lib.list()).map(d => d.name);

test('a run writes nothing: it plans the save, and the step says it waits for approval', async () => {
  const { lib, ctx } = await setup();
  const result = await runFlow(flow('low_stock'), ctx, quiet);
  assert.deepEqual(await names(lib), ['stock'], 'nothing is saved by a run');
  assert.deepEqual(result.actions?.map(a => [a.kind, a.stepId, a.table, a.mode, a.columns, a.rows.length]), [['save', 's', 'low_stock', 'replace', ['item', 'stock'], 2]]);
  assert.equal(result.trace.find(t => t.stepId === 's')!.message, 'Will save 2 rows to “low_stock” when you approve the result (nothing is saved yet)');
  assert.equal(result.rows.length, 2, 'the answer is the same as before');
});

test('carrying out the plan writes it, in order, and says what each save did', async () => {
  const { lib, ctx, act } = await setup();
  const result = await runFlow(flow('low_stock', 'append'), ctx, quiet);
  assert.equal(result.trace.find(t => t.stepId === 's')!.message, 'Will add 2 rows to “low_stock” when you approve the result (nothing is saved yet)');
  assert.deepEqual(await carryOut(result.actions!, act), [{ stepId: 's', message: 'Created “low_stock” in the Data library with 2 rows' }]);
  assert.equal((await lib.get((await lib.list()).find(d => d.name === 'low_stock')!.id))!.rows.length, 2);
  // The same approved plan again (running an approved workflow again): append adds to it.
  assert.deepEqual(await carryOut(result.actions!, act), [{ stepId: 's', message: 'Added 2 rows to “low_stock”, which now has 4 rows' }]);
});

test('a save that would be refused is refused by the run, before anything is planned', async () => {
  const { ctx } = await setup();
  await assert.rejects(runFlow(flow('stock'), ctx, quiet), /dataset this workflow reads/);
});

test('a preview plans nothing, and a workflow without a save step plans nothing', async () => {
  const { ctx } = await setup();
  assert.equal((await runFlow(flow('low_stock'), ctx, quiet, { dryRun: true })).actions, undefined);
  assert.deepEqual((await runFlow([step('r', 'READ_CSV', { file: 'stock' }), step('o', 'OUTPUT', { format: 'table' })], ctx, quiet)).actions, []);
});

test('a preview says exactly what it said before actions were planned (the agent sees these words)', async () => {
  const { ctx } = await setup();
  const said: string[] = [];
  await runFlow(flow('low_stock'), ctx, (_id, _s, m) => said.push(m), { dryRun: true });
  assert.ok(said.includes('Would save 2 rows to “low_stock” (nothing is saved in a preview)'), said.join(' | '));
});
