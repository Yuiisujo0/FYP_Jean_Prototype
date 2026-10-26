// Run with: npm run test:repair
// Replays real wrong workflows (what gemma3:4b actually wrote, from backend/eval/runs/new-gemma3-4b-fresh-s3.json) through
// findings → rule repair → run, and compares the result with the reference answer computed in Python.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkByRunning } from '../src/lib/agent.ts';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { groundingFindings } from '../src/lib/grounding.ts';
import { repairByRules } from '../src/lib/repair.ts';
import type { Step } from '../src/types.ts';

const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as {
  datasets: Record<string, Table>; tasks: { id: string; request: string; expected?: Table }[];
};
const names = Object.keys(data.datasets);
const ctx: RunContext = {
  listDatasets: async () => names.map((n, id) => ({ id, name: n, filename: `${n}.csv`, origin: 'upload' as const })),
  loadDataset: async id => data.datasets[names[id]],
  saveTable: async () => {},
  fetchJson: async () => { throw new Error('no network'); },
};
type Spec = [string, Record<string, string>][];
const mk = (spec: Spec, tag: string): Step[] => spec.map(([type, config], i) => ({ id: `${tag}${i}`, type, name: type, description: '', config }));
const R = (file: string): [string, Record<string, string>] => ['READ_CSV', { file, delimiter: ',' }];
const OUT: [string, Record<string, string>] = ['OUTPUT', { format: 'table' }];

/** The wrong workflow, repaired by rules, then run; returns the repaired steps and whether it matches the reference. */
async function replay(id: string, spec: Spec) {
  const task = data.tasks.find(t => t.id === id)!;
  const steps = mk(spec, id);
  const first = await runFlow(steps, ctx, () => {}, { dryRun: true });
  const findings = groundingFindings(task.request, steps, first.input);
  const fixed = repairByRules(task.request, steps, findings, first.input);
  assert.ok(fixed, `${id}: expected a repair for ${JSON.stringify(findings.map(f => f.kind))}`);
  const out = await runFlow(fixed.steps, ctx, () => {});
  const exact = JSON.stringify(out.columns) === JSON.stringify(task.expected!.columns) && JSON.stringify(out.rows) === JSON.stringify(task.expected!.rows);
  return { fixed, exact, condition: fixed.steps.find(s => s.type === 'FILTER')?.config.condition };
}

test('a value in the wrong column is compared with the right column (F2)', async () => {
  const r = await replay('F2', [R('inventory'), ['FILTER', { condition: "category == 'Delta Trading' and stock < 15" }], OUT]);
  assert.equal(r.condition, "supplier == 'Delta Trading' and stock < 15");
  assert.ok(r.exact);
});

test('a filter the request never asked for is removed (F13: city == London before a group)', async () => {
  const r = await replay('F13', [R('employees'), ['FILTER', { condition: "city == 'London'" }], ['TRANSFORM', { operation: 'group by city: count' }], OUT]);
  assert.ok(!r.fixed.steps.some(s => s.type === 'FILTER'));
  assert.ok(r.exact);
});

test('an invented comparison is removed from inside a longer condition (F25)', async () => {
  const r = await replay('F25', [R('employees'), ['FILTER', { condition: "department == 'Marketing' and city == 'Kuching' and salary between 3000 and 4500" }], OUT]);
  assert.equal(r.condition, "city == 'Kuching' and salary between 3000 and 4500");
  assert.ok(r.exact);
});

test('a dropped value is added back (F10: Monitor orders that were not cancelled)', async () => {
  const r = await replay('F10', [R('sales_orders'), ['FILTER', { condition: 'status != cancelled' }], OUT]);
  assert.equal(r.condition, 'status != cancelled and product == Monitor');
  assert.ok(r.exact);
});

test('a dropped value joins an or that is bracketed first (F16)', async () => {
  const r = await replay('F16', [R('inventory'), ['FILTER', { condition: 'category == Stationery or category == Tools' }], OUT]);
  assert.equal(r.condition, '(category == Stationery or category == Tools) and supplier == Acme');
  assert.ok(r.exact);
});

test('a dropped multi-word value is added quoted (F26)', async () => {
  const r = await replay('F26', [R('inventory'), ['FILTER', { condition: 'category != furniture' }], OUT]);
  assert.equal(r.condition, 'category != furniture and supplier == "Borneo Supply"');
  assert.ok(r.exact);
});

test('and / or without brackets: the or-terms on one column are bracketed (F5, F7)', async () => {
  const a = await replay('F5', [R('sales_orders'), ['FILTER', { condition: 'region == West or region == North and quantity > 10' }], OUT]);
  assert.equal(a.condition, '(region == West or region == North) and quantity > 10');
  assert.ok(a.exact);
  const b = await replay('F7', [R('student_marks'), ['FILTER', { condition: 'course == CS102 or course == MATH201 and score between 60 and 80' }], OUT]);
  assert.equal(b.condition, '(course == CS102 or course == MATH201) and score between 60 and 80');
  assert.ok(b.exact);
});

test('a ranking with no sort gets a sort on the column the request names, before the limit (F21, F3)', async () => {
  const a = await replay('F21', [R('inventory'), ['FILTER', { condition: 'stock > 0' }], ['TRANSFORM', { operation: 'limit 5' }], OUT]);
  assert.deepEqual(a.fixed.steps.filter(s => s.type === 'TRANSFORM').map(s => s.config.operation), ['sort by stock desc', 'limit 5']);
  assert.ok(a.exact);
  const b = await replay('F3', [R('sales_orders'), ['TRANSFORM', { operation: 'limit 3' }], OUT]);
  assert.deepEqual(b.fixed.steps.filter(s => s.type === 'TRANSFORM').map(s => s.config.operation), ['sort by unit_price', 'limit 3']);
  assert.ok(b.exact);
});

test('nothing is repaired when the workflow already does what the request says', async () => {
  const task = data.tasks.find(t => t.id === 'F2')!;
  const steps = mk([R('inventory'), ['FILTER', { condition: 'supplier == "Delta Trading" and stock < 15' }], OUT], 'ok');
  const first = await runFlow(steps, ctx, () => {}, { dryRun: true });
  assert.equal(repairByRules(task.request, steps, groundingFindings(task.request, steps, first.input), first.input), null);
});

test('the agent repairs by rules first, never asks the model for it, and records the round', async () => {
  const task = data.tasks.find(t => t.id === 'F10')!;
  let asked = 0;
  const result = await checkByRunning(mk([R('sales_orders'), ['FILTER', { condition: 'status != cancelled' }], OUT], 'ag'), {
    request: task.request,
    test: async steps => ({ result: await runFlow(steps, ctx, () => {}, { dryRun: true }) }),
    revise: async s => { asked++; return { nodes: s, valid: true, unchanged: true, issues: [] }; },
  });
  assert.equal(asked, 0);
  assert.deepEqual(result.rounds.map(r => r.outcome), ['repaired', 'clean']);
  assert.equal(result.status, 'clean');
  assert.match(result.rounds[0].detail, /Fixed without asking the AI/);
  assert.equal(result.rounds[0].sent, '');
});

test('with rules switched off the model is asked instead (so the evaluation can compare the two)', async () => {
  const task = data.tasks.find(t => t.id === 'F10')!;
  let asked = 0;
  await checkByRunning(mk([R('sales_orders'), ['FILTER', { condition: 'status != cancelled' }], OUT], 'ag'), {
    request: task.request, rules: false,
    test: async steps => ({ result: await runFlow(steps, ctx, () => {}, { dryRun: true }) }),
    revise: async s => { asked++; return { nodes: s, valid: true, unchanged: true, issues: [] }; },
  });
  assert.equal(asked, 1);
});

test('wrong dataset: reads the one uploaded dataset the request talks about', () => {
  const steps = mk([['READ_CSV', { file: 'inventory' }], ['FILTER', { condition: 'category == Sales' }], ['OUTPUT', { format: 'table' }]], 'wd');
  const findings = [{ kind: 'wrong_dataset' as const, dataset: 'inventory', other: 'employees', text: 'x' }];
  const fixed = repairByRules('Show employees in Sales', steps, findings, { columns: ['sku'] });
  assert.equal(fixed?.steps[0].config.file, 'employees');
  assert.match(fixed?.notes[0] ?? '', /employees/);
  // several candidates, or none: left to the model
  assert.equal(repairByRules('x', steps, [{ kind: 'wrong_dataset' as const, dataset: 'inventory', text: 'x' }], { columns: ['sku'] }), null);
});

test('missing join: joins the dataset that has the column, right after the read', () => {
  const steps = mk([['READ_CSV', { file: 'inventory' }], ['TRANSFORM', { operation: 'select columns item, supplier' }], ['OUTPUT', { format: 'table' }]], 'mj');
  const findings = [{ kind: 'missing_join' as const, dataset: 'suppliers', column: 'country', other: 'supplier', text: 'x' }];
  const fixed = repairByRules('Show each item with the country of its supplier', steps, findings, { columns: ['sku', 'item', 'supplier'] });
  assert.deepEqual(fixed?.steps.map(s => s.config.operation ?? s.type), ['READ_CSV', 'join suppliers on supplier', 'select columns item, supplier, country', 'OUTPUT']);
});
