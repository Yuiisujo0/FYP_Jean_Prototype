// Run with: node --test tests/operations.test.ts   (group by / summarise, remove duplicates, join)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransform, runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { assumptionsFor, emptyDecisions, reviewGate } from '../src/lib/review.ts';
import type { Step } from '../src/types.ts';

const items: Table = {
  columns: ['Item', 'Category', 'Stock'],
  rows: [
    { Item: 'Amina', Category: 'Tools', Stock: '80' },
    { Item: 'Daniel', Category: 'tools ', Stock: '60' },
    { Item: 'Mei', Category: 'MA201', Stock: '' },
    { Item: 'Rahim', Category: 'MA201', Stock: 'n/a' },
    { Item: 'Siti', Category: 'PH300', Stock: '71.5' },
    { Item: 'Amina', Category: 'Tools', Stock: '80' },
  ],
};
const categories: Table = {
  columns: ['Category', 'Title', 'Stock'],
  rows: [
    { Category: 'Tools', Title: 'Programming', Stock: 'x' },
    { Category: 'MA201', Title: 'Calculus', Stock: 'y' },
    { Category: 'MA201', Title: 'Calculus II', Stock: 'z' },
  ],
};
const ctx = (): RunContext => ({
  listDatasets: async () => [{ id: 1, name: 'Items', filename: 'items.csv' }, { id: 2, name: 'Categories', filename: 'categories.csv' }],
  loadDataset: async id => (id === 1 ? items : categories),
  saveTable: async () => {},
  fetchJson: async () => [],
});
let n = 0;
const step = (type: Step['type'], config: Record<string, string>): Step => ({ id: `s${++n}`, type, name: `${type} ${n}`, config } as Step);
const read = () => step('READ_CSV', { file: 'items.csv' });
const run = (...ops: string[]) => runFlow([read(), ...ops.map(o => step('TRANSFORM', { operation: o })), step('OUTPUT', { format: 'table' })], ctx(), () => {});

test('the new operations are read', () => {
  assert.deepEqual(parseTransform('group by category: count, average stock'), { kind: 'group', by: 'category', aggregates: [{ fn: 'count' }, { fn: 'average', column: 'stock' }] });
  assert.deepEqual(parseTransform('summarise: sum stock'), { kind: 'group', by: null, aggregates: [{ fn: 'sum', column: 'stock' }] });
  assert.deepEqual(parseTransform('remove duplicates'), { kind: 'dedupe', by: [] });
  assert.deepEqual(parseTransform('remove duplicates by item, category'), { kind: 'dedupe', by: ['item', 'category'] });
  assert.deepEqual(parseTransform('join categories on category'), { kind: 'join', dataset: 'categories', left: 'category', right: 'category' });
  assert.equal(parseTransform('remove columns stock').kind, 'drop');
  assert.equal(parseTransform('group by category: average').kind, 'unknown');
});

test('group by: one row per group in first-seen order; capitals and spaces in the key are ignored', async () => {
  const r = await run('group by category: count, average stock, max stock');
  assert.deepEqual(r.columns, ['Category', 'count', 'average_Stock', 'max_Stock']);
  assert.deepEqual(r.rows.map(x => [x.Category, x.count, x.average_Stock, x.max_Stock]), [['Tools', '3', '73.33', '80'], ['MA201', '2', '', ''], ['PH300', '1', '71.5', '71.5']]);
  assert.deepEqual(r.lineage, [[1, 2, 6], [3, 4], [5]]);
  assert.equal(r.register!.balanced, true);
  assert.equal(r.register!.kept, 6);
});

test('group by: blank and text cells are left out of the average and reported, not counted as zero', async () => {
  const r = await run('group by category: average stock');
  const e = r.exceptions.find(x => x.kind === 'aggregate_skipped')!;
  assert.equal(e.severity, 'warning');
  assert.deepEqual(e.rows, [3, 4]);
  assert.match(e.message, /2 rows have a blank or non-numeric Stock/);
});

test('summarise gives one row', async () => {
  const r = await run('summarise: count, sum stock');
  assert.deepEqual(r.rows, [{ count: '6', sum_Stock: '291.5' }]);
  assert.deepEqual(r.lineage, [[1, 2, 3, 4, 5, 6]]);
});

test('remove duplicates keeps the first copy and records the others as left out', async () => {
  const r = await run('remove duplicates by item, category');
  assert.deepEqual(r.rows.map(x => x.Item), ['Amina', 'Daniel', 'Mei', 'Rahim', 'Siti']);
  assert.deepEqual(r.register!.rows[5], { row: 6, status: 'excluded', stepId: r.trace[1].stepId, reason: 'duplicate of row 1' });
  assert.equal(r.register!.balanced, true);
  assert.deepEqual(r.lineage, [[1], [2], [3], [4], [5]]);
});

test('join adds the other dataset columns; unmatched rows warn and several matches are critical', async () => {
  const r = await run('join categories on category');
  assert.deepEqual(r.columns, ['Item', 'Category', 'Stock', 'Title', 'Stock_categories']);
  assert.deepEqual(r.rows.map(x => x.Title), ['Programming', 'Programming', 'Calculus', 'Calculus', '', 'Programming']);
  assert.equal(r.rows.length, 6);
  assert.deepEqual(r.exceptions.find(x => x.kind === 'join_unmatched')!.rows, [5]);
  const multi = r.exceptions.find(x => x.kind === 'join_multiple')!;
  assert.equal(multi.severity, 'critical');
  assert.deepEqual(multi.rows, [3, 4]);
});

test('a joined dataset is protected from being overwritten by a later save', async () => {
  const flow = [read(), step('TRANSFORM', { operation: 'join categories on category' }), step('DATABASE', { table: 'categories' })];
  await assert.rejects(runFlow(flow, ctx(), () => {}), /dataset this workflow reads/);
});

test('a FILTER after a group accounts for every source row behind each group', async () => {
  const r = await runFlow([read(), step('TRANSFORM', { operation: 'group by category: count' }), step('FILTER', { condition: 'count > 1' })], ctx(), () => {});
  assert.deepEqual(r.rows.map(x => x.Category), ['Tools', 'MA201']);
  assert.equal(r.register!.kept, 5);
  assert.equal(r.register!.excluded, 1);
  assert.equal(r.register!.balanced, true);
});

test('a join that matches several rows blocks approval until it is accepted', async () => {
  const steps = [read(), step('TRANSFORM', { operation: 'join categories on category' })];
  const r = await runFlow(steps, ctx(), () => {});
  const assumptions = assumptionsFor(steps, r);
  assert.ok(assumptions.some(a => /first row of categories/.test(a.text)));
  const gate = reviewGate(r, assumptions, emptyDecisions(), false);
  assert.equal(gate.canApprove, false);
  assert.ok(gate.openCritical.some(x => x.kind === 'join_multiple'));
});

test('identical rows that both reach the result are warned about, and a remove-duplicates step silences the warning', async () => {
  const plain = await runFlow([read(), step('FILTER', { condition: 'stock > 50' })], ctx(), () => {});
  const warn = plain.exceptions.find(x => x.kind === 'duplicate_rows')!;
  assert.equal(warn.severity, 'warning');
  assert.deepEqual(warn.rows, [6]);
  const deduped = await run('remove duplicates');
  assert.ok(!deduped.exceptions.some(x => x.kind === 'duplicate_rows'));
});

test('comparing two columns reports a blank cell instead of quietly comparing it as text', async () => {
  const stock: Table = { columns: ['item', 'stock', 'reorder'], rows: [{ item: 'a', stock: '3', reorder: '10' }, { item: 'b', stock: '', reorder: '10' }, { item: 'c', stock: '30', reorder: '10' }] };
  const c: RunContext = { ...ctx(), listDatasets: async () => [{ id: 1, name: 'Stock', filename: 'stock.csv' }], loadDataset: async () => stock };
  const r = await runFlow([step('READ_CSV', { file: 'stock.csv' }), step('FILTER', { condition: 'stock < reorder' })], c, () => {});
  const e = r.exceptions.find(x => x.column === 'stock')!;
  assert.deepEqual(e.rows, [2]);
  assert.equal(r.register!.balanced, true);
});
