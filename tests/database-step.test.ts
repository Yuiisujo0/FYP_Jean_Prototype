// The Database step's modes (replace, append) and the rule that uploaded data is never replaced by a workflow,
// run through the real engine on the real library logic over an in-memory store.
// Run with: npm run test:database
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFlow, type RunContext } from '../src/lib/engine.ts';
import { explainStep } from '../src/lib/explain.ts';
import { createLibrary, memoryStore, type ParsedFile } from '../src/lib/library.ts';
import { parseUpload } from '../src/lib/tables.ts';
import type { Step } from '../src/types.ts';

const csv = (filename: string, text: string): ParsedFile => ({ ...parseUpload(filename, { text }), filename });
const step = (type: string, config: Record<string, string>): Step => ({ id: type + JSON.stringify(config), type, name: type, description: '', config });
const quiet = () => {};

function setup() {
  let t = 1000;
  const lib = createLibrary(memoryStore(), () => ++t);
  const ctx: RunContext = {
    listDatasets: () => lib.list(),
    loadDataset: async id => { const d = await lib.get(id); return { columns: d!.columns, rows: d!.rows }; },
    saveTable: (name, table, mode) => lib.saveResult(name, table, mode),
    fetchJson: async () => [],
  };
  return { lib, ctx };
}

const marks = 'name,score\nAmina,35\nBen,80\nChen,42\n';
const flow = (table: string, mode?: string, cond = 'score < 50') => [
  step('READ_CSV', { file: 'marks' }), step('FILTER', { condition: cond }),
  step('DATABASE', mode === undefined ? { table } : { table, mode }), step('OUTPUT', { format: 'table' }),
];
const rowsOf = async (lib: ReturnType<typeof setup>['lib'], name: string) => (await lib.get((await lib.list()).find(d => d.name === name)!.id))!;

test('a saved result is marked as a result, an upload as an upload', async () => {
  const { lib, ctx } = setup();
  await lib.upload(csv('marks.csv', marks), { name: 'marks' });
  await runFlow(flow('low'), ctx, quiet);
  const all = await lib.list();
  assert.equal(all.find(d => d.name === 'marks')!.origin, 'upload');
  assert.equal(all.find(d => d.name === 'low')!.origin, 'result');
});

test('replace (the default, and what a model produces) replaces the earlier result', async () => {
  const { lib, ctx } = setup();
  await lib.upload(csv('marks.csv', marks), { name: 'marks' });
  await runFlow(flow('low'), ctx, quiet);
  await runFlow(flow('low', 'replace'), ctx, quiet);
  assert.equal((await rowsOf(lib, 'low')).rows.length, 2);
});

test('append creates the table the first time, then adds the rows on each run', async () => {
  const { lib, ctx } = setup();
  await lib.upload(csv('marks.csv', marks), { name: 'marks' });
  const messages: string[] = [];
  const report = (_id: string, state: string, m: string) => { if (state === 'complete' && /Created|Added/.test(m)) messages.push(m); };

  await runFlow(flow('log', 'append'), ctx, report);
  assert.equal((await rowsOf(lib, 'log')).rows.length, 2);
  await runFlow(flow('log', 'append'), ctx, report);
  const log = await rowsOf(lib, 'log');
  assert.equal(log.rows.length, 4);
  assert.deepEqual(log.rows.map(r => r.name), ['Amina', 'Chen', 'Amina', 'Chen']);
  assert.equal(log.origin, 'result');
  assert.deepEqual(messages, ['Created “log” in the Data library with 2 rows', 'Added 2 rows to “log”, which now has 4 rows']);
});

test('append keeps the table’s own column names when the spelling differs, and refuses different columns without changing anything', async () => {
  const { lib, ctx } = setup();
  await lib.upload(csv('marks.csv', marks), { name: 'marks' });
  await lib.saveResult('log', { columns: ['Name', 'Score'], rows: [{ Name: 'Old', Score: '1' }] }, 'replace');
  await runFlow(flow('log', 'append'), ctx, quiet);                       // name,score matches Name,Score once spelling is ignored
  const log = await rowsOf(lib, 'log');
  assert.deepEqual(log.columns, ['Name', 'Score']);
  assert.deepEqual(log.rows.map(r => r.Name), ['Old', 'Amina', 'Chen']);

  const select = [step('READ_CSV', { file: 'marks' }), step('TRANSFORM', { operation: 'select columns name' }), step('DATABASE', { table: 'log', mode: 'append' }), step('OUTPUT', { format: 'table' })];
  await assert.rejects(runFlow(select, ctx, quiet), /columns do not match “log”/);
  assert.equal((await rowsOf(lib, 'log')).rows.length, 3);                // untouched
});

test('a workflow cannot replace data the user uploaded, but may add rows to it', async () => {
  const { lib, ctx } = setup();
  await lib.upload(csv('marks.csv', marks), { name: 'marks' });
  await lib.upload(csv('late.csv', 'name,score\nDewi,20\n'), { name: 'late' });
  const readLate = (mode?: string) => [step('READ_CSV', { file: 'late' }), step('DATABASE', mode === undefined ? { table: 'marks' } : { table: 'marks', mode }), step('OUTPUT', { format: 'table' })];

  await assert.rejects(runFlow(readLate(), ctx, quiet), /data you uploaded.*append/);
  assert.equal((await rowsOf(lib, 'marks')).rows.length, 3);              // not overwritten
  await runFlow(readLate('append'), ctx, quiet);
  const m = await rowsOf(lib, 'marks');
  assert.equal(m.rows.length, 4);
  assert.equal(m.origin, 'upload');                                       // still the user's own data
});

test('a workflow still cannot write into a dataset it reads, in either mode', async () => {
  const { lib, ctx } = setup();
  await lib.upload(csv('marks.csv', marks), { name: 'marks' });
  for (const mode of ['replace', 'append']) await assert.rejects(runFlow(flow('marks', mode), ctx, quiet), /dataset this workflow reads/);
});

test('an unknown mode is an error, not a silent replace', async () => {
  const { lib, ctx } = setup();
  await lib.upload(csv('marks.csv', marks), { name: 'marks' });
  await assert.rejects(runFlow(flow('low', 'merge'), ctx, quiet), /Unknown mode “merge”/);
  assert.equal((await lib.list()).length, 1);
});

test('a preview shows what append would do, saves nothing, and fails the same way a run would', async () => {
  const { lib, ctx } = setup();
  await lib.upload(csv('marks.csv', marks), { name: 'marks' });
  const said: string[] = [];
  const report = (_id: string, _s: string, m: string) => said.push(m);

  await runFlow(flow('log', 'append'), ctx, report, { dryRun: true });
  assert.ok(said.includes('Would create “log” with 2 rows (nothing is saved in a preview)'));
  assert.equal((await lib.list()).length, 1);

  await lib.saveResult('log', { columns: ['name', 'score'], rows: [{ name: 'x', score: '1' }] }, 'replace');
  said.length = 0;
  await runFlow(flow('log', 'append'), ctx, report, { dryRun: true });
  assert.ok(said.includes('Would add 2 rows to “log”, which would then have 3 rows (nothing is saved in a preview)'));
  assert.equal((await rowsOf(lib, 'log')).rows.length, 1);               // still one row

  const wrong = [step('READ_CSV', { file: 'marks' }), step('TRANSFORM', { operation: 'select columns name' }), step('DATABASE', { table: 'log', mode: 'append' }), step('OUTPUT', { format: 'table' })];
  await assert.rejects(runFlow(wrong, ctx, quiet, { dryRun: true }), /columns do not match/);

  await lib.upload(csv('other.csv', 'x\n1\n'), { name: 'other' });
  const upload = [step('READ_CSV', { file: 'marks' }), step('DATABASE', { table: 'other' }), step('OUTPUT', { format: 'table' })];
  await assert.rejects(runFlow(upload, ctx, quiet, { dryRun: true }), /data you uploaded/);
});

test('uploads are never matched against saved results', async () => {
  const { lib } = setup();
  await lib.saveResult('low', { columns: ['name', 'score'], rows: [{ name: 'a', score: '1' }] }, 'replace');
  const info = await lib.inspect(csv('low.csv', 'name,score\nb,2\n'));
  assert.deepEqual(info.matches, []);
});

test('the plain-English sentence says which mode a Database step uses', () => {
  const s = (config: Record<string, string>) => explainStep(step('DATABASE', config));
  assert.match(s({ table: 'low' }), /replacing its contents/);
  assert.match(s({ table: 'low', mode: 'replace' }), /replacing its contents/);
  assert.match(s({ table: 'log', mode: 'append' }), /Adds the rows to the table “log”.*each run adds them again/);
});
