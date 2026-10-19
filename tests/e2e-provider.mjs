// Settings > AI model in a real browser: switch to Ollama, test the connection, then generate through it (no backend running needed).
// Needs: the frontend (npm run dev) and Ollama with the model below. Usage: node tests/e2e-provider.mjs [frontendUrl] [model]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const model = process.argv[3] ?? 'qwen2.5:7b';
mkdirSync('tests/shots', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const sent = [];
page.on('request', r => { if (r.method() === 'POST') sent.push(r.url()); });
page.on('pageerror', e => console.log('page error:', e.message));

await page.goto(`${base}/settings?tab=model`, { waitUntil: "domcontentloaded" });
await page.getByRole('button', { name: 'Ollama', exact: true }).click();
await page.getByLabel('Ollama model').fill(model);
await page.getByRole('button', { name: 'Test' }).click();
await page.getByText('Connected', { exact: true }).waitFor({ timeout: 10000 });
await page.screenshot({ path: 'tests/shots/provider-ollama.png' });

// a model that is not installed is reported with the fix
await page.getByLabel('Ollama model').fill('not-a-real-model');
await page.getByRole('button', { name: 'Test' }).click();
await page.getByText('ollama pull not-a-real-model').first().waitFor({ timeout: 10000 });
await page.getByLabel('Ollama model').fill(model);

// the choice survives a reload, and the API-key form asks for what it needs
await page.reload();
assert.equal(await page.getByRole('button', { name: 'Ollama', exact: true }).getAttribute('aria-pressed'), 'true');
await page.getByRole('button', { name: 'API key', exact: true }).click();
assert.equal(await page.getByLabel('API key').getAttribute('type'), 'password');
await page.getByRole('button', { name: 'Test' }).click();
await page.getByText(/Enter a model name/).waitFor({ timeout: 5000 });
await page.screenshot({ path: 'tests/shots/provider-key.png' });

// generate through Ollama: the page must call Ollama directly and never the jwork service
await page.getByRole('button', { name: 'Ollama', exact: true }).click();
await page.goto(`${base}/generate`, { waitUntil: "domcontentloaded" });
await page.getByPlaceholder(/Read a CSV of student scores/).fill('Read a CSV of student scores and keep everyone below 50');
await page.getByRole('button', { name: /build workflow/i }).click();
await page.waitForURL(/\/workflows\//, { timeout: 120000 }).catch(() => {});
console.log('POSTs:', [...new Set(sent)]);
assert.ok(sent.some(u => u.includes('11434/v1/chat/completions')), 'called Ollama directly');
assert.ok(!sent.some(u => u.includes(':8000') || u.includes('/api/generate')), 'did not call the jwork service');
console.log('PASS');
await browser.close();
