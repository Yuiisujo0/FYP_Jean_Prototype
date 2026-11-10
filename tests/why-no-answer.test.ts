// The plain-words reason a workflow cannot give an answer, shown before "Ready to run". Run with:
// node --test tests/why-no-answer.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { whyNoAnswer } from '../src/lib/whyNoAnswer.ts';
import type { Step } from '../src/types.ts';

const step = (id: string, type: string, config: Record<string, string> = {}): Step => ({ id, type, name: type, description: '', config });
const employees = { id: 1, name: 'employees', filename: 'employees.csv' };

test('the case from the live site: empty library, the AI wrote an explaining step instead of reading data', () => {
  const steps = [step('a', 'INPUT'), step('b', 'LLM', { task: 'Explain that employees is not available' }), step('c', 'OUTPUT')];
  const why = whyNoAnswer(steps, []);
  assert.equal(why?.kind, 'no_data');
  assert.match(why!.detail, /sample data/);
});

test('reads a table the library does not have', () => {
  const steps = [step('a', 'READ_CSV', { file: 'employees.csv' }), step('b', 'OUTPUT')];
  assert.equal(whyNoAnswer(steps, [])?.kind, 'no_data');
  const other = { id: 2, name: 'inventory', filename: 'inventory.csv' };
  const why = whyNoAnswer(steps, [other]);
  assert.equal(why?.kind, 'missing_dataset');
  assert.equal(why?.stepId, 'a');
  assert.match(why!.detail, /inventory/);
});

test('data exists but no step reads it', () => {
  assert.equal(whyNoAnswer([step('a', 'INPUT'), step('b', 'OUTPUT')], [employees])?.kind, 'no_source');
});

test('an LLM step is named, since it passes rows through unchanged', () => {
  const steps = [step('a', 'READ_CSV', { file: 'employees' }), step('b', 'LLM'), step('c', 'OUTPUT')];
  assert.equal(whyNoAnswer(steps, [employees])?.kind, 'llm_step');
});

test('a normal workflow, or a library still loading, gives no reason', () => {
  const steps = [step('a', 'READ_CSV', { file: 'employees.csv' }), step('b', 'FILTER'), step('c', 'OUTPUT')];
  assert.equal(whyNoAnswer(steps, [employees]), null);
  assert.equal(whyNoAnswer(steps, null), null);
  assert.equal(whyNoAnswer([step('a', 'HTTP_REQUEST', { url: 'https://x' }), step('b', 'OUTPUT')], []), null);
  assert.equal(whyNoAnswer([], []), null);
});
