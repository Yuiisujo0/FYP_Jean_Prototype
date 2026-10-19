// Review, approval, the agent loop, observations and the Excel report. Run with: npm run test:review
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { checkByRunning, type RevisionReply } from '../src/lib/agent.ts';
import { runFlow, type RunContext, type Table } from '../src/lib/engine.ts';
import { observeRun } from '../src/lib/observe.ts';
import { approve, assumptionsFor, emptyDecisions, readApproval, reviewGate, sha256, tableHash, workflowHash, type ReviewDecisions } from '../src/lib/review.ts';
import { parseXlsx } from '../src/lib/tables.ts';
import { asCell, buildReport, buildXlsx, reportSheets } from '../src/lib/xlsx.ts';
import type { Step } from '../src/types.ts';

const marks: Table = {
  columns: ['Student', 'Score', 'Status'],
  rows: [
    { Student: 'Amina', Score: '42', Status: 'late' },
    { Student: 'Daniel', Score: '67', Status: 'ok' },
    { Student: 'Mei', Score: '38', Status: 'ok' },
    { Student: 'Rahim', Score: '', Status: 'ok' },
    { Student: 'Zul', Score: '90', Status: 'ok' },
  ],
};
const ctx: RunContext = {
  listDatasets: async () => [{ id: 1, name: 'Student marks', filename: 'marks.csv' }],
  loadDataset: async () => marks,
  saveTable: async () => {},
  fetchJson: async () => [],
};
const step = (id: string, type: string, config: Record<string, string>): Step => ({ id, type, name: `${type} ${id}`, description: '', config });
const quiet = () => {};
const run = (steps: Step[]) => runFlow(steps, ctx, quiet, { dryRun: true });

const FLOW = [
  step('r', 'READ_CSV', { file: 'marks' }),
  step('f', 'FILTER', { condition: 'score >= 90 or score < 40' }),
  step('t', 'TRANSFORM', { operation: 'select columns student, score' }),
  step('o', 'OUTPUT', { format: 'table' }),
];

/* ---------------- assumptions and the gate ---------------- */

test('assumptions are read from the steps and the run: source, meaning at the limit, matched columns, dropped columns', async () => {
  const result = await run(FLOW);
  const texts = assumptionsFor(FLOW, result).map(a => a.text);
  assert.deepEqual(texts, [
    'The data is the dataset “Student marks” (5 rows).',
    'Keep the rows where score is at least 90 or score is less than 40: a row exactly at the limit is kept; a row exactly at the limit is left out.',
    '“score” means the column “Score”.',
    'Only the columns Student, Score are kept; Status is left out of the result.',
  ]);
});

test('approval stays closed until critical exceptions are accepted with a reason and assumptions are confirmed', async () => {
  const result = await run(FLOW);
  const assumptions = assumptionsFor(FLOW, result);
  const d: ReviewDecisions = emptyDecisions();
  let gate = reviewGate(result, assumptions, d);
  assert.equal(gate.canApprove, false);
  assert.equal(gate.openCritical.length, 1);                 // Rahim's blank score
  assert.equal(gate.unconfirmed.length, 4);

  d.accepted[gate.openCritical[0].id] = 'ok';                // too short to count as a reason
  assert.equal(reviewGate(result, assumptions, d).openCritical.length, 1);
  d.accepted[gate.openCritical[0].id] = 'Rahim was absent; handled separately';
  for (const a of assumptions) d.confirmed[a.id] = true;
  gate = reviewGate(result, assumptions, d);
  assert.equal(gate.canApprove, true);
  assert.equal(reviewGate(result, assumptions, d, true).canApprove, false);   // stale: the workflow changed after the run
});

test('an approval cannot skip the gate, and it records fingerprints, decisions and assumptions', async () => {
  const result = await run(FLOW);
  const assumptions = assumptionsFor(FLOW, result);
  await assert.rejects(approve(FLOW, result, assumptions, emptyDecisions(), 'Jean'), /cannot be approved yet/);

  const d = emptyDecisions();
  d.accepted[result.exceptions.find(e => e.severity === 'critical')!.id] = 'Absent student, checked by hand';
  for (const a of assumptions) d.confirmed[a.id] = true;
  const rec = await approve(FLOW, result, assumptions, d, ' Jean ', 1_700_000_000_000);
  assert.equal(rec.approver, 'Jean');
  assert.equal(rec.workflowHash, await workflowHash(FLOW));
  assert.equal(rec.inputHash, await tableHash(marks));
  assert.equal(rec.outputHash, await tableHash(result));
  assert.deepEqual(rec.counts, { total: 5, kept: 2, excluded: 2, flagged: 1 });
  assert.deepEqual(rec.resolutions.map(x => x.note), ['Absent student, checked by hand']);
  assert.equal(rec.assumptions.length, 4);
  assert.deepEqual(readApproval(JSON.parse(JSON.stringify(rec))), rec);
  assert.equal(readApproval({ approvedAt: 'yesterday' }), null);
});

test('fingerprints: names and positions do not change the workflow hash; parameters and data do', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const renamed = FLOW.map(s => ({ ...s, name: 'x', position: { x: 1, y: 2 } }));
  assert.equal(await workflowHash(renamed), await workflowHash(FLOW));
  const edited = FLOW.map(s => (s.id === 'f' ? { ...s, config: { condition: 'score >= 80' } } : s));
  assert.notEqual(await workflowHash(edited), await workflowHash(FLOW));
  assert.notEqual(await tableHash({ ...marks, rows: marks.rows.slice(1) }), await tableHash(marks));
});

/* ---------------- observations: what may be sent to the AI ---------------- */

test('an observation never contains a data value, only counts, column names and the steps', async () => {
  const steps = [step('r', 'READ_CSV', { file: 'marks' }), step('f', 'FILTER', { condition: 'status == absent' }), step('o', 'OUTPUT', { format: 'table' })];
  const obs = observeRun(steps, { result: await run(steps) });
  for (const row of marks.rows) for (const v of Object.values(row)) {
    if (v && !['ok'].includes(v)) assert.ok(!obs.text.includes(v), `“${v}” leaked into: ${obs.text}`);
  }
  assert.match(obs.text, /40|5 rows in, 0 rows out/);
  assert.match(obs.text, /Column Status in the data: 5 text values\./);
  assert.deepEqual(obs.signals.map(s => s.kind), ['no_rows']);
});

test('signals: run errors, empty results, skipped steps and filters that keep everything', async () => {
  const kinds = async (steps: Step[]) => {
    let outcome;
    try { outcome = { result: await run(steps) }; } catch (e) { outcome = { error: (e as Error).message }; }
    return observeRun(steps, outcome).signals.map(s => s.kind);
  };
  assert.deepEqual(await kinds([step('r', 'READ_CSV', { file: 'marks' }), step('f', 'FILTER', { condition: 'marks < 50' })]), ['run_error']);
  assert.deepEqual(await kinds([step('r', 'READ_CSV', { file: 'marks' }), step('f', 'FILTER', { condition: 'status != gone' })]), ['filter_kept_all']);
  assert.deepEqual(await kinds([step('r', 'READ_CSV', { file: 'marks' }), step('t', 'TRANSFORM', { operation: 'group by status' })]), ['skipped_step']);
  assert.deepEqual(await kinds([step('r', 'READ_CSV', { file: 'marks' }), step('f', 'FILTER', { condition: 'score < 50' })]), ['undecided_rows']);
});

/* ---------------- the agent loop ---------------- */

const reply = (nodes: Step[], extra: Partial<RevisionReply> = {}): RevisionReply => ({ nodes, valid: true, unchanged: false, issues: [], ...extra });
const testWith = async (steps: Step[]) => { try { return { result: await run(steps) }; } catch (e) { return { error: (e as Error).message }; } };

test('agent: a clean first run stops at once, and nothing is sent to the AI', async () => {
  let asked = 0;
  const r = await checkByRunning(FLOW.slice(0, 2), { test: testWith, revise: async () => { asked++; return reply(FLOW); } });
  assert.equal(r.status, 'clean');
  assert.equal(asked, 0);
  assert.equal(r.rounds.length, 1);
  assert.equal(r.rounds[0].sent, '');
  assert.match(r.rounds[0].detail, /could not be checked.*you decide/);   // the blank score is left to the reviewer
});

test('agent: a failing plan is revised from the observation, run again, and the change is described from the steps', async () => {
  const broken = [step('r', 'READ_CSV', { file: 'marks' }), step('f', 'FILTER', { condition: 'marks < 50' }), step('o', 'OUTPUT', { format: 'table' })];
  const fixed = [broken[0], { ...broken[1], id: 'new-id', config: { condition: 'score < 50' } }, broken[2]];
  const sent: string[] = [];
  const r = await checkByRunning(broken, { test: testWith, revise: async (_s, observation) => { sent.push(observation); return reply(fixed); } });
  assert.equal(r.status, 'clean');
  assert.deepEqual(r.rounds.map(x => x.outcome), ['revised', 'clean']);
  assert.match(sent[0], /There is no column “marks”/);
  assert.equal(r.steps[1].id, 'f');                                       // the edited step keeps its identity
  assert.match(r.rounds[0].detail, /Changed a step\. It now says: Keeps only the rows where score is less than 50\./);
});

test('agent: it stops when the model keeps the plan, returns something invalid, or fails; and after the revision limit', async () => {
  const empty = [step('r', 'READ_CSV', { file: 'marks' }), step('f', 'FILTER', { condition: 'status == absent' }), step('o', 'OUTPUT', { format: 'table' })];
  let r = await checkByRunning(empty, { test: testWith, revise: async s => reply(s, { unchanged: true }) });
  assert.deepEqual([r.status, r.rounds.map(x => x.outcome)], ['open', ['unchanged']]);
  r = await checkByRunning(empty, { test: testWith, revise: async s => reply(s, { valid: false, issues: [{ level: 'ERROR', message: 'End the workflow with an Output step.' }] }) });
  assert.match(r.rounds[0].detail, /not valid \(End the workflow/);
  assert.equal(r.steps, empty);
  r = await checkByRunning(empty, { test: testWith, revise: async () => { throw new Error('quota'); } });
  assert.deepEqual(r.rounds.map(x => x.outcome), ['failed']);
  // Always "fixed" into another empty result: two revisions, then it stops and leaves it to the person.
  let n = 0;
  r = await checkByRunning(empty, { test: testWith, revise: async s => reply(s.map(x => (x.type === 'FILTER' ? { ...x, config: { condition: `status == none${++n}` } } : x))) });
  assert.deepEqual(r.rounds.map(x => x.outcome), ['revised', 'revised', 'limit']);
  assert.equal(r.status, 'open');
});

test('agent: a workflow that calls the web is not tested here', async () => {
  const r = await checkByRunning(FLOW, { test: async () => ({ blocked: 'it fetches a web address' }), revise: async () => reply(FLOW) });
  assert.equal(r.status, 'untestable');
});

/* ---------------- the Excel report ---------------- */

test('numbers that read back unchanged become numbers; anything else stays text', () => {
  assert.deepEqual(['42', '-3.5', '0', '007', '1.50', '1e5', '', '=1+1', ' 4'].map(asCell), [42, -3.5, 0, '007', '1.50', '1e5', '', '=1+1', ' 4']);
});

test('the workbook opens with the app’s own Excel reader and holds the result with source rows', async () => {
  const result = await run(FLOW);
  const assumptions = assumptionsFor(FLOW, result);
  const bytes = buildReport({ flowName: 'Top and bottom', request: 'Students at 90 or more, or below 40', steps: FLOW, result, assumptions, decisions: emptyDecisions(), approval: null, checks: [], madeAt: new Date(0) });
  const back = parseXlsx(bytes);   // the first sheet with data: the result
  assert.deepEqual(back.columns, ['Source row', 'Student', 'Score']);
  assert.deepEqual(back.rows.map(r => [r['Source row'], r.Student, r.Score]), [['3', 'Mei', '38'], ['5', 'Zul', '90']]);

  const zip = unzipSync(bytes);
  const workbook = strFromU8(zip['xl/workbook.xml']);
  assert.match(workbook, /name="Result".*name="Review".*name="Method"/);
  const review = strFromU8(zip['xl/worksheets/sheet2.xml']);
  assert.match(review, /DRAFT: not approved/);
  assert.match(review, /left out because Score is blank/);
  assert.match(review, />OPEN</);
});

test('text that looks like a formula is stored as text, and odd characters cannot break the file', () => {
  const bytes = buildXlsx([{ name: 'Bad/Name:*?', rows: [['=HYPERLINK("http://x")', 'a & b < c', 'ctrl\u0001char']] }]);
  const zip = unzipSync(bytes);
  const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
  assert.ok(!sheet.includes('<f>'));
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/x&quot;\)/);
  assert.match(sheet, /a &amp; b &lt; c/);
  assert.match(sheet, /ctrlchar/);
  assert.match(strFromU8(zip['xl/workbook.xml']), /name="Bad Name"/);
});

test('an approved report says so and carries the fingerprints', async () => {
  const result = await run(FLOW.slice(0, 2));
  const assumptions = assumptionsFor(FLOW.slice(0, 2), result);
  const d = emptyDecisions();
  d.accepted[result.exceptions[0].id] = 'Absent; not graded';
  for (const a of assumptions) d.confirmed[a.id] = true;
  const approval = await approve(FLOW.slice(0, 2), result, assumptions, d, 'Jean', Date.UTC(2026, 9, 18));
  const sheets = reportSheets({ flowName: 'x', request: 'y', steps: FLOW.slice(0, 2), result, assumptions, decisions: d, approval, checks: [], madeAt: new Date(0) });
  assert.match(String(sheets[1].rows[0][1]), /^APPROVED by Jean on 2026-10-18/);
  assert.ok(sheets[2].rows.some(r => r[0] === 'Output fingerprint (SHA-256)' && r[1] === approval.outputHash));
  assert.ok(sheets[1].rows.some(r => r[4] === 'Accepted: Absent; not graded'));
});
