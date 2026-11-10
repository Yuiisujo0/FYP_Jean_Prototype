// Run with: npm run test:repair
// Replays real wrong workflows (what gemma3:4b actually wrote, from backend/eval/runs/new-gemma3-4b-fresh-s3.json) through
// findings → rule repair → run, and compares the result with the reference answer computed in Python.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkByRunning } from '../src/lib/agent.ts';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { groundingFindings } from '../src/lib/grounding.ts';
import { repairByRules, repairRunError } from '../src/lib/repair.ts';
import type { Step } from '../src/types.ts';

const data = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf-8')) as {
  datasets: Record<string, Table>; tasks: { id: string; request: string; expected?: Table }[];
};
const names = Object.keys(data.datasets);
const ctx: RunContext = {
  listDatasets: async () => names.map((n, id) => ({ id, name: n, filename: `${n}.csv`, origin: 'upload' as const })),
  loadDataset: async id => data.datasets[names[id]],
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
  const b = await replay('F7', [R('training_results'), ['FILTER', { condition: 'course == TR102 or course == SAFE201 and score between 60 and 80' }], OUT]);
  assert.equal(b.condition, '(course == TR102 or course == SAFE201) and score between 60 and 80');
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

test('lost not: == becomes !=, and an in-list becomes not in once', () => {
  const steps = mk([['READ_CSV', { file: 'inventory' }], ['FILTER', { condition: 'category in (Tools, Furniture) and stock < 5' }], ['OUTPUT', { format: 'table' }]], 'ln');
  const both = ['Tools', 'Furniture'].map(value => ({ kind: 'lost_not' as const, stepId: 'ln1', column: 'category', value, text: 'x' }));
  assert.equal(repairByRules('Items neither Tools nor Furniture with stock under 5', steps, both, { columns: ['category'] })?.steps[1].config.condition, 'category not in (Tools, Furniture) and stock < 5');
  const one = mk([['READ_CSV', { file: 'inventory' }], ['FILTER', { condition: 'supplier == Acme' }], ['OUTPUT', { format: 'table' }]], 'lo');
  assert.equal(repairByRules('Items not from Acme', one, [{ kind: 'lost_not' as const, stepId: 'lo1', column: 'supplier', value: 'Acme', text: 'x' }], { columns: ['supplier'] })?.steps[1].config.condition, 'supplier != Acme');
});

/* The wrong table. A plan that stops on a column its table does not have used to get no rule at all. */
const outlines = names.map(name => ({ name, columns: data.datasets[name].columns }));
const dryRun = async (steps: Step[]) => {
  try { return { result: await runFlow(steps, ctx, () => {}, { dryRun: true }) }; }
  catch (e) { return { error: (e as Error).message }; }
};
/** The whole agent loop with a model that never helps, so whatever gets fixed here was fixed by the rules alone. */
async function agentAlone(id: string, spec: Spec) {
  const task = data.tasks.find(t => t.id === id)!;
  const { steps, rounds } = await checkByRunning(mk(spec, id), {
    test: dryRun, request: task.request, datasets: outlines,
    revise: async () => ({ nodes: [], valid: true, unchanged: true, issues: [] }),
  });
  const out = await runFlow(steps, ctx, () => {}).catch(() => null);
  const right = !!out && JSON.stringify(out.columns) === JSON.stringify(task.expected!.columns) && JSON.stringify(out.rows) === JSON.stringify(task.expected!.rows);
  return { steps, rounds, right };
}

test('a plan that stops on a column only one other table has reads that table (G5, what qwen2.5 wrote)', async () => {
  const r = await agentAlone('G5', [R('suppliers'), ['TRANSFORM', { operation: 'group by supplier: count, min stock' }], OUT]);
  assert.equal(r.steps[0].config.file, 'inventory');
  assert.equal(r.rounds[0].outcome, 'repaired');
  assert.match(r.rounds[0].detail, /Read “inventory” instead of “suppliers”/);
  assert.ok(r.right);
});

test('a join is not added when the table being read is not needed at all (I5 and N1, what qwen2.5 wrote)', async () => {
  const i5 = await agentAlone('I5', [R('suppliers'), ['TRANSFORM', { operation: 'drop columns supplier' }], ['TRANSFORM', { operation: 'limit 10' }], OUT]);
  assert.equal(i5.steps[0].config.file, 'inventory');
  assert.ok(!i5.steps.some(s => /^join/.test(s.config.operation ?? '')));
  assert.ok(i5.right);
  const n1 = await agentAlone('N1', [R('suppliers'), ['FILTER', { condition: "supplier == 'Delta Trading'" }], OUT]);
  assert.equal(n1.steps[0].config.file, 'inventory');
  assert.ok(n1.right);
});

test('when both tables are needed the other one is joined, not swapped in (G7)', async () => {
  const r = await agentAlone('G7', [R('inventory'), ['TRANSFORM', { operation: 'select columns item, country' }], OUT]);
  assert.equal(r.steps[0].config.file, 'inventory');
  assert.equal(r.steps[1].config.operation, 'join suppliers on supplier');
  assert.ok(r.right);
});

test('one word of a column name keeps the table: "every trainee" still needs training_results (G6, what gemma3 wrote)', async () => {
  const r = await agentAlone('G6', [R('training_results'), ['LLM', { task: 'Add the course title to every trainee' }], OUT]);
  assert.equal(r.steps[0].config.file, 'training_results');
  assert.equal(r.steps[1].config.operation, 'join courses on course');
});

test('a plan with no read step gets the one table that has the column', () => {
  const steps = mk([['FILTER', { condition: 'stock < 5' }], OUT], 'nr');
  const fixed = repairRunError('Items with stock under 5', steps, 'There is no column “stock”. Available columns: none (no data has been read yet).', outlines);
  assert.deepEqual(fixed?.steps.map(s => s.type), ['READ_CSV', 'FILTER', 'OUTPUT']);
  assert.equal(fixed?.steps[0].config.file, 'inventory');
});

test('a file name with its extension still counts as that table', () => {
  const steps = mk([R('suppliers.csv'), ['FILTER', { condition: 'stock < 5' }], OUT], 'ext');
  const fixed = repairRunError('Items with stock under 5', steps, 'There is no column “stock”. Available columns: supplier, country, lead_days.', outlines);
  assert.equal(fixed?.steps[0].config.file, 'inventory');
});

test('the wrong-table rule stays out when it cannot be sure', () => {
  const steps = mk([R('suppliers'), ['FILTER', { condition: 'stock < 5' }], OUT], 'unsure');
  const error = 'There is no column “stock”. Available columns: supplier, country, lead_days.';
  const stockIn = (...tables: string[]) => tables.map(name => ({ name, columns: ['stock', 'supplier'] }));
  assert.equal(repairRunError('Items with stock under 5', steps, error, undefined), null, 'no list of tables');
  assert.equal(repairRunError('Items with stock under 5', steps, error, [...outlines.filter(d => d.name === 'suppliers'), ...stockIn('one', 'two')]), null, 'two tables have the column');
  assert.equal(repairRunError('Show the running low list', steps, error, outlines), null, 'the request never names the column');
  assert.equal(repairRunError('Items with stock under 5', steps, 'The condition “x” could not be read.', outlines), null, 'another kind of error');
  const two = mk([R('suppliers'), R('employees'), ['FILTER', { condition: 'stock < 5' }], OUT], 'two');
  assert.equal(repairRunError('Items with stock under 5', two, error, outlines), null, 'more than one read step');
  const typo = mk([R('inventory'), ['FILTER', { condition: 'country == Malaysia' }], OUT], 'own');
  assert.deepEqual(repairRunError('Show the country', typo, 'There is no column “country”. Available columns: sku.', [{ name: 'inventory', columns: ['sku'] }]), null, 'no other table has it');
});
