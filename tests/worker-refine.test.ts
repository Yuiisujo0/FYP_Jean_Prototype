// The Worker's /api/refine route, with a fake `env.AI`. Part of: npm run test:worker
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { handle, parseRefineBody, resetRateLimit, type Env } from '../worker/src/index.ts';

const STEPS = [
  { type: 'READ_CSV', config: { file: 'marks', delimiter: ',' } },
  { type: 'FILTER', config: { condition: 'score < 50' } },
  { type: 'OUTPUT', config: { format: 'table' } },
];
const said = (steps: typeof STEPS) => ({ response: JSON.stringify({ steps: steps.map(s => ({ type: s.type, ...s.config })) }), usage: { prompt_tokens: 300, completion_tokens: 40, neurons: 4 } });
const CHANGED = said([STEPS[0], { type: 'FILTER', config: { condition: 'score < 40' } }, STEPS[2]]);

function env(script: unknown[] = [CHANGED], extra: Partial<Env> = {}): Env & { calls: { model: string; inputs: any }[] } {
  const calls: { model: string; inputs: any }[] = [];
  return {
    calls,
    AI: { async run(model, inputs) { calls.push({ model, inputs }); const n = script[Math.min(calls.length - 1, script.length - 1)]; if (n instanceof Error) throw n; return n; } },
    ALLOWED_ORIGINS: 'https://app.test', MODELS: '@cf/a,@cf/b', ...extra,
  };
}
const refine = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://w.test/api/refine', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.test', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const good = { steps: STEPS, instruction: 'change the filter to 40' };

beforeEach(() => resetRateLimit());

test('a refine request returns the whole updated workflow and whether anything changed', async () => {
  const e = env();
  const res = await handle(refine({ ...good, datasets: [{ name: 'marks', columns: ['name', 'score'] }] }), e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://app.test');
  const body = await res.json() as any;
  assert.deepEqual(Object.keys(body).sort(), ['attempts', 'elapsedMs', 'issues', 'model', 'neurons', 'nodes', 'unchanged', 'valid']);
  assert.equal(body.unchanged, false);
  assert.equal(body.valid, true);
  assert.equal(body.nodes[1].config.condition, 'score < 40');
  assert.equal(body.nodes[1].name, 'Filter: score < 40');
  assert.equal(e.calls[0].inputs.messages.length, 2);                         // the workflow and the instruction, nothing else
  assert.match(e.calls[0].inputs.messages[0].content, /- marks: columns name, score/);
  assert.match(e.calls[0].inputs.messages[1].content, /Instruction: change the filter to 40$/);
});

test('"unchanged" is reported when the model returns the workflow as it was', async () => {
  const res = await handle(refine(good), env([said(STEPS)]));
  assert.equal(((await res.json()) as any).unchanged, true);
});

test('bad refine requests are refused with a readable message and never reach the AI', async () => {
  const e = env([CHANGED], { MAX_REQUESTS_PER_MINUTE: '1000' });   // this test sends more than the usual 10 requests a minute
  const cases: [unknown, RegExp][] = [
    [{ ...good, instruction: 'hi' }, /few words/],
    [{ ...good, instruction: 'x'.repeat(301) }, /under 300/],
    [{ ...good, instruction: 5 }, /must be text/],
    [{ instruction: 'change it please' }, /list of 1 to 10 steps/],
    [{ ...good, steps: [] }, /list of 1 to 10 steps/],
    [{ ...good, steps: Array(11).fill(STEPS[0]) }, /list of 1 to 10 steps/],
    [{ ...good, steps: [{ config: {} }] }, /type and parameters/],
    [{ ...good, steps: [{ type: 'FILTER', config: { condition: 5 } }] }, /short text/],
    [{ ...good, steps: [{ type: 'FILTER', config: { condition: 'x'.repeat(301) } }] }, /short text/],
    [{ ...good, steps: [{ type: 'FILTER', config: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'])) }] }, /short text/],
    [{ ...good, steps: [{ type: 'FILTER', config: [] }] }, /type and parameters/],
    [{ ...good, datasets: [{ name: 'a' }] }, /name and a list of column names/],
    ['nope', /must be JSON/],
  ];
  for (const [body, message] of cases) {
    const res = await handle(refine(body), e);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 70));
    assert.match(((await res.json()) as any).detail, message);
  }
  assert.equal(e.calls.length, 0);
});

test('a step without parameters is accepted (they default to empty)', () => {
  const parsed = parseRefineBody(JSON.stringify({ steps: [{ type: 'INPUT' }, { type: 'OUTPUT', config: { format: 'table' } }], instruction: 'do nothing' }));
  assert.ok(!('error' in parsed));
  assert.deepEqual((parsed as any).steps[0], { type: 'INPUT', config: {} });
});

test('generate and refine share the rate limit and the kill switch', async () => {
  const e = env([CHANGED], { MAX_REQUESTS_PER_MINUTE: '2' });
  const generate = () => handle(new Request('https://w.test/api/generate', { method: 'POST', headers: { Origin: 'https://app.test', 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify({ prompt: 'read a csv' }) }), e, 1000);
  assert.notEqual((await generate()).status, 429);
  assert.equal((await handle(refine(good, { 'CF-Connecting-IP': '9.9.9.9' }), e, 1001)).status, 200);
  const blocked = await handle(refine(good, { 'CF-Connecting-IP': '9.9.9.9' }), e, 1002);
  assert.equal(blocked.status, 429);

  resetRateLimit();
  const off = env([CHANGED], { AI_ENABLED: 'false' });
  const res = await handle(refine(good), off);
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as any).code, 'disabled');
  assert.equal(off.calls.length, 0);
});

test('refine failures are clear and safe', async () => {
  const quota = await handle(refine(good), env([new Error('4006: you have used up your daily free allocation of 10,000 neurons')]));
  assert.equal(quota.status, 503);
  assert.equal(((await quota.json()) as any).code, 'quota');

  const nonsense = await handle(refine(good), env([{ response: 'nope' }]));
  assert.equal(nonsense.status, 502);

  const leaky = await handle(refine(good), env([new TypeError('secret internal detail at line 42')], { MODELS: '@cf/a' }));
  assert.equal(leaky.status, 503);
  assert.doesNotMatch(JSON.stringify(await leaky.json()), /line 42|secret/);

  const bad = env();
  Object.defineProperty(bad, 'MODELS', { get() { throw new Error('boom with internals'); } });
  const crash = await handle(refine(good), bad);
  assert.equal(crash.status, 500);
  assert.doesNotMatch(JSON.stringify(await crash.json()), /boom/);
});

test('a refine request from an origin that is not allowed is refused', async () => {
  const res = await handle(refine(good, { Origin: 'https://evil.test' }), env());
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

/* ---------------- /api/revise: the agent's observe-and-revise step ---------------- */

const revise = (body: unknown) =>
  new Request('https://w.test/api/revise', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' }, body: JSON.stringify(body) });
const goodRevise = { request: 'Students who scored below 40', steps: STEPS, observation: 'Step 2 (FILTER) 40 rows in, 12 rows out.\nThe result has 12 rows.' };

test('a revise request sends the request and the run report, and returns the revised workflow', async () => {
  const e = env();
  const res = await handle(revise(goodRevise), e);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.unchanged, false);
  assert.equal(body.nodes[1].config.condition, 'score < 40');
  const user = e.calls[0].inputs.messages[1].content as string;
  assert.match(user, /^Request: Students who scored below 40/);
  assert.match(user, /What happened when it ran:\nStep 2 \(FILTER\)/);
});

test('bad revise requests are refused and never reach the AI', async () => {
  const e = env();
  for (const bad of [
    { ...goodRevise, observation: '' },
    { ...goodRevise, observation: 'x'.repeat(2001) },
    { ...goodRevise, request: 'hi' },
    { ...goodRevise, observation: 42 },
    { ...goodRevise, steps: [] },
  ]) {
    const res = await handle(revise(bad), e);
    assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(e.calls.length, 0);
});
