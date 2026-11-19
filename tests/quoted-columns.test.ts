// A column name in double quotes, compared with a number, as models write it: `"Qty On Hand" < 5`.
// Found 2026-11-19 with a mock stock count: the quoted name was read as the text "Qty On Hand", so every one of 40 rows
// "could not be checked" and the answer was empty. Quoted text compared with a number can only mean the column.
// Run with: node --test tests/quoted-columns.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCondition, compileCondition, conditionComparisons, runFlow, type RunContext } from '../src/lib/engine.ts';
import type { Step } from '../src/types.ts';

const columns = ['Item Code', 'Item Description', 'Qty On Hand', 'Reorder Level'];
const rows = [
  { 'Item Code': 'CT-1003', 'Item Description': 'Black Toner', 'Qty On Hand': '1', 'Reorder Level': '10' },
  { 'Item Code': 'CT-1009', 'Item Description': 'Hand Sanitiser', 'Qty On Hand': '', 'Reorder Level': '10' },
  { 'Item Code': 'CT-1015', 'Item Description': 'Qty On Hand', 'Qty On Hand': '5', 'Reorder Level': '20' },
  { 'Item Code': 'CT-1018', 'Item Description': 'Wireless Mouse', 'Qty On Hand': '82', 'Reorder Level': '10' },
];
const keep = (condition: string) => rows.filter(compileCondition(condition, columns)).map(r => r['Item Code']);

test('a quoted column name compared with a number is the column', () => {
  assert.deepEqual(keep('"Qty On Hand" < 5'), ['CT-1003']);
  assert.deepEqual(keep("'Qty On Hand' <= 5"), ['CT-1003', 'CT-1015']);
  assert.deepEqual(keep('5 > "Qty On Hand"'), ['CT-1003']);
  assert.deepEqual(keep('"qty on hand" >= 82'), ['CT-1018']);
  assert.deepEqual(keep('"Qty On Hand" between 1 and 5'), ['CT-1003', 'CT-1015']);
  assert.deepEqual(keep('"Qty On Hand" < "Reorder Level"'), keep('Qty On Hand < Reorder Level'));   // two columns: as unquoted
});

test('the blank row is flagged, not every row', () => {
  const check = checkCondition('"Qty On Hand" < 5', columns);
  assert.deepEqual(rows.map(r => check(r).decided), [true, false, true, true]);
});

test('quoted text compared with text stays a value', () => {
  assert.deepEqual(keep('Item Description == "Qty On Hand"'), ['CT-1015']);
  assert.deepEqual(keep('"Qty On Hand" == Item Description'), ['CT-1015']);
});

test('the checks see the column, not a value', () => {
  assert.deepEqual(conditionComparisons('"Qty On Hand" < 5', columns), [{ column: 'Qty On Hand', op: '<', literal: '5' }]);
});

test('the stock run keeps the low item and flags the blank one', async () => {
  const ctx: RunContext = {
    listDatasets: async () => [{ id: 1, name: 'Stock_Count_Dec2026', filename: 'Stock_Count_Dec2026.xlsx' }],
    loadDataset: async () => ({ columns, rows }),
  } as RunContext;
  const step = (id: string, type: string, config: Record<string, string>): Step => ({ id, type, name: type, description: '', config });
  const r = await runFlow([
    step('a', 'READ_CSV', { file: 'Stock_Count_Dec2026' }),
    step('b', 'FILTER', { condition: '"Qty On Hand" < 5' }),
    step('c', 'OUTPUT', {}),
  ], ctx, () => {});
  assert.deepEqual(r.rows.map(x => x['Item Code']), ['CT-1003']);
  assert.ok(r.exceptions.some(e => e.severity === 'critical' && e.message.includes('1 row')), 'only CT-1009 is to decide');
});
