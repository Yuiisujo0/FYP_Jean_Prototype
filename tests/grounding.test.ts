// Run with: npm run test:grounding
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundingFindings } from '../src/lib/grounding.ts';
import type { Step } from '../src/types.ts';

const rows = [
  { sku: 'SKU1', item: 'Lamp 1', category: 'Tools', stock: '8', supplier: 'Delta Trading', returned: 'no' },
  { sku: 'SKU2', item: 'Drill 2', category: 'Furniture', stock: '3', supplier: 'Acme', returned: 'yes' },
  { sku: 'SKU3', item: 'Desk 3', category: 'Electronics', stock: '40', supplier: 'Borneo Supply', returned: 'no' },
  { sku: 'SKU4', item: 'Cable 4', category: 'Stationery', stock: '0', supplier: 'Acme', returned: 'yes' },
];
const input = { columns: ['sku', 'item', 'category', 'stock', 'supplier', 'returned'], rows };
const s = (type: string, config: Record<string, string>, id = type): Step => ({ id, type, name: type, description: '', config });
const read = s('READ_CSV', { file: 'inventory' });
const out = s('OUTPUT', { format: 'table' });
const kinds = (request: string, ...mid: Step[]) => groundingFindings(request, [read, ...mid, out], input).map(f => f.kind);

test('a correct workflow raises nothing', () => {
  assert.deepEqual(kinds('Acme items with fewer than 5 in stock', s('FILTER', { condition: 'supplier == Acme and stock < 5' })), []);
  assert.deepEqual(kinds('Items from Delta Trading', s('FILTER', { condition: 'supplier == "Delta Trading"' })), []);
  assert.deepEqual(kinds('Items from Delta Trading', s('FILTER', { condition: 'supplier == Delta Trading' })), []);
  assert.deepEqual(kinds('The 2 items with the most stock', s('TRANSFORM', { operation: 'sort by stock desc' }), s('TRANSFORM', { operation: 'limit 2' })), []);
});

test('half of the request dropped: a value the request names that no filter uses', () => {
  const f = groundingFindings('Furniture items from Acme', [read, s('FILTER', { condition: 'supplier == Acme' }), out], input);
  assert.deepEqual(f.map(x => x.kind), ['unused_value']);
  assert.match(f[0].text, /Furniture/);
  assert.match(f[0].text, /category/);
});

test('a value compared with the wrong column', () => {
  const f = groundingFindings('Which Delta Trading items are low?', [read, s('FILTER', { condition: "category == 'Delta Trading' and stock < 15" }), out], input);
  assert.ok(f.some(x => x.kind === 'wrong_column' && /supplier/.test(x.text)));
});

test('a filter value the request never mentions', () => {
  assert.deepEqual(kinds('How many items are in each category?', s('FILTER', { condition: "category == 'London'" })), ['invented_value']);
  assert.deepEqual(kinds('Total stock per category', s('FILTER', { condition: 'supplier == Acme' })), ['invented_value']);
});

test('a yes / no column is allowed a value the request does not spell out', () => {
  assert.deepEqual(kinds('Items that have not been returned', s('FILTER', { condition: 'returned == no' })), []);
});

test('numbers are never flagged as invented', () => {
  assert.deepEqual(kinds('Items with some stock', s('FILTER', { condition: 'stock > 0' })), []);
});

test('a ranking asked for with nothing sorting the rows', () => {
  assert.deepEqual(kinds('The 3 items with the highest stock', s('TRANSFORM', { operation: 'limit 3' })), ['no_sort']);
});

test('and mixed with or without brackets, but not with brackets', () => {
  assert.deepEqual(kinds('Furniture or Tools items', s('FILTER', { condition: 'category == Furniture or category == Tools and stock > 1' })).includes('mixed_logic'), true);
  assert.equal(kinds('Furniture or Tools items', s('FILTER', { condition: '(category == Furniture or category == Tools) and stock > 1' })).includes('mixed_logic'), false);
});

test('without data nothing is compared, and the words are the user\'s own', () => {
  assert.deepEqual(groundingFindings('Acme items', [read, s('FILTER', { condition: 'supplier == Acme' }), out], undefined), []);
});

test('privacy: a finding never quotes a cell value the user did not type', () => {
  const request = 'Items from Acme, highest stock';
  const findings = groundingFindings(request, [read, s('FILTER', { condition: "category == 'Furniture' and supplier == Acme" }), out], input);
  const text = findings.map(f => f.text).join(' ').toLowerCase();
  const typed = request.toLowerCase();
  for (const r of rows) for (const v of Object.values(r)) {
    if (v.length >= 3 && Number.isNaN(Number(v)) && !typed.includes(v.toLowerCase())) {
      // The model's own wrong value (Furniture) may be quoted back; no other cell value may appear.
      if (v.toLowerCase() === 'furniture') continue;
      assert.ok(!text.includes(v.toLowerCase()), `finding leaked “${v}”: ${text}`);
    }
  }
});

test('"at least" is a limit, and a group step answers "the lowest per group"', () => {
  assert.deepEqual(kinds('Items with at least 5 in stock', s('FILTER', { condition: 'stock >= 5' })), []);
  assert.deepEqual(kinds('What is the lowest stock for each supplier?', s('TRANSFORM', { operation: 'group by supplier: min stock' })), []);
});

test('a word from the request that is no value of any column is reported, and marked as not safe to remove by rule', () => {
  const f = groundingFindings('Kuching staff in the inventory', [read, s('FILTER', { condition: "category == 'Staff'" }), out], input);
  assert.ok(f.some(x => x.kind === 'invented_value' && x.inRequest === true));
});

test('wrong dataset: a request about other data, with an empty result, names the uploaded dataset that fits', () => {
  const others = [{ name: 'employees', columns: ['name', 'department', 'salary'] }, { name: 'inventory', columns: ['sku', 'item'] }];
  const steps = [read, s('FILTER', { condition: 'category == Sales and stock > 6000' }), out];
  const f = groundingFindings('Show employees in Sales earning over 6000', steps, input, others, 0);
  assert.deepEqual(f.filter(x => x.kind === 'wrong_dataset').map(x => [x.dataset, x.other]), [['inventory', 'employees']]);
  // privacy: the finding holds the dataset names and the engine's words only
  assert.ok(!/SKU1|Lamp|Delta/.test(JSON.stringify(f)));
});

test('wrong dataset: with no other dataset that fits it is still said, but no dataset is named', () => {
  const f = groundingFindings('Show employees in Sales', [read, s('FILTER', { condition: 'category == Sales' }), out], input, [{ name: 'inventory', columns: ['sku'] }], 0);
  const w = f.find(x => x.kind === 'wrong_dataset');
  assert.ok(w && w.other === undefined && /may not be uploaded/.test(w.text));
});

test('wrong dataset: quiet when rows came back, when a word matches, or when the request says nothing', () => {
  const steps = [read, s('FILTER', { condition: 'supplier == Acme' }), out];
  assert.equal(groundingFindings('Show employees in Sales', steps, input, [], 3).some(x => x.kind === 'wrong_dataset'), false);
  assert.equal(groundingFindings('Show the items from Acme', steps, input, [], 0).some(x => x.kind === 'wrong_dataset'), false);
  assert.equal(groundingFindings('Show everything', [read, out], input, [], 0).some(x => x.kind === 'wrong_dataset'), false);
  assert.equal(groundingFindings('Items in stock', [read, out], input, [], 0).some(x => x.kind === 'wrong_dataset'), false);   // "items", "stock" are in the data
});
