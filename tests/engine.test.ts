// Run with: npm run test:engine   (Node 24 runs TypeScript directly; no extra packages needed.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCondition, mixesAndOr, runFlow, toCsv, type RunContext, type Table } from '../src/lib/engine.ts';
import type { Step } from '../src/types.ts';

const marks: Table = {
  columns: ['Student', 'Score', 'Status'],
  rows: [
    { Student: 'Amina', Score: '42', Status: 'late' },
    { Student: 'Daniel', Score: '67', Status: 'ok' },
    { Student: 'Mei', Score: '38', Status: 'ok' },
    { Student: 'Rahim', Score: '', Status: 'ok' },
  ],
};
const cols = marks.columns;
const names = (cond: string) => marks.rows.filter(compileCondition(cond, cols)).map(r => r.Student);

test('numeric comparison, and columns are matched without regard to case', () => {
  assert.deepEqual(names('score < 50'), ['Amina', 'Mei']);
  assert.deepEqual(names('SCORE >= 67'), ['Daniel']);
});

test('a blank cell never satisfies a numeric comparison', () => {
  assert.ok(!names('score < 50').includes('Rahim'));
  assert.ok(names('score != 42').includes('Rahim'));
});

test('and / or / brackets / contains / quoted strings', () => {
  assert.deepEqual(names('score < 50 and status == "late"'), ['Amina']);
  assert.deepEqual(names('score > 60 or status contains lat'), ['Amina', 'Daniel']);
  assert.deepEqual(names('(score < 50 or score > 60) and status = ok'), ['Daniel', 'Mei']);
});

test('an unknown column is an error that lists the real columns', () => {
  assert.throws(() => compileCondition('marks < 50', cols), /no column “marks”.*Student, Score, Status/);
});

test('code is not evaluated', () => {
  assert.throws(() => compileCondition('process.exit(1)', cols));
  assert.throws(() => compileCondition('score < 50; alert(1)', cols));
});

test('malformed conditions are rejected', () => {
  for (const bad of ['', 'score <', 'score 50', '(score < 50', 'score < 50 and']) {
    assert.throws(() => compileCondition(bad, cols), undefined, bad);
  }
});

const step = (type: string, config: Record<string, string>, name = type): Step => ({ id: name, type, name, description: '', config });

function context(saved: Record<string, Table> = {}): RunContext {
  return {
    listDatasets: async () => [{ id: 1, name: 'Student marks', filename: 'marks.csv' }],
    loadDataset: async () => marks,
    saveTable: async (name, t) => { saved[name] = t; },
    fetchJson: async () => [{ id: 1, tag: 'a' }, { id: 2 }],
  };
}
const quiet = () => {};

test('read, filter, save, output on stored data', async () => {
  const saved: Record<string, Table> = {};
  const result = await runFlow([
    step('READ_CSV', { file: 'marks.csv' }),
    step('FILTER', { condition: 'score < 50' }),
    step('DATABASE', { table: 'low_scores' }),
    step('OUTPUT', { format: 'table' }),
  ], context(saved), quiet);
  assert.deepEqual(result.rows.map(r => r.Student), ['Amina', 'Mei']);
  assert.equal(saved.low_scores.rows.length, 2);
});

test('a dataset is found by name or by file name, with or without extension', async () => {
  for (const file of ['Student marks', 'student_marks', 'marks.csv', 'marks']) {
    const r = await runFlow([step('READ_CSV', { file })], context(), quiet);
    assert.equal(r.rows.length, 4, file);
  }
});

test('a missing dataset stops the run with a helpful message and marks the step', async () => {
  const seen: string[] = [];
  await assert.rejects(
    runFlow([step('READ_CSV', { file: 'nope.csv' }, 'read')], context(), (id, state) => seen.push(`${id}:${state}`)),
    /No dataset matches “nope.csv”/,
  );
  assert.deepEqual(seen, ['read:running', 'read:error']);
});

test('saving must not overwrite the dataset being read', async () => {
  await assert.rejects(
    runFlow([step('READ_CSV', { file: 'marks.csv' }), step('DATABASE', { table: 'student marks' })], context(), quiet),
    /source data is not overwritten/,
  );
});

test('transform operations', async () => {
  const run = (operation: string) => runFlow([step('READ_CSV', { file: 'marks.csv' }), step('TRANSFORM', { operation })], context(), quiet);
  assert.deepEqual((await run('select columns student, score')).columns, ['Student', 'Score']);
  assert.deepEqual((await run('drop columns status')).columns, ['Student', 'Score']);
  assert.deepEqual((await run('sort by score desc')).rows.map(r => r.Student), ['Daniel', 'Amina', 'Mei', 'Rahim']);
  assert.equal((await run('limit 2')).rows.length, 2);
  assert.ok((await run('rename score to marks')).columns.includes('marks'));
  await assert.rejects(run('select columns nothing'), /no column “nothing”/);
});

test('an operation it does not understand is skipped visibly, not guessed', async () => {
  const messages: string[] = [];
  const r = await runFlow([step('READ_CSV', { file: 'marks.csv' }), step('TRANSFORM', { operation: 'select columns' }, 't')], context(), (id, _s, m) => id === 't' && messages.push(m));
  assert.equal(r.rows.length, 4);
  assert.ok(messages.some(m => m.startsWith('Skipped')));
});

test('http: list of records becomes a table; other shapes are rejected', async () => {
  const r = await runFlow([step('HTTP_REQUEST', { method: 'GET', url: 'https://x.test/a' })], context(), quiet);
  assert.deepEqual(r.columns, ['id', 'tag']);
  assert.equal(r.rows[1].tag, '');
  const bad = { ...context(), fetchJson: async () => 'hello' };
  await assert.rejects(runFlow([step('HTTP_REQUEST', { method: 'GET', url: 'https://x.test/a' })], bad, quiet), /not a list of records/);
  await assert.rejects(runFlow([step('HTTP_REQUEST', { method: 'GET', url: 'file:///etc/passwd' })], context(), quiet), /must start with http/);
});

test('csv export quotes commas, quotes and newlines', () => {
  const csv = toCsv({ columns: ['a', 'b'], rows: [{ a: 'x,y', b: 'say "hi"' }] });
  assert.equal(csv, 'a,b\r\n"x,y","say ""hi"""\r\n');
});

test('in and not in take a list of values', () => {
  assert.deepEqual(names('status in (late, ok)'), ['Amina', 'Daniel', 'Mei', 'Rahim']);
  assert.deepEqual(names('status in ("late")'), ['Amina']);
  assert.deepEqual(names('status not in (late)'), ['Daniel', 'Mei', 'Rahim']);
  assert.deepEqual(names('score in (42, 38)'), ['Amina', 'Mei']);
  assert.deepEqual(names('score in (42, 38) and status in (late)'), ['Amina']);
  assert.throws(() => compileCondition('status in late', cols), /needs a list in brackets/);
  assert.throws(() => compileCondition('status in ()', cols), /empty/);
  assert.throws(() => compileCondition('status in (late', cols), /closing bracket/);
});

test('mixing and with or at one level is flagged; brackets and single operators are not', async () => {
  const { mixesAndOr } = await import('../src/lib/engine.ts');
  assert.equal(mixesAndOr('a == 1 or b == 2 and c == 3'), true);
  assert.equal(mixesAndOr('a == 1 and b == 2 or c == 3'), true);
  assert.equal(mixesAndOr('(a == 1 or b == 2) and c == 3'), false);
  assert.equal(mixesAndOr('a == 1 and b == 2 and c == 3'), false);
  assert.equal(mixesAndOr('a == 1 or b == 2'), false);
  assert.equal(mixesAndOr('x == "this and that or more"'), false);
  assert.equal(mixesAndOr('not a valid ((('), false);
});

test('describeCondition and parseTransform read what the engine will run', async () => {
  const { describeCondition, parseTransform } = await import('../src/lib/engine.ts');
  assert.equal(describeCondition('course == CS101 and attendance_pct < 70'), 'course is CS101 and attendance_pct is less than 70');
  assert.equal(describeCondition('(a >= 1 or b != "x y") and c contains z'), '(a is at least 1 or b is not x y) and c contains z');
  assert.equal(describeCondition('region in (South, West)'), 'region in (South, West)');
  assert.equal(describeCondition('not a valid ((('), 'not a valid (((');
  assert.deepEqual(parseTransform('select columns name, score'), { kind: 'select', names: ['name', 'score'] });
  assert.deepEqual(parseTransform('sort by score desc'), { kind: 'sort', column: 'score', desc: true });
  assert.deepEqual(parseTransform('rename a to b'), { kind: 'rename', from: 'a', to: 'b' });
  assert.deepEqual(parseTransform('limit 5'), { kind: 'limit', n: 5 });
  assert.equal(parseTransform('select columns').kind, 'unknown');
  assert.equal(parseTransform('group by category').kind, 'unknown');
});

test('explainStep says what Run will do, including when it will not do it', async () => {
  const { explainStep } = await import('../src/lib/explain.ts');
  const s = (type: string, config: Record<string, string>) => ({ id: '1', type, name: type, description: '', config });
  assert.equal(explainStep(s('READ_CSV', { file: 'student_marks' })), 'Reads the “student_marks” dataset.');
  assert.equal(explainStep(s('FILTER', { condition: 'customer == Lim' })), 'Keeps only the rows where customer is Lim.');
  assert.match(explainStep(s('FILTER', { condition: 'a == 1 or b == 2 and c == 3' })), /Check the brackets/);
  assert.equal(explainStep(s('TRANSFORM', { operation: 'sort by years desc' })), 'Sorts the rows by years, highest first.');
  assert.match(explainStep(s('TRANSFORM', { operation: 'group by category' })), /skipped/);
  assert.match(explainStep(s('LLM', { task: 'summarise' })), /do not run yet/);
  assert.match(explainStep(s('DATABASE', { table: 'low' })), /replacing its contents/);
});

test('a preview (dry run) never saves anything and never calls the web', async () => {
  const { PreviewStop } = await import('../src/lib/engine.ts');
  const saved: Record<string, Table> = {};
  const calls: string[] = [];
  const ctx = { ...context(saved), fetchJson: async (u: string) => { calls.push(u); return []; } };

  const withDb = await runFlow([
    step('READ_CSV', { file: 'marks.csv' }), step('FILTER', { condition: 'score < 50' }), step('DATABASE', { table: 'low' }), step('OUTPUT', { format: 'table' }),
  ], ctx, quiet, { dryRun: true });
  assert.equal(withDb.rows.length, 2);          // the result is still computed
  assert.deepEqual(saved, {});                  // but nothing was saved

  await assert.rejects(
    runFlow([step('HTTP_REQUEST', { method: 'GET', url: 'https://x.test/a' }), step('OUTPUT', { format: 'table' })], ctx, quiet, { dryRun: true }),
    (e: unknown) => e instanceof PreviewStop && /press Run to fetch/.test(e.message),
  );
  assert.deepEqual(calls, []);                  // no request was made

  // a real run still saves
  await runFlow([step('READ_CSV', { file: 'marks.csv' }), step('DATABASE', { table: 'all_rows' })], ctx, quiet);
  assert.equal(saved.all_rows.rows.length, 4);
});

/* ---------------- run register, lineage and exceptions (the "never silently wrong" guarantees) ---------------- */

const readMarks = step('READ_CSV', { file: 'marks.csv' }, 'read');

test('every source row is accounted for: kept + excluded + flagged = total, and the result holds exactly the kept rows', async () => {
  const r = await runFlow([readMarks, step('FILTER', { condition: 'score < 50' }, 'f'), step('OUTPUT', { format: 'table' }, 'out')], context(), quiet);
  const reg = r.register!;
  assert.equal(reg.source, '“Student marks”');
  assert.deepEqual([reg.total, reg.kept, reg.excluded, reg.flagged], [4, 2, 1, 1]);
  assert.equal(reg.balanced, true);
  assert.deepEqual(r.lineage, [[1], [3]]);                                  // Amina and Mei are source rows 1 and 3
  assert.deepEqual(r.rows.map(x => x.Student), ['Amina', 'Mei']);
  assert.deepEqual(reg.rows[1], { row: 2, status: 'excluded', stepId: 'f', reason: 'does not match “score is less than 50”' });
  assert.deepEqual(reg.rows[3], { row: 4, status: 'flagged', stepId: 'f', reason: 'Score is blank, so “score is less than 50” could not be checked' });
});

test('a row the condition could not check is reported as a critical exception, never dropped silently', async () => {
  const r = await runFlow([readMarks, step('FILTER', { condition: 'score < 50' }, 'f')], context(), quiet);
  const ex = r.exceptions.filter(e => e.kind === 'undecided_rows');
  assert.equal(ex.length, 1);
  assert.equal(ex[0].severity, 'critical');
  assert.equal(ex[0].id, 'f:undecided:Score:blank');
  assert.deepEqual(ex[0].rows, [4]);
  assert.match(ex[0].message, /1 row left out because Score is blank/);
  assert.match(r.trace[1].message, /2 of 4 rows matched; 1 row could not be checked/);
});

test('three-valued logic: a blank only matters when it decides the outcome', async () => {
  const run = (condition: string) => runFlow([readMarks, step('FILTER', { condition }, 'f')], context(), quiet);
  // Rahim's score is blank, but his status alone settles these, so nothing is flagged.
  let r = await run('score < 50 or status == ok');
  assert.equal(r.register!.flagged, 0);
  assert.ok(r.rows.some(x => x.Student === 'Rahim'));
  r = await run('score < 50 and status == late');
  assert.equal(r.register!.flagged, 0);
  assert.equal(r.register!.rows[3].status, 'excluded');
  // Here the blank decides it.
  r = await run('score < 50 and status == ok');
  assert.equal(r.register!.rows[3].status, 'flagged');
  // `!=` keeps the blank row (the long-standing rule), but says the check was not really made.
  r = await run('score != 42');
  assert.ok(r.rows.some(x => x.Student === 'Rahim'));
  const kept = r.exceptions.find(e => e.kind === 'kept_undecided')!;
  assert.equal(kept.severity, 'warning');
  assert.deepEqual(kept.rows, [4]);
});

test('text in a numeric comparison is reported as "not a number", with the value only in the local register', async () => {
  const odd: Table = { columns: ['Student', 'Score'], rows: [{ Student: 'A', Score: '55' }, { Student: 'B', Score: 'absent' }] };
  const ctx = { ...context(), loadDataset: async () => odd };
  const r = await runFlow([readMarks, step('FILTER', { condition: 'score >= 50' }, 'f')], ctx, quiet);
  assert.equal(r.exceptions[0].id, 'f:undecided:Score:text');
  assert.match(r.exceptions[0].message, /Score is not a number/);
  assert.doesNotMatch(r.exceptions[0].message, /absent/);
  assert.match(r.register!.rows[1].reason!, /Score is “absent”, not a number/);
});

test('lineage survives sorting, and a limit records which rows it cut', async () => {
  const r = await runFlow([readMarks, step('TRANSFORM', { operation: 'sort by score desc' }, 's'), step('TRANSFORM', { operation: 'limit 2' }, 'l')], context(), quiet);
  assert.deepEqual(r.rows.map(x => x.Student), ['Daniel', 'Amina']);
  assert.deepEqual(r.lineage, [[2], [1]]);
  assert.equal(r.register!.balanced, true);
  assert.deepEqual(r.register!.rows.filter(x => x.status === 'excluded').map(x => [x.row, x.stepId, x.reason]), [[3, 'l', 'after the first 2 rows'], [4, 'l', 'after the first 2 rows']]);
  const sortNote = r.exceptions.find(e => e.kind === 'sort_values')!;
  assert.deepEqual([sortNote.severity, sortNote.column, sortNote.rows], ['warning', 'Score', [4]]);
});

test('a step that did not run is a critical exception, not a quiet "complete"', async () => {
  const r = await runFlow([readMarks, step('TRANSFORM', { operation: 'group by status' }, 't'), step('LLM', { task: 'summarise' }, 'ai')], context(), quiet);
  const skipped = r.exceptions.filter(e => e.kind === 'skipped_step');
  assert.deepEqual(skipped.map(e => [e.stepId, e.severity]), [['t', 'critical'], ['ai', 'critical']]);
  assert.deepEqual(r.trace.map(t => t.skipped), [false, true, true]);
  assert.equal(r.rows.length, 4);   // rows still pass through, as before
});

test('an empty result is a warning; a workflow with no data has no register', async () => {
  const r = await runFlow([readMarks, step('FILTER', { condition: 'status == absent' }, 'f'), step('OUTPUT', { format: 'table' }, 'out')], context(), quiet);
  assert.deepEqual(r.exceptions.map(e => [e.kind, e.severity]), [['no_rows', 'warning']]);
  assert.equal(r.register!.excluded, 4);
  const none = await runFlow([step('INPUT', {}), step('OUTPUT', { format: 'table' })], context(), quiet);
  assert.equal(none.register, null);
  assert.deepEqual(none.exceptions, []);
});

test('the trace records rows and columns in and out of every step', async () => {
  const r = await runFlow([readMarks, step('FILTER', { condition: 'status == ok' }), step('TRANSFORM', { operation: 'select columns student' })], context(), quiet);
  assert.deepEqual(r.trace.map(t => [t.type, t.rowsIn, t.rowsOut, t.columnsOut.length]), [['READ_CSV', 0, 4, 3], ['FILTER', 4, 3, 3], ['TRANSFORM', 3, 3, 1]]);
});

test('reading a second source reports that the first one was not used', async () => {
  const r = await runFlow([readMarks, step('READ_CSV', { file: 'marks.csv' }, 'again')], context(), quiet);
  assert.equal(r.exceptions[0].kind, 'replaced_source');
  assert.equal(r.register!.total, 4);
  assert.equal(r.register!.balanced, true);
});

test('conditionColumns finds the columns a condition uses, as written and as matched', async () => {
  const { conditionColumns } = await import('../src/lib/engine.ts');
  assert.deepEqual(conditionColumns('score < 50 and STATUS in (late, "ok")', cols), [{ written: 'score', column: 'Score' }, { written: 'STATUS', column: 'Status' }]);
  assert.deepEqual(conditionColumns('not a valid (((', cols), []);
});

/* ---------------- leniency added after the failure analysis of the saved runs ---------------- */
const staff: Table = {
  columns: ['name', 'supplier', 'salary', 'city'],
  rows: [
    { name: 'A', supplier: 'Delta Trading', salary: '3000', city: 'Kuching' },
    { name: 'B', supplier: 'Borneo Supply Co', salary: '4000', city: 'Miri' },
    { name: 'C', supplier: 'Acme', salary: '5000', city: 'Sibu' },
    { name: 'D', supplier: 'Delta Trading', salary: '6000', city: 'Miri' },
    { name: 'E', supplier: 'Acme', salary: '7000', city: 'Kuching' },
  ],
};
const who = (cond: string) => staff.rows.filter(compileCondition(cond, staff.columns)).map(r => r.name);

test('an unquoted value of several words is read as one value', () => {
  assert.deepEqual(who('supplier == Delta Trading'), ['A', 'D']);
  assert.deepEqual(who('supplier == Borneo Supply Co and salary > 3500'), ['B']);
  assert.deepEqual(who('supplier in (Delta Trading, Acme)'), ['A', 'C', 'D', 'E']);
  assert.deepEqual(who('supplier == Delta Trading or city == Sibu'), ['A', 'C', 'D']);
});

test('between includes both ends and needs two values', () => {
  assert.deepEqual(who('salary between 4000 and 6000'), ['B', 'C', 'D']);
  assert.deepEqual(who('salary between 4000 and 6000 and city == Miri'), ['B', 'D']);
  assert.deepEqual(who('city == Sibu or salary between 6000 and 7000'), ['C', 'D', 'E']);
  assert.throws(() => compileCondition('salary between 4000', staff.columns), /between/);
});

test('a second comparison may leave out the column: salary > 3500 and < 6500', () => {
  assert.deepEqual(who('salary > 3500 and < 6500'), ['B', 'C', 'D']);
});

test('between does not count as mixing and with or', () => {
  assert.equal(mixesAndOr('salary between 1 and 5'), false);
  assert.equal(mixesAndOr('salary between 1 and 5 or city == Miri'), false);
  assert.equal(mixesAndOr('a == 1 and b == 2 or c == 3'), true);
});
