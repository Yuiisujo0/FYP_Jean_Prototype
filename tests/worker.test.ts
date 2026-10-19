// The Cloudflare Worker's HTTP layer, with a fake `env.AI`. Run with: npm run test:worker
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { handle, parseBody, resetRateLimit, type Env } from '../worker/src/index.ts';

const GOOD = JSON.stringify({ steps: [{ type: 'READ_CSV', file: 'marks', delimiter: ',' }, { type: 'FILTER', condition: 'score < 50' }, { type: 'OUTPUT', format: 'table' }] });
const ok = { response: GOOD, usage: { prompt_tokens: 700, completion_tokens: 50, neurons: 5 } };

function env(script: (unknown | Error)[] = [ok], extra: Partial<Env> = {}): Env & { calls: { model: string; inputs: any }[] } {
  const calls: { model: string; inputs: any }[] = [];
  return {
    calls,
    AI: { async run(model, inputs) { calls.push({ model, inputs }); const n = script[Math.min(calls.length - 1, script.length - 1)]; if (n instanceof Error) throw n; return n; } },
    ALLOWED_ORIGINS: 'https://app.test,http://localhost:5173',
    MODELS: '@cf/a,@cf/b',
    ...extra,
  };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://w.test/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.test', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeEach(() => resetRateLimit());

test('health reports the provider and models', async () => {
  const res = await handle(new Request('https://w.test/api/health', { headers: { Origin: 'https://app.test' } }), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', provider: 'workers-ai', models: ['@cf/a', '@cf/b'] });
});

test('CORS: allowed origins pass, others are refused, preflight is answered', async () => {
  const pre = await handle(new Request('https://w.test/api/generate', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } }), env());
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  assert.match(pre.headers.get('Access-Control-Allow-Methods') ?? '', /POST/);
  const bad = await handle(post({ prompt: 'read a csv' }, { Origin: 'https://evil.test' }), env());
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await handle(new Request('https://w.test/api/generate', { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } }), env())).status, 403);
  const star = await handle(post({ prompt: 'read a csv' }, { Origin: 'https://anything.test' }), env([ok], { ALLOWED_ORIGINS: '*' }));
  assert.equal(star.status, 200);
});

test('a good request returns the same shape as the Python backend', async () => {
  const e = env();
  const res = await handle(post({ prompt: 'Which students scored below 50?', datasets: [{ name: 'marks', columns: ['name', 'score'] }] }), e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://app.test');
  const body = await res.json() as any;
  assert.deepEqual(Object.keys(body).sort(), ['attempts', 'elapsedMs', 'flow', 'issues', 'model', 'neurons', 'retrieved', 'valid']);
  assert.equal(body.valid, true);
  assert.equal(body.model, '@cf/a');
  assert.deepEqual(Object.keys(body.attempts[0]).sort(), ['errors', 'evalTokens', 'ms', 'note', 'warnings']);
  assert.deepEqual(body.flow.nodes.map((n: any) => n.type), ['READ_CSV', 'FILTER', 'OUTPUT']);
  assert.match(e.calls[0].inputs.messages[0].content, /- marks: columns name, score/);
});

test('bad requests are refused with a readable message and never reach the AI', async () => {
  const e = env();
  const cases: [unknown, RegExp][] = [
    [{ prompt: 'hi' }, /few words/],
    [{ prompt: 'x'.repeat(501) }, /under 500/],
    [{ prompt: 42 }, /must be text/],
    ['not json', /must be JSON/],
    ['[1,2]', /JSON object/],
    [{ prompt: 'read a csv', datasets: 'nope' }, /list of at most 50/],
    [{ prompt: 'read a csv', datasets: [{ name: 'a', columns: [1] }] }, /name and a list of column names/],
    [{ prompt: 'read a csv', datasets: [{ columns: ['a'] }] }, /name and a list of column names/],
    ['{"prompt":"' + 'a'.repeat(25_000) + '"}', /too large/],
  ];
  for (const [body, message] of cases) {
    const res = await handle(post(body), e);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(((await res.json()) as any).detail, message);
  }
  assert.equal(e.calls.length, 0);
});

test('provider problems give clear, safe messages with the right status', async () => {
  const quota = await handle(post({ prompt: 'read a csv' }), env([new Error('4006: you have used up your daily free allocation of 10,000 neurons')]));
  assert.equal(quota.status, 503);
  const q = await quota.json() as any;
  assert.equal(q.code, 'quota');
  assert.match(q.detail, /editor still works/);

  const down = await handle(post({ prompt: 'read a csv' }), env([new Error('connection reset')]));
  assert.equal(((await down.json()) as any).code, 'unavailable');

  const nonsense = await handle(post({ prompt: 'read a csv' }), env([{ response: 'nope' }]));
  assert.equal(nonsense.status, 502);

  // what the AI service said is never repeated to the caller
  const leaky = env([new TypeError('secret internal detail at line 42')], { MODELS: '@cf/a' });
  const hidden = await handle(post({ prompt: 'read a csv' }), leaky);
  assert.equal(hidden.status, 503);
  assert.doesNotMatch(JSON.stringify(await hidden.json()), /line 42|secret/);
});

test('an unexpected failure in our own code gives a generic 500 without internals', async () => {
  const e = env();
  Object.defineProperty(e, 'MODELS', { get() { throw new Error('boom with internals at line 7'); } });
  const res = await handle(post({ prompt: 'read a csv' }), e);
  assert.equal(res.status, 500);
  const text = JSON.stringify(await res.json());
  assert.match(text, /Something went wrong/);
  assert.doesNotMatch(text, /boom|line 7/);
});

test('the rate limit is per client and clears after a minute', async () => {
  const e = env([ok], { MAX_REQUESTS_PER_MINUTE: '3' });
  const send = (ip: string, now: number) => handle(post({ prompt: 'read a csv' }, { 'CF-Connecting-IP': ip }), e, now);
  for (let i = 0; i < 3; i++) assert.equal((await send('1.1.1.1', 1000 + i)).status, 200);
  const blocked = await send('1.1.1.1', 1500);
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as any).code, 'rate_limited');
  assert.equal((await send('2.2.2.2', 1500)).status, 200);          // someone else is not affected
  assert.equal((await send('1.1.1.1', 62_000)).status, 200);        // a minute later it is allowed again
});

test('the kill switch turns generation off without calling the AI', async () => {
  const e = env([ok], { AI_ENABLED: 'false' });
  const res = await handle(post({ prompt: 'read a csv' }), e);
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as any).code, 'disabled');
  assert.equal(e.calls.length, 0);
});

test('unknown paths are 404 and parseBody trims the prompt', async () => {
  assert.equal((await handle(new Request('https://w.test/nope', { headers: { Origin: 'https://app.test' } }), env())).status, 404);
  assert.deepEqual(parseBody('{"prompt":"  read a csv  "}'), { prompt: 'read a csv', datasets: [] });
});
