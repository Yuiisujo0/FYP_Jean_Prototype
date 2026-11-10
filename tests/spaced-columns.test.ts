// Filters on column names with spaces and brackets, as company files have them (`Monthly Salary (RM)`, `Full Name`).
// Found 2026-11-10 with a mock HR export: the filter split the name into words and stopped with "no column Monthly".
// Run with: node --test tests/spaced-columns.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCondition, conditionColumns, conditionComparisons, describeCondition, runFlow, type RunContext } from '../src/lib/engine.ts';
import type { Step } from '../src/types.ts';

const columns = ['Staff ID', 'Full Name', 'Unit', 'Monthly Salary (RM)', 'Salary (RM)'];
const rows = [
  { 'Staff ID': 'S1', 'Full Name': 'Aisyah Tan', Unit: 'Sales & Marketing', 'Monthly Salary (RM)': '9000', 'Salary (RM)': '1' },
  { 'Staff ID': 'S2', 'Full Name': 'Ben Lim', Unit: 'Finance', 'Monthly Salary (RM)': '7000', 'Salary (RM)': '1' },
  { 'Staff ID': 'S3', 'Full Name': 'Chong Wei', Unit: 'Sales & Marketing', 'Monthly Salary (RM)': '6000', 'Salary (RM)': '1' },
  { 'Staff ID': 'S4', 'Full Name': 'Dina', Unit: 'Sales & Marketing', 'Monthly Salary (RM)': '', 'Salary (RM)': '1' },
];
const keep = (condition: string) => rows.filter(compileCondition(condition, columns)).map(r => r['Staff ID']);

test('a column name with spaces and brackets is read as one column', () => {
  assert.deepEqual(keep('Monthly Salary (RM) > 6000'), ['S1', 'S2']);
  assert.deepEqual(keep('monthly salary (rm) >= 6000'), ['S1', 'S2', 'S3']);
  assert.deepEqual(keep('Full Name == Ben Lim'), ['S2']);
});

test('with other conditions, multi-word values and brackets around it', () => {
  assert.deepEqual(keep('Unit == Sales & Marketing and Monthly Salary (RM) > 6000'), ['S1']);
  assert.deepEqual(keep('(Monthly Salary (RM) > 8000 or Unit == Finance)'), ['S1', 'S2']);
  assert.deepEqual(keep('Unit contains Sales and Full Name != Dina'), ['S1', 'S3']);
});

test('the longest name wins, and quoted text stays a value', () => {
  assert.deepEqual(keep('Salary (RM) > 5'), []);
  assert.deepEqual(keep('Full Name == "Monthly Salary (RM)"'), []);
});

test('backticks round a column name, as models write them, are accepted and not shown', () => {
  assert.deepEqual(keep('`Monthly Salary (RM)` > 6000'), ['S1', 'S2']);
  assert.deepEqual(keep('Unit == Sales & Marketing and `Monthly Salary (RM) ` > 6000'), ['S1']);
  assert.deepEqual(keep('`Unit` == Finance'), ['S2']);
  assert.equal(describeCondition('`Monthly Salary (RM) ` > 6000'), 'Monthly Salary (RM) is more than 6000');
});

test('the review and the checks see the column as written', () => {
  assert.deepEqual(conditionColumns('Monthly Salary (RM) > 6000', columns), [{ written: 'Monthly Salary (RM)', column: 'Monthly Salary (RM)' }]);
  assert.deepEqual(conditionComparisons('Monthly Salary (RM) > 6000', columns), [{ column: 'Monthly Salary (RM)', op: '>', literal: '6000' }]);
});

test('a run with a blank salary flags the row instead of stopping', async () => {
  const ctx: RunContext = {
    listDatasets: async () => [{ id: 1, name: 'HR_export_Q3', filename: 'HR_export_Q3.xlsx' }],
    loadDataset: async () => ({ columns, rows }),
  } as RunContext;
  const step = (id: string, type: string, config: Record<string, string>): Step => ({ id, type, name: type, description: '', config });
  const r = await runFlow([
    step('a', 'READ_CSV', { file: 'HR_export_Q3' }),
    step('b', 'FILTER', { condition: 'Unit == Sales & Marketing and Monthly Salary (RM) > 6000' }),
    step('c', 'TRANSFORM', { operation: 'sort by Monthly Salary (RM) desc' }),
    step('d', 'OUTPUT', {}),
  ], ctx, () => {});
  assert.deepEqual(r.rows.map(x => x['Staff ID']), ['S1']);
  assert.ok(r.exceptions.some(e => e.severity === 'critical'), 'the blank salary of S4 is something to decide');
});
