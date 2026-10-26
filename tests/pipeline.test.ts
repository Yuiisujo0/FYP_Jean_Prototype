// The TypeScript pipeline (src/pipeline) must behave exactly like the Python reference (backend/app).
// backend/eval/golden.json holds inputs and the outputs Python produced. Regenerate it with:
//   backend\.venv\Scripts\python backend\scripts\export_contract.py
// Run with: npm run test:pipeline
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GenerationFailed, ModelOutputError, ProviderUnavailable, parseAiResult, type AiLike } from '../src/pipeline/ai.ts';
import { buildFlow } from '../src/pipeline/build.ts';
import { generateWorkflow } from '../src/pipeline/generate.ts';
import { buildMessages, repairMessage } from '../src/pipeline/prompt.ts';
import { retrievePatterns } from '../src/pipeline/retrieval.ts';
import { contract } from '../src/pipeline/contract.ts';
import type { DatasetBrief } from '../src/pipeline/types.ts';

const golden = JSON.parse(readFileSync('backend/eval/golden.json', 'utf-8')) as {
  promptCases: { prompt: string; datasets: DatasetBrief[] | null; datasetsLabel: string; retrievedIds: string[]; messages: unknown[] }[];
  buildCases: { prompt: string; steps: Record<string, string>[]; expected: { name: string; description: string; edgeCount: number; nodes: Record<string, unknown>[] } }[];
  repairMessage: { issues: { level: 'ERROR' | 'WARNING'; message: string }[]; expected: string };
};

test('retrieval and prompts are identical to the Python reference (99 cases)', () => {
  assert.equal(golden.promptCases.length, 99);
  for (const c of golden.promptCases) {
    const retrieved = retrievePatterns(c.prompt, contract.patterns);
    assert.deepEqual(retrieved.map(r => r.id), c.retrievedIds, `retrieved examples for “${c.prompt}”`);
    assert.deepEqual(buildMessages(c.prompt, retrieved, c.datasets ?? []), c.messages, `messages for “${c.prompt}” (${c.datasetsLabel} datasets)`);
  }
});

test('workflows are built exactly as the Python reference builds them', () => {
  for (const c of golden.buildCases) {
    const flow = buildFlow({ steps: c.steps }, c.prompt);
    assert.equal(flow.name, c.expected.name);
    assert.equal(flow.description, c.expected.description);
    assert.equal(flow.edges.length, c.expected.edgeCount);
    assert.deepEqual(flow.nodes.map(({ type, name, description, config, position }) => ({ type, name, description, config, position })), c.expected.nodes, c.prompt);
    assert.equal(new Set(flow.nodes.map(n => n.id)).size, flow.nodes.length, 'ids are unique');
  }
});

test('the repair message is identical', () => {
  assert.equal(repairMessage(golden.repairMessage.issues as never), golden.repairMessage.expected);
});

test('the contract carries the schema, catalogue, example and library', () => {
  assert.equal(contract.kinds.length, 9);
  assert.equal(contract.patterns.length, 17);
  assert.match(contract.catalogueWithHints, /It is not SQL/);
  assert.doesNotMatch(contract.catalogueWithoutHints, /It is not SQL/);
});

/* ---------------- the generation loop, with a fake AI ---------------- */

const GOOD = JSON.stringify({ steps: [{ type: 'READ_CSV', file: 'marks', delimiter: ',' }, { type: 'FILTER', condition: 'score < 50' }, { type: 'OUTPUT', format: 'table' }] });
const BLANK_FILTER = JSON.stringify({ steps: [{ type: 'READ_CSV', file: 'marks', delimiter: ',' }, { type: 'FILTER', condition: '' }, { type: 'OUTPUT', format: 'table' }] });
const reply = (content: string, neurons = 5) => ({ response: content, usage: { prompt_tokens: 700, completion_tokens: 50, neurons } });

/** A fake AI that answers from a script: each item is a result, or an Error to throw. */
function fakeAi(script: (unknown | Error)[]): AiLike & { calls: { model: string; inputs: any }[] } {
  const calls: { model: string; inputs: any }[] = [];
  return {
    calls,
    async run(model, inputs) {
      calls.push({ model, inputs });
      const next = script[Math.min(calls.length - 1, script.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
const MODELS = ['@cf/primary', '@cf/fallback'];

test('a good first answer is used as is', async () => {
  const ai = fakeAi([reply(GOOD)]);
  const r = await generateWorkflow('Which students scored below 50?', { ai, models: MODELS });
  assert.equal(r.valid, true);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.model, '@cf/primary');
  assert.equal(r.neurons, 5);
  assert.deepEqual(r.flow.nodes.map(n => n.type), ['READ_CSV', 'FILTER', 'OUTPUT']);
  assert.equal(ai.calls[0].inputs.temperature, 0.1);
  assert.deepEqual(ai.calls[0].inputs.response_format.json_schema, contract.schema);
});

test('validation errors are sent back and the model repairs, hotter each time', async () => {
  const ai = fakeAi([reply(BLANK_FILTER), reply(GOOD)]);
  const r = await generateWorkflow('x y z', { ai, models: MODELS });
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].errors, 1);
  assert.equal(r.valid, true);
  assert.equal(ai.calls[1].inputs.temperature, 0.5);
  const last = ai.calls[1].inputs.messages.at(-1);
  assert.match(last.content, /needs a value for “condition”/);
});

test('a workflow without an OUTPUT step gets one, with no repair call, and keeps its last step', async () => {
  const ai = fakeAi([reply(JSON.stringify({ steps: [{ type: 'READ_CSV', file: 'marks', delimiter: ',' }, { type: 'DATABASE', table: 'failed' }] }))]);
  const r = await generateWorkflow('save the marks', { ai, models: MODELS });
  assert.equal(r.attempts.length, 1);
  assert.equal(r.valid, true);
  assert.deepEqual(r.flow.nodes.map(n => n.type), ['READ_CSV', 'DATABASE', 'OUTPUT']);
});

test('output the provider rejects, or that is not the expected JSON, is retried', async () => {
  const ai = fakeAi([new Error("JSON Mode couldn't be met"), reply('not json at all'), reply(JSON.stringify({ steps: [{ type: 'OUTPUT', format: 1 }] })), reply(GOOD)]);
  const r = await generateWorkflow('x', { ai, models: MODELS, maxRepairs: 3 });
  assert.equal(r.attempts.length, 4);
  assert.match(r.attempts[0].note, /rejected by provider/);
  assert.equal(r.attempts[1].note, 'unparseable');
  assert.equal(r.attempts[2].note, 'unparseable');   // a number where a string is required
  assert.equal(r.valid, true);
});

test('when the first model is unavailable the next one answers', async () => {
  const ai = fakeAi([new Error('503 service unavailable'), reply(GOOD)]);
  const r = await generateWorkflow('x', { ai, models: MODELS });
  assert.equal(r.model, '@cf/fallback');
  assert.deepEqual(ai.calls.map(c => c.model), ['@cf/primary', '@cf/fallback']);
});

test('when every model is out of quota the caller is told so', async () => {
  const ai = fakeAi([new Error('4006: you have used up your daily free allocation of 10,000 neurons')]);
  await assert.rejects(generateWorkflow('x', { ai, models: MODELS }), (e: unknown) => e instanceof ProviderUnavailable && e.quota === true);
  const down = fakeAi([new Error('connection reset')]);
  await assert.rejects(generateWorkflow('x', { ai: down, models: MODELS }), (e: unknown) => e instanceof ProviderUnavailable && e.quota === false);
});

test('a model that never produces a usable workflow ends in GenerationFailed', async () => {
  const ai = fakeAi([reply('nope')]);
  await assert.rejects(generateWorkflow('x', { ai, models: MODELS }), GenerationFailed);
  assert.equal(ai.calls.length, 3);   // the first try and two repairs
});

test('both Workers AI reply shapes are understood', () => {
  assert.equal(parseAiResult({ response: '{"a":1}' }).content, '{"a":1}');
  assert.equal(parseAiResult({ response: { a: 1 } }).content, '{"a":1}');
  const chat = parseAiResult({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 4, neurons: 1.5 } });
  assert.deepEqual([chat.content, chat.promptTokens, chat.completionTokens, chat.neurons], ['hi', 3, 4, 1.5]);
  assert.throws(() => parseAiResult({}), ModelOutputError);
});

test('datasets reach the prompt as names and columns only', async () => {
  const ai = fakeAi([reply(GOOD)]);
  await generateWorkflow('x', { ai, models: MODELS, datasets: [{ name: 'marks', columns: ['name', 'score'] }] });
  const system = ai.calls[0].inputs.messages[0].content as string;
  assert.match(system, /- marks: columns name, score/);
});
