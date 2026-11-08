// Run with: node --test tests/second-opinion.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareAnswers, secondOpinion, secondOpinionException } from '../src/lib/secondOpinion.ts';
import { readSecondOpinion } from '../src/lib/secondOpinion.ts';
import { workflowKey } from '../src/lib/review.ts';
import type { RunResult, Step } from '../src/types.ts';

const step = (type: string, config: Record<string, string> = {}): Step => ({ id: `${type}-${Object.values(config).join()}`, type, name: type, description: '', config });
const plan = (condition: string): Step[] => [step('READ_CSV', { file: 'stock' }), step('FILTER', { condition }), step('OUTPUT', { format: 'table' })];
const table = (columns: string[], rows: Record<string, string>[]) => ({ columns, rows });
const a = { sku: 'A', stock: '3' };
const b = { sku: 'B', stock: '4' };
const c = { sku: 'C', stock: '9' };

test('compareAnswers: identical tables are the same', () => {
  assert.equal(compareAnswers(table(['sku', 'stock'], [a, b]), table(['sku', 'stock'], [a, b])), 'same');
});

test('compareAnswers: spaces and capitals in a value do not make a difference', () => {
  assert.equal(compareAnswers(table(['sku'], [{ sku: ' a ' }]), table(['sku'], [{ sku: 'A' }])), 'same');
});

test('compareAnswers: the same rows in another order or with other columns are similar, not different', () => {
  assert.equal(compareAnswers(table(['sku', 'stock'], [a, b]), table(['sku', 'stock'], [b, a])), 'similar');
  assert.equal(compareAnswers(table(['sku', 'stock'], [a, b]), table(['sku'], [{ sku: 'A' }, { sku: 'B' }])), 'similar');
});

test('compareAnswers: other rows, or nothing in common, are different', () => {
  assert.equal(compareAnswers(table(['sku', 'stock'], [a, b]), table(['sku', 'stock'], [a, c])), 'different');
  assert.equal(compareAnswers(table(['sku', 'stock'], [a, b]), table(['sku', 'stock'], [a])), 'different');
  assert.equal(compareAnswers(table(['sku'], [{ sku: 'A' }]), table(['count'], [{ count: '1' }])), 'different');
});

test('compareAnswers: a repeated row counts', () => {
  assert.equal(compareAnswers(table(['sku'], [{ sku: 'A' }, { sku: 'A' }]), table(['sku'], [{ sku: 'A' }])), 'different');
});

const answers: Record<string, RunResult> = {
  'stock < 5': table(['sku', 'stock'], [a, b]) as unknown as RunResult,
  'stock <= 4': table(['sku', 'stock'], [a, b]) as unknown as RunResult,
  'stock < 10': table(['sku', 'stock'], [a, b, c]) as unknown as RunResult,
};
const test_ = async (steps: Step[]) => {
  const condition = steps.find(s => s.type === 'FILTER')?.config.condition ?? '';
  if (condition === 'broken') return { error: 'There is no column “x”.' };
  if (condition === 'web') return { blocked: 'it fetches data from the web' };
  return { result: answers[condition] };
};
const opinion = (first: string, second: string | null | Error) => secondOpinion(plan(first), {
  draft: async () => { if (second instanceof Error) throw second; return second === null ? null : plan(second); },
  check: async s => s,
  test: test_,
});

test('the same plan twice says so, and does not claim a second opinion', async () => {
  const o = await opinion('stock < 5', 'stock < 5');
  assert.equal(o.outcome, 'same_plan');
  assert.equal(o.workflowKey, workflowKey(plan('stock < 5')));
});

test('a differently written plan with the same answer agrees', async () => {
  assert.equal((await opinion('stock < 5', 'stock <= 4')).outcome, 'same_answer');
});

test('a different answer gives the row counts and the second plan in words', async () => {
  const o = await opinion('stock < 5', 'stock < 10');
  assert.equal(o.outcome, 'different');
  assert.deepEqual(o.rows, { first: 2, second: 3 });
  assert.ok(o.secondPlan.length === 3);
  assert.match(o.secondPlan.join(' '), /stock is less than 10/);
});

test('a failure is reported as not done and never stops the workflow', async () => {
  for (const second of [new Error('quota'), null, 'broken', 'web']) assert.equal((await opinion('stock < 5', second)).outcome, 'not_done', String(second));
  assert.equal((await opinion('web', 'stock < 5')).outcome, 'not_done');
});

test('only a different answer becomes a critical exception, and only for the same workflow', async () => {
  const steps = plan('stock < 5');
  const different = await opinion('stock < 5', 'stock < 10');
  const e = secondOpinionException(different, steps)!;
  assert.equal(e.severity, 'critical');
  assert.equal(e.kind, 'second_opinion');
  assert.match(e.message, /2 rows/);
  assert.match(e.message, /3 rows/);
  assert.equal(secondOpinionException(different, plan('stock < 6')), null, 'a changed workflow no longer has this opinion');
  assert.equal(secondOpinionException(undefined, steps), null);
  for (const second of ['stock <= 4', 'stock < 5', null]) assert.equal(secondOpinionException(await opinion('stock < 5', second), steps), null);
});

test('a saved opinion is read back, and a damaged one is dropped', async () => {
  const o = await opinion('stock < 5', 'stock < 10');
  assert.deepEqual(readSecondOpinion(JSON.parse(JSON.stringify(o))), o);
  for (const bad of [null, 'x', {}, { outcome: 'different' }, { outcome: 'nonsense', workflowKey: 'k', detail: 'd', secondPlan: [] }]) assert.equal(readSecondOpinion(bad), undefined);
});
