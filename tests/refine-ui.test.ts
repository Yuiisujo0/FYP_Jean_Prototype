// How a refined workflow is applied to the one on the canvas. Part of: npm run test:engine
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeChanges, reconcile } from '../src/lib/refine.ts';
import type { Step } from '../src/types.ts';

let n = 0;
const step = (type: string, config: Record<string, string>, extra: Partial<Step> = {}): Step =>
  ({ id: `id${++n}`, type, name: type, description: '', config, position: { x: n * 10, y: 5 }, ...extra });

const read = () => step('READ_CSV', { file: 'marks', delimiter: ',' });
const filter = (c: string) => step('FILTER', { condition: c });
const out = () => step('OUTPUT', { format: 'table' });

test('steps the model left alone keep their id, position and any renaming', () => {
  const current = [read(), filter('score < 50'), out()];
  current[1].name = 'My own name for the filter';
  const proposed = current.map(s => ({ ...s, id: 'fresh-' + s.id, name: 'generated', position: { x: 0, y: 0 } }));
  const r = reconcile(current, proposed);
  assert.deepEqual(r.steps, current);
  assert.deepEqual(r.changes, []);
  assert.equal(r.reordered, false);
});

test('an edited step keeps its identity and takes the new settings', () => {
  const current = [read(), filter('score < 50'), out()];
  const proposed = [{ ...current[0] }, filter('score < 40'), { ...current[2] }];
  const r = reconcile(current, proposed);
  assert.equal(r.steps[1].id, current[1].id);
  assert.deepEqual(r.steps[1].position, current[1].position);
  assert.equal(r.steps[1].config.condition, 'score < 40');
  assert.deepEqual(r.changes.map(c => c.kind), ['changed']);
  assert.equal(describeChanges(r), 'Changed a step. It now says: Keeps only the rows where score is less than 40.');
});

test('an added step is new, and a removed one is reported with what it used to do', () => {
  const current = [read(), step('DATABASE', { table: 'low' }), out()];
  const withSelect = [current[0], step('TRANSFORM', { operation: 'select columns name, score' }), current[1], current[2]];
  const added = reconcile(current, withSelect);
  assert.deepEqual(added.changes.map(c => c.kind), ['added']);
  assert.match(describeChanges(added), /^Added a step\. Keeps only the columns name, score\.$/);

  const removed = reconcile(current, [current[0], current[2]]);
  assert.deepEqual(removed.changes.map(c => c.kind), ['removed']);
  assert.match(describeChanges(removed), /^Removed a step\. It used to say: Saves the rows into the table “low”/);
});

test('moving steps around is reported as a new order, not as edits', () => {
  const a = step('TRANSFORM', { operation: 'sort by score desc' });
  const b = step('TRANSFORM', { operation: 'limit 5' });
  const current = [read(), a, b, out()];
  const r = reconcile(current, [current[0], b, a, current[3]]);
  assert.deepEqual(r.changes, []);
  assert.equal(r.reordered, true);
  assert.equal(describeChanges(r), 'Changed the order of the steps.');
  assert.deepEqual(r.steps.map(s => s.id), [current[0].id, b.id, a.id, current[3].id]);
});

test('two steps of the same type are paired in order, so each edit lands on the right step', () => {
  const a = step('TRANSFORM', { operation: 'sort by score desc' });
  const b = step('TRANSFORM', { operation: 'limit 5' });
  const current = [read(), a, b, out()];
  const r = reconcile(current, [current[0], a, step('TRANSFORM', { operation: 'limit 3' }), current[3]]);
  assert.equal(r.steps[2].id, b.id);
  assert.equal(r.steps[2].config.operation, 'limit 3');
  assert.deepEqual(r.changes.map(c => c.kind), ['changed']);
});

test('a duplicate step is matched once each', () => {
  const f1 = filter('score < 50');
  const current = [read(), f1, out()];
  const r = reconcile(current, [current[0], { ...f1, id: 'x' }, { ...f1, id: 'y' }, current[2]]);
  assert.deepEqual(r.changes.map(c => c.kind), ['added']);
  assert.equal(r.steps[1].id, f1.id);
});
