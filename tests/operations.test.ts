// Run with: node --test tests/operations.test.ts   (group by / summarise, remove duplicates, join)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransform, runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { assumptionsFor, emptyDecisions, reviewGate } from '../src/lib/review.ts';
import type { Step } from '../src/types.ts';

const students: Table = {
  columns: ['Student', 'Course', 'Score'],
  rows: [
    { Student: 'Amina', Course: 'CS101', Score: '80' },
    { Student: 'Daniel', Course: 'cs101 ', Score: '60' },
    { Student: 'Mei', Course: 'MA201', Score: '' },
    { Student: 'Rahim', Course: 'MA201', Score: 'n/a' },
    { Student: 'Siti', Course: 'PH300', Score: '71.5' },
    { Student: 'Amina', Course: 'CS101', Score: '80' },
  ],
};
const courses: Table = {
  columns: ['Course', 'Title', 'Score'],
  rows: [
    { Course: 'CS101', Title: 'Programming', Score: 'x' },
    { Course: 'MA201', Title: 'Calculus', Score: 'y' },
    { Course: 'MA201', Title: 'Calculus II', Score: 'z' },
  ],
};
const ctx = (): RunContext => ({
  listDatasets: async () => [{ id: 1, name: 'Students', filename: 'students.csv' }, { id: 2, name: 'Courses', filename: 'courses.csv' }],
  loadDataset: async id => (id === 1 ? students : courses),
  saveTable: async () => {},
  fetchJson: async () => [],
});
let n = 0;
const step = (type: Step['type'], config: Record<string, string>): Step => ({ id: `s${++n}`, type, name: `${type} ${n}`, config } as Step);
const read = () => step('READ_CSV', { file: 'students.csv' });
const run = (...ops: string[]) => runFlow([read(), ...ops.map(o => step('TRANSFORM', { operation: o })), step('OUTPUT', { format: 'table' })], ctx(), () => {});

test('the new operations are read', () => {
  assert.deepEqual(parseTransform('group by course: count, average score'), { kind: 'group', by: 'course', aggregates: [{ fn: 'count' }, { fn: 'average', column: 'score' }] });
  assert.deepEqual(parseTransform('summarise: sum score'), { kind: 'group', by: null, aggregates: [{ fn: 'sum', column: 'score' }] });
  assert.deepEqual(parseTransform('remove duplicates'), { kind: 'dedupe', by: [] });
  assert.deepEqual(parseTransform('remove duplicates by student, course'), { kind: 'dedupe', by: ['student', 'course'] });
  assert.deepEqual(parseTransform('join courses on course'), { kind: 'join', dataset: 'courses', left: 'course', right: 'course' });
  assert.equal(parseTransform('remove columns score').kind, 'drop');
  assert.equal(parseTransform('group by course: average').kind, 'unknown');
});

test('group by: one row per group in first-seen order; capitals and spaces in the key are ignored', async () => {
  const r = await run('group by course: count, average score, max score');
  assert.deepEqual(r.columns, ['Course', 'count', 'average_Score', 'max_Score']);
  assert.deepEqual(r.rows.map(x => [x.Course, x.count, x.average_Score, x.max_Score]), [['CS101', '3', '73.33', '80'], ['MA201', '2', '', ''], ['PH300', '1', '71.5', '71.5']]);
  assert.deepEqual(r.lineage, [[1, 2, 6], [3, 4], [5]]);
  assert.equal(r.register!.balanced, true);
  assert.equal(r.register!.kept, 6);
});

test('group by: blank and text cells are left out of the average and reported, not counted as zero', async () => {
  const r = await run('group by course: average score');
  const e = r.exceptions.find(x => x.kind === 'aggregate_skipped')!;
  assert.equal(e.severity, 'warning');
  assert.deepEqual(e.rows, [3, 4]);
  assert.match(e.message, /2 rows have a blank or non-numeric Score/);
});

test('summarise gives one row', async () => {
  const r = await run('summarise: count, sum score');
  assert.deepEqual(r.rows, [{ count: '6', sum_Score: '291.5' }]);
  assert.deepEqual(r.lineage, [[1, 2, 3, 4, 5, 6]]);
});

test('remove duplicates keeps the first copy and records the others as left out', async () => {
  const r = await run('remove duplicates by student, course');
  assert.deepEqual(r.rows.map(x => x.Student), ['Amina', 'Daniel', 'Mei', 'Rahim', 'Siti']);
  assert.deepEqual(r.register!.rows[5], { row: 6, status: 'excluded', stepId: r.trace[1].stepId, reason: 'duplicate of row 1' });
  assert.equal(r.register!.balanced, true);
  assert.deepEqual(r.lineage, [[1], [2], [3], [4], [5]]);
});

test('join adds the other dataset columns; unmatched rows warn and several matches are critical', async () => {
  const r = await run('join courses on course');
  assert.deepEqual(r.columns, ['Student', 'Course', 'Score', 'Title', 'Score_courses']);
  assert.deepEqual(r.rows.map(x => x.Title), ['Programming', 'Programming', 'Calculus', 'Calculus', '', 'Programming']);
  assert.equal(r.rows.length, 6);
  assert.deepEqual(r.exceptions.find(x => x.kind === 'join_unmatched')!.rows, [5]);
  const multi = r.exceptions.find(x => x.kind === 'join_multiple')!;
  assert.equal(multi.severity, 'critical');
  assert.deepEqual(multi.rows, [3, 4]);
});

test('a joined dataset is protected from being overwritten by a later save', async () => {
  const flow = [read(), step('TRANSFORM', { operation: 'join courses on course' }), step('DATABASE', { table: 'courses' })];
  await assert.rejects(runFlow(flow, ctx(), () => {}), /dataset this workflow reads/);
});

test('a FILTER after a group accounts for every source row behind each group', async () => {
  const r = await runFlow([read(), step('TRANSFORM', { operation: 'group by course: count' }), step('FILTER', { condition: 'count > 1' })], ctx(), () => {});
  assert.deepEqual(r.rows.map(x => x.Course), ['CS101', 'MA201']);
  assert.equal(r.register!.kept, 5);
  assert.equal(r.register!.excluded, 1);
  assert.equal(r.register!.balanced, true);
});

test('a join that matches several rows blocks approval until it is accepted', async () => {
  const steps = [read(), step('TRANSFORM', { operation: 'join courses on course' })];
  const r = await runFlow(steps, ctx(), () => {});
  const assumptions = assumptionsFor(steps, r);
  assert.ok(assumptions.some(a => /first row of courses/.test(a.text)));
  const gate = reviewGate(r, assumptions, emptyDecisions(), false);
  assert.equal(gate.canApprove, false);
  assert.ok(gate.openCritical.some(x => x.kind === 'join_multiple'));
});

test('identical rows that both reach the result are warned about, and a remove-duplicates step silences the warning', async () => {
  const plain = await runFlow([read(), step('FILTER', { condition: 'score > 50' })], ctx(), () => {});
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
