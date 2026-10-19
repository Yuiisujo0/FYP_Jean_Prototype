// The data library's logic (matching an upload to existing data; replace, add rows, new) over an in-memory store.
// These mirror backend/tests/test_datasets.py, so the browser library and the Python one behave the same.
// The IndexedDB store itself is exercised by the browser test (node tests/e2e-smoke.mjs).
// Run with: npm run test:library
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLibrary, memoryStore, type ParsedFile } from '../src/lib/library.ts';
import { parseUpload } from '../src/lib/tables.ts';

const sample = (name: string): ParsedFile => {
  const bytes = new Uint8Array(readFileSync(`sample_data/${name}`));
  return { ...parseUpload(name, name.endsWith('.csv') ? { text: new TextDecoder().decode(bytes) } : { bytes }), filename: name };
};
const csv = (filename: string, text: string): ParsedFile => ({ ...parseUpload(filename, { text }), filename });
const fresh = () => { let t = 1000; return createLibrary(memoryStore(), () => ++t); };

test('an Excel file is stored with blank cells, skipped blank rows and ISO dates', async () => {
  const lib = fresh();
  const d = await lib.upload(sample('student_marks.xlsx'), { name: 'marks' });
  assert.deepEqual(d.columns, ['student_id', 'name', 'course', 'score', 'attendance_pct', 'submitted']);
  assert.equal(d.rowCount, 40);
  assert.equal(d.rows[6].score, '');
  assert.match(d.rows[0].score, /^\d+$/);
  assert.equal(d.rows[0].submitted.length, 10);
});

test('inspect reports matches without saving', async () => {
  const lib = fresh();
  await lib.upload(sample('student_marks.xlsx'), { name: 'student_marks' });
  const info = await lib.inspect(sample('student_marks_next_semester.xlsx'));
  assert.equal(info.rowCount, 30);
  assert.equal(info.sheet, 'Marks');
  assert.equal(info.preview.length, 5);
  assert.equal(info.matches.length, 1);
  assert.deepEqual([info.matches[0].sameColumns, info.matches[0].sameName], [true, false]);
  assert.equal((await lib.list()).length, 1);                                   // nothing new was saved
  assert.deepEqual((await lib.inspect(sample('courses.xlsx'))).matches, []);   // unrelated data matches nothing
});

test('the same file name counts as the same name', async () => {
  const lib = fresh();
  await lib.upload(sample('student_marks.xlsx'), { name: 'student_marks' });
  const info = await lib.inspect(sample('student_marks.xlsx'));
  assert.equal(info.matches[0].sameName, true);
});

test('add rows works even when the headers are typed differently, and keeps the dataset’s own column names', async () => {
  const lib = fresh();
  const target = await lib.upload(sample('student_marks.xlsx'), { name: 'marks' });
  const merged = await lib.upload(sample('student_marks_other_headers.xlsx'), { mode: 'append', targetId: target.id });
  assert.equal(merged.rowCount, 48);
  assert.equal(merged.rows.length, 48);
  assert.deepEqual(merged.columns, target.columns);
  assert.match(merged.rows.at(-1)!.attendance_pct, /^\d+$/);
});

test('add rows refuses different columns, and a missing target', async () => {
  const lib = fresh();
  const target = await lib.upload(sample('student_marks.xlsx'), { name: 'marks' });
  await assert.rejects(lib.upload(sample('courses.xlsx'), { mode: 'append', targetId: target.id }), /columns do not match/);
  await assert.rejects(lib.upload(sample('courses.xlsx'), { mode: 'append', targetId: 999 }), /not found/);
});

test('new refuses an existing name; replace swaps the data and keeps the id', async () => {
  const lib = fresh();
  const first = await lib.upload(sample('student_marks.xlsx'), { name: 'marks' });
  await assert.rejects(lib.upload(sample('courses.xlsx'), { name: 'Marks', mode: 'new' }), /already exists/);
  const replaced = await lib.upload(sample('student_marks_next_semester.xlsx'), { name: 'marks', mode: 'replace' });
  assert.equal(replaced.id, first.id);
  assert.equal(replaced.rowCount, 30);
  assert.equal(replaced.createdAt, first.createdAt);
  assert.ok(replaced.updatedAt > first.updatedAt);
  assert.equal((await lib.list()).length, 1);
  await assert.rejects(lib.upload(sample('courses.xlsx'), { name: '   ' }), /Give the dataset a name/);
});

test('delete removes the dataset, and the list is newest-updated first', async () => {
  const lib = fresh();
  const a = await lib.upload(csv('a.csv', 'x\n1\n'), { name: 'a' });
  const b = await lib.upload(csv('b.csv', 'x\n1\n'), { name: 'b' });
  assert.deepEqual((await lib.list()).map(d => d.name), ['b', 'a']);
  await lib.upload(csv('a.csv', 'x\n2\n'), { name: 'a' });                     // touching a moves it to the top
  assert.deepEqual((await lib.list()).map(d => d.name), ['a', 'b']);
  assert.equal(await lib.remove(a.id), true);
  assert.equal(await lib.remove(a.id), false);
  assert.equal(await lib.get(a.id), undefined);
  assert.equal((await lib.get(b.id))!.name, 'b');
});

test('the list never carries rows, but get does', async () => {
  const lib = fresh();
  const d = await lib.upload(csv('a.csv', 'x\n1\n2\n'), { name: 'a' });
  assert.equal('rows' in (await lib.list())[0], false);
  assert.equal((await lib.get(d.id))!.rows.length, 2);
});

test('a workflow result is saved as a table, replacing earlier contents; an empty result is refused', async () => {
  const lib = fresh();
  const t1 = await lib.saveTable('low_scores', { columns: ['name'], rows: [{ name: 'a' }, { name: 'b' }] });
  const t2 = await lib.saveTable('low_scores', { columns: ['name'], rows: [{ name: 'c' }] });
  assert.equal(t2.id, t1.id);
  assert.deepEqual(t2.rows, [{ name: 'c' }]);
  assert.equal(t2.filename, 'low_scores.csv');
  assert.throws(() => lib.saveTable('x', { columns: [], rows: [] }), /no columns/);
});

test('stored data is a copy: changing what was returned does not change the library', async () => {
  const lib = fresh();
  const d = await lib.upload(csv('a.csv', 'x\n1\n'), { name: 'a' });
  d.rows[0].x = 'tampered';
  assert.equal((await lib.get(d.id))!.rows[0].x, '1');
});
