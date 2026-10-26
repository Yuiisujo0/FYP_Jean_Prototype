// Refining a workflow in plain English: the TypeScript pipeline must match the Python reference, and behave sensibly.
// Golden cases come from backend/eval/golden.json (regenerate with backend\scripts\export_contract.py).
// Part of: npm run test:pipeline
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AiLike } from '../src/pipeline/ai.ts';
import { normalizeConfig } from '../src/pipeline/build.ts';
import { refineMessages, reviseMessages } from '../src/pipeline/prompt.ts';
import { refineWorkflow, reviseWorkflow, type StepInput } from '../src/pipeline/refine.ts';
import type { DatasetBrief } from '../src/pipeline/types.ts';

const golden = JSON.parse(readFileSync('backend/eval/golden.json', 'utf-8')) as {
  refineCases: { taskId: string; steps: StepInput[]; instruction: string; datasets: DatasetBrief[] | null; datasetsLabel: string; messages: unknown[] }[];
  reviseCases: { taskId: string; request: string; steps: StepInput[]; observation: string; datasets: DatasetBrief[] | null; datasetsLabel: string; messages: unknown[] }[];
  normalizeCases: { type: string; config: Record<string, string>; expected: Record<string, string> }[];
};

test('refine prompts are identical to the Python reference (18 cases)', () => {
  assert.equal(golden.refineCases.length, 18);
  for (const c of golden.refineCases) {
    assert.deepEqual(refineMessages(c.steps, c.instruction, c.datasets ?? []), c.messages, `${c.taskId}: “${c.instruction}” (${c.datasetsLabel} datasets)`);
  }
});

test('revise prompts (the agent step) are identical to the Python reference (9 cases)', () => {
  assert.equal(golden.reviseCases.length, 9);
  for (const c of golden.reviseCases) {
    assert.deepEqual(reviseMessages(c.request, c.steps, c.observation, c.datasets ?? []), c.messages, `${c.taskId} (${c.datasetsLabel} datasets)`);
  }
});

test('normalizing a step’s parameters is identical to the Python reference', () => {
  for (const c of golden.normalizeCases) assert.deepEqual(normalizeConfig(c.type, c.config), c.expected, c.type);
});

/* ---------------- the loop, with a fake AI ---------------- */

const STEPS: StepInput[] = [
  { type: 'READ_CSV', config: { file: 'marks', delimiter: ',' } },
  { type: 'FILTER', config: { condition: 'score < 50' } },
  { type: 'OUTPUT', config: { format: 'table' } },
];
const said = (steps: StepInput[]) => ({ response: JSON.stringify({ steps: steps.map(s => ({ type: s.type, ...s.config })) }), usage: { prompt_tokens: 300, completion_tokens: 40, neurons: 4 } });

function fakeAi(...script: unknown[]): AiLike & { calls: { model: string; inputs: any }[] } {
  const calls: { model: string; inputs: any }[] = [];
  return { calls, async run(model, inputs) { calls.push({ model, inputs }); const n = script[Math.min(calls.length - 1, script.length - 1)]; if (n instanceof Error) throw n; return n; } };
}
const options = (ai: AiLike) => ({ ai, models: ['@cf/a', '@cf/b'] });

test('a change comes back as the whole workflow, named, and marked as changed', async () => {
  const changed = [STEPS[0], { type: 'FILTER', config: { condition: 'score < 40' } }, STEPS[2]];
  const ai = fakeAi(said(changed));
  const r = await refineWorkflow(STEPS, 'change the filter to 40', options(ai));
  assert.equal(r.unchanged, false);
  assert.equal(r.valid, true);
  assert.equal(r.neurons, 4);
  assert.equal(r.nodes[1].name, 'Filter: score < 40');
  assert.deepEqual(r.nodes.map(n => n.type), ['READ_CSV', 'FILTER', 'OUTPUT']);
  const sent = ai.calls[0].inputs.messages;
  assert.equal(sent.length, 2);
  assert.match(sent[1].content, /Instruction: change the filter to 40$/);
});

test('the same workflow back is "unchanged", even if the input was written differently', async () => {
  const written = [{ type: 'READ_CSV', config: { file: 'marks' } }, { type: 'FILTER', config: { condition: ' score < 50 ' } }, STEPS[2]];
  const r = await refineWorkflow(written, 'make the world better', options(fakeAi(said(STEPS))));
  assert.equal(r.unchanged, true);
});

test('adding or removing a step counts as a change', async () => {
  const withSelect = [...STEPS.slice(0, 2), { type: 'TRANSFORM', config: { operation: 'select columns name, score' } }, STEPS[2]];
  assert.equal((await refineWorkflow(STEPS, 'keep name and score', options(fakeAi(said(withSelect))))).unchanged, false);
  assert.equal((await refineWorkflow(withSelect, 'drop that', options(fakeAi(said(STEPS))))).unchanged, false);
});

test('an invalid answer is repaired, hotter each time, like in generation', async () => {
  const ai = fakeAi(said([STEPS[0], { ...STEPS[1], config: { condition: '' } }, STEPS[2]]), said(STEPS));
  const r = await refineWorkflow(STEPS, 'blank the filter', options(ai));
  assert.equal(r.attempts.length, 2);
  assert.equal(r.valid, true);
  assert.equal(ai.calls[1].inputs.temperature, 0.5);
  assert.match(ai.calls[1].inputs.messages.at(-1).content, /needs a value for “condition”/);
});

test('when a model is unavailable the next one is used', async () => {
  const r = await refineWorkflow(STEPS, 'change nothing', options(fakeAi(new Error('503'), said(STEPS))));
  assert.equal(r.model, '@cf/b');
});

test('revise: the model sees the request and the run report, and its fix comes back as the whole workflow', async () => {
  const fixed = [STEPS[0], { type: 'FILTER', config: { condition: 'score < 60' } }, STEPS[2]];
  const ai = fakeAi(said(fixed));
  const r = await reviseWorkflow('Students below 60', STEPS, 'The result has 0 rows.', options(ai));
  assert.equal(r.unchanged, false);
  assert.equal(r.valid, true);
  const user = ai.calls[0].inputs.messages[1].content as string;
  assert.match(user, /^Request: Students below 60\n\nCurrent workflow:/);
  assert.match(user, /What happened when it ran:\nThe result has 0 rows\.$/);
  assert.equal((await reviseWorkflow('Students below 50', STEPS, 'The result has 3 rows.', options(fakeAi(said(STEPS))))).unchanged, true);
});
