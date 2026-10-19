// Run with: npm run test:consensus
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickByAgreement } from '../src/lib/consensus.ts';
import type { AgentDeps } from '../src/lib/agent.ts';
import type { RunResult, Step } from '../src/types.ts';

const step = (type: string, config: Record<string, string> = {}): Step => ({ id: type, type, name: type, description: '', config });
/** A candidate is identified by the label in its OUTPUT step; the fake test looks the label up. */
const cand = (label: string): Step[] => [step('READ_CSV', { file: 'x' }), step('OUTPUT', { format: label })];
const label = (s: Step[]) => s[s.length - 1].config.format;

function resultOf(rows: Record<string, string>[], rowsIn = 5): RunResult {
  return {
    columns: ['a'], rows, trace: [{ stepId: 'READ_CSV', type: 'READ_CSV', rowsIn: 0, rowsOut: rowsIn }, { stepId: 'OUTPUT', type: 'OUTPUT', rowsIn, rowsOut: rows.length }],
    exceptions: [], input: { columns: ['a'], rows: [] }, register: [],
  } as unknown as RunResult;
}
const table = (...vals: string[]) => vals.map(a => ({ a }));

function fake(map: Record<string, ReturnType<AgentDeps['test']> | RunResult | { error: string } | { blocked: string }>): AgentDeps['test'] {
  return async steps => {
    const v = map[label(steps)] as RunResult | { error: string } | { blocked: string };
    if ('error' in v || 'blocked' in v) return v;
    return { result: v };
  };
}

test('the table most candidates return wins', async () => {
  const p = await pickByAgreement([cand('x'), cand('y'), cand('z')], fake({ x: resultOf(table('1')), y: resultOf(table('2', '3')), z: resultOf(table('2', '3')) }));
  assert.equal(p.index, 1);
  assert.equal(p.reason, 'majority');
  assert.deepEqual(p.judged.map(j => j.votes), [1, 2, 2]);
});

test('a tie goes to the earliest candidate', async () => {
  const p = await pickByAgreement([cand('x'), cand('y'), cand('z')], fake({ x: resultOf(table('1')), y: resultOf(table('2')), z: resultOf(table('3')) }));
  assert.equal(p.index, 0);
  assert.equal(p.reason, 'tie');
});

test('candidates that error or return nothing do not vote', async () => {
  const p = await pickByAgreement([cand('x'), cand('y'), cand('z')], fake({ x: { error: 'There is no column "q".' }, y: resultOf([]), z: resultOf(table('7')) }));
  assert.equal(p.index, 2);
  assert.equal(p.reason, 'single');
  assert.deepEqual(p.judged.map(j => j.verdict), ['error', 'flagged', 'ok']);
});

test('when none runs cleanly the first is kept for the agent to revise', async () => {
  const p = await pickByAgreement([cand('x'), cand('y')], fake({ x: { error: 'bad' }, y: resultOf([]) }));
  assert.equal(p.index, 0);
  assert.equal(p.reason, 'none');
});

test('a workflow that cannot be tested here (a web request) is left as it is', async () => {
  const p = await pickByAgreement([cand('x'), cand('y')], fake({ x: { blocked: 'web' }, y: { blocked: 'web' } }));
  assert.equal(p.index, 0);
  assert.equal(p.reason, 'untestable');
});

test('the same rows in a different order are a different answer', async () => {
  const p = await pickByAgreement([cand('x'), cand('y'), cand('z')], fake({ x: resultOf(table('1', '2')), y: resultOf(table('2', '1')), z: resultOf(table('2', '1')) }));
  assert.equal(p.index, 1);
});
