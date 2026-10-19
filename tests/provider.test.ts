// The browser-side providers (Ollama / own API key): the OpenAI-compatible adapter and the pipeline running through it.
// Run with: npm run test:provider
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderUnavailable } from '../src/pipeline/ai.ts';
import { generateWorkflow } from '../src/pipeline/generate.ts';
import { cleanBaseUrl, openAiCompatible } from '../src/pipeline/openaiAi.ts';
import { ollamaApiBase, providerProblem, DEFAULT_PROVIDER } from '../src/lib/providerConfig.ts';

const GOOD = JSON.stringify({ steps: [{ type: 'READ_CSV', file: 'marks', delimiter: ',' }, { type: 'FILTER', condition: 'score < 50' }, { type: 'OUTPUT', format: 'table' }] });
const completion = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });

function fake(replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('addresses are normalised', () => {
  assert.equal(cleanBaseUrl(' https://x.test/v1/// '), 'https://x.test/v1');
  assert.equal(ollamaApiBase('http://localhost:11434/'), 'http://localhost:11434/v1');
  assert.equal(ollamaApiBase('http://localhost:11434/v1'), 'http://localhost:11434/v1');
});

test('the request is sent in the OpenAI format with the key and the wrapped schema', async () => {
  const { calls, fetchImpl } = fake([completion(GOOD)]);
  const ai = openAiCompatible({ baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-test', fetchImpl });
  const out = await ai.run('m', { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_schema', json_schema: { type: 'object' } }, temperature: 0.1, max_tokens: 1200, reasoning: { effort: 'low' } });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_schema', json_schema: { name: 'workflow', schema: { type: 'object' } } });
  assert.equal(calls[0].body.max_tokens, 1200);
  assert.equal('reasoning' in calls[0].body, false, 'Workers-only fields are not forwarded');
  assert.equal(calls[0].body.model, 'm');
  assert.ok(out);
});

test('no key means no Authorization header (Ollama); the real OpenAI API gets max_completion_tokens', async () => {
  const a = fake([completion(GOOD)]);
  await openAiCompatible({ baseUrl: 'http://localhost:11434/v1', fetchImpl: a.fetchImpl }).run('m', { messages: [], max_tokens: 5 });
  assert.equal('Authorization' in (a.calls[0].init.headers as object), false);
  const b = fake([completion(GOOD)]);
  await openAiCompatible({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', fetchImpl: b.fetchImpl }).run('m', { messages: [], max_tokens: 5 });
  assert.equal(b.calls[0].body.max_completion_tokens, 5);
  assert.equal('max_tokens' in b.calls[0].body, false);
});

test('an error status carries the provider message', async () => {
  const { fetchImpl } = fake([new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 })]);
  await assert.rejects(openAiCompatible({ baseUrl: 'https://x.test/v1', apiKey: 'bad', fetchImpl }).run('m', { messages: [] }), /status 401: Incorrect API key/);
});

test('the generate pipeline works end to end through the adapter', async () => {
  const { calls, fetchImpl } = fake([completion(GOOD)]);
  const r = await generateWorkflow('Find students who scored below 50', { ai: openAiCompatible({ baseUrl: 'http://localhost:11434/v1', fetchImpl }), models: ['qwen2.5:7b'], datasets: [{ name: 'marks', columns: ['name', 'score'] }] });
  assert.equal(r.valid, true);
  assert.deepEqual(r.flow.nodes.map(n => n.type), ['READ_CSV', 'FILTER', 'OUTPUT']);
  assert.equal(r.model, 'qwen2.5:7b');
  // privacy: only names and column names, in the prompt that left the browser
  assert.match(JSON.stringify(calls[0].body.messages), /marks/);
});

test('an unreachable server or a rejected key becomes ProviderUnavailable; a 429 reads as quota', async () => {
  const down = fake([new TypeError('Failed to fetch')]);
  await assert.rejects(generateWorkflow('read a csv and count', { ai: openAiCompatible({ baseUrl: 'http://localhost:11434/v1', fetchImpl: down.fetchImpl }), models: ['m'] }), (e: unknown) => e instanceof ProviderUnavailable && !e.quota && !/status \d{3}/.test(e.message));
  const limited = fake([new Response('{"error":{"message":"Rate limit"}}', { status: 429 })]);
  await assert.rejects(generateWorkflow('read a csv and count', { ai: openAiCompatible({ baseUrl: 'https://x.test/v1', apiKey: 'k', fetchImpl: limited.fetchImpl }), models: ['m'] }), (e: unknown) => e instanceof ProviderUnavailable && e.quota);
});

test('a provider is only usable when it has what it needs', () => {
  assert.equal(providerProblem(DEFAULT_PROVIDER), null);
  assert.equal(providerProblem({ ...DEFAULT_PROVIDER, kind: 'ollama' }), null);
  assert.match(providerProblem({ ...DEFAULT_PROVIDER, kind: 'custom', customModel: '' }) ?? '', /model/i);
  assert.match(providerProblem({ ...DEFAULT_PROVIDER, kind: 'custom' }) ?? '', /key/i);
  assert.equal(providerProblem({ ...DEFAULT_PROVIDER, kind: 'custom', customModel: 'x', customKey: 'k' }), null);
});
