// The workspace backup file: datasets are included, damaged parts are reported, and a version 1 file never touches the library.
// Run with: npm run test:backup
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKUP_VERSION, buildBackup, parseBackup, restoreMessage } from '../src/lib/backup.ts';
import { createLibrary, memoryStore, type ParsedFile } from '../src/lib/library.ts';
import { parseUpload } from '../src/lib/tables.ts';
import type { Flow } from '../src/types.ts';

const csv = (filename: string, text: string): ParsedFile => ({ ...parseUpload(filename, { text }), filename });
const fresh = () => { let t = 1000; return createLibrary(memoryStore(), () => ++t); };
const flow: Flow = { id: 'f1', name: 'W', description: '', updatedAt: 1, nodes: [], edges: [] };
const roundTrip = (b: unknown) => JSON.parse(JSON.stringify(b));   // what a downloaded file goes through

test('a backup carries every dataset with its rows, without browser-local ids', async () => {
  const lib = fresh();
  await lib.upload(csv('marks.csv', 'name,score\nAda,90\nBen,\n'), { name: 'marks' });
  await lib.upload(csv('courses.csv', 'code\nCS1\n'), { name: 'courses' });
  const b = buildBackup({ profile: { name: 'J' }, flows: [flow], knowledge: [], datasets: await lib.exportAll() });
  assert.equal(b.version, BACKUP_VERSION);
  assert.equal(b.datasets.length, 2);
  assert.deepEqual(Object.keys(b.datasets[0]).sort(), ['columns', 'filename', 'name', 'origin', 'rows']);   // no id or timestamps
  assert.deepEqual(b.datasets.find(d => d.name === 'marks')!.rows, [{ name: 'Ada', score: '90' }, { name: 'Ben', score: '' }]);
});

test('restoring into an empty library brings the datasets back exactly', async () => {
  const source = fresh();
  await source.upload(csv('marks.csv', 'name,score\nAda,90\nBen,\n'), { name: 'marks' });
  const file = roundTrip(buildBackup({ profile: null, flows: [flow], knowledge: [], datasets: await source.exportAll() }));

  const parsed = parseBackup(file);
  const target = fresh();
  assert.equal(await target.importAll(parsed.datasets!), 1);
  const [only] = await target.list();
  const restored = (await target.get(only.id))!;
  assert.equal(restored.name, 'marks');
  assert.deepEqual(restored.columns, ['name', 'score']);
  assert.deepEqual(restored.rows, [{ name: 'Ada', score: '90' }, { name: 'Ben', score: '' }]);
});

test('restoring replaces a dataset of the same name (keeping its id) and leaves the others alone', async () => {
  const lib = fresh();
  const marks = await lib.upload(csv('marks.csv', 'name,score\nOld,1\n'), { name: 'marks' });
  const other = await lib.upload(csv('other.csv', 'x\n1\n'), { name: 'other' });
  const file = roundTrip(buildBackup({ profile: null, flows: [], knowledge: [], datasets: [{ id: 9, name: 'marks', filename: 'marks.csv', columns: ['name', 'score'], rows: [{ name: 'New', score: '2' }], rowCount: 1, createdAt: 0, updatedAt: 0 }] }));
  await lib.importAll(parseBackup(file).datasets!);

  const names = (await lib.list()).map(d => d.name).sort();
  assert.deepEqual(names, ['marks', 'other']);
  assert.equal((await lib.get(marks.id))!.rows[0].name, 'New');   // same id, new contents, so workflows keep working
  assert.equal((await lib.get(other.id))!.rows[0].x, '1');
});

test('a version 1 backup (no datasets) leaves the library untouched and says so', () => {
  const parsed = parseBackup({ format: 'jwork.workspace', version: 1, flows: [flow], knowledge: [] });
  assert.equal(parsed.datasets, null);
  assert.match(restoreMessage(1, parsed, 0), /before datasets were included, so your datasets were not changed/);
});

test('damaged datasets are skipped and counted, not restored half-way', () => {
  const parsed = parseBackup({
    format: 'jwork.workspace', flows: [],
    datasets: [
      { name: 'good', columns: ['a'], rows: [{ a: 1 }, { a: null }, {}] },   // numbers and gaps become text
      { name: '', columns: ['a'], rows: [] },                              // no name
      { name: 'nocols', rows: [] },                                         // no columns
      { name: 'badrows', columns: ['a'], rows: 'x' },
      null,
    ],
  });
  assert.equal(parsed.datasets!.length, 1);
  assert.equal(parsed.skippedDatasets, 4);
  assert.deepEqual(parsed.datasets![0].rows, [{ a: '1' }, { a: '' }, { a: '' }]);
  assert.match(restoreMessage(0, parsed, 1), /4 damaged datasets were skipped/);
});

test('files that are not backups are refused with a readable message', () => {
  assert.throws(() => parseBackup({ format: 'something', flows: [] }), /not a jwork backup/);
  assert.throws(() => parseBackup({ format: 'jwork.workspace' }), /not a jwork backup/);
  assert.throws(() => parseBackup(null), /not a jwork backup/);
});

test('a saved result stays a result after a backup and restore, and an upload stays an upload', async () => {
  const source = fresh();
  await source.upload(csv('marks.csv', 'name\nAda\n'), { name: 'marks' });
  await source.saveResult('low', { columns: ['name'], rows: [{ name: 'Ada' }] }, 'replace');
  const parsed = parseBackup(roundTrip(buildBackup({ profile: null, flows: [], knowledge: [], datasets: await source.exportAll() })));

  const target = fresh();
  await target.importAll(parsed.datasets!);
  const origins = Object.fromEntries((await target.list()).map(d => [d.name, d.origin]));
  assert.deepEqual(origins, { marks: 'upload', low: 'result' });

  // a backup made before origins existed restores as uploads
  const old = parseBackup({ format: 'jwork.workspace', flows: [], datasets: [{ name: 'x', columns: ['a'], rows: [] }] });
  const t2 = fresh();
  await t2.importAll(old.datasets!);
  assert.equal((await t2.list())[0].origin, 'upload');
});
