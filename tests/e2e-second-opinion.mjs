// Drives the real app in Edge/Chromium with two fake models behind an API address: plans that disagree, agree, and a second
// model that fails, then no second model at all. Needs only the frontend (npm run dev), no backend or model. Every run starts with a fresh browser profile.
// Usage: node tests/e2e-second-opinion.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const log = (...a) => console.log('[e2e-second-opinion]', ...a);
mkdirSync('tests/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', e => log('page error:', e.message));

const planOf = condition => JSON.stringify({ steps: [{ type: 'READ_CSV', file: 'stock_list', delimiter: ',' }, { type: 'FILTER', condition }, { type: 'OUTPUT', format: 'table' }] });
const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
let plans = {};
let asked = [];
await context.route('https://fake-ai.test/**', async route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  if (route.request().method() === 'GET') return route.fulfill({ status: 200, headers, body: JSON.stringify({ data: [{ id: 'main-model' }] }) });
  const { model } = route.request().postDataJSON();
  asked.push(model);
  const condition = plans[model];
  if (condition === 'fail') return route.fulfill({ status: 503, headers, body: JSON.stringify({ error: { message: 'Out of allowance' } }) });
  return route.fulfill({ status: 200, headers, body: JSON.stringify({ choices: [{ message: { content: planOf(condition) } }], usage: {} }) });
});

const settings = async second => {
  await page.goto(`${base}/settings?tab=model`);
  await page.getByRole('button', { name: 'API key', exact: true }).click();
  await page.getByLabel('API address').fill('https://fake-ai.test/v1');
  await page.getByLabel('Model name').fill('main-model');
  await page.getByLabel('API key', { exact: true }).fill('test-key');
  await page.getByLabel('Second opinion model').fill(second);
};
const build = async (first, second) => {
  plans = { 'main-model': first, 'second-model': second };
  asked = [];
  await page.goto(`${base}/generate`);
  await page.locator('#prompt').fill('Show the items running low');
  await page.getByRole('button', { name: 'Build workflow' }).click();
  await page.waitForURL(/\/editor\//, { timeout: 20000 });
};
const run = async () => {
  await page.getByRole('button', { name: 'How it was done', exact: true }).click();
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByRole('button', { name: /Run workflow|Run again/ }).click();
  await page.locator('.review').waitFor({ timeout: 20000 });
};
const secondOpinionItem = page.locator('.review__ex', { hasText: 'by another model' });

try {
  await page.goto(`${base}/knowledge?tab=data`);
  await page.locator('input[type=file]').first().setInputFiles(['sample_data/stock_list.xlsx']);
  await page.locator('.kb__row', { hasText: 'stock_list' }).waitFor();

  await settings('second-model');

  // 1. Two plans, two answers: a critical item, and approval waits for a reason.
  await build('stock < 50', 'stock < 40');
  assert.ok(asked.indexOf('second-model') > asked.indexOf('main-model'), 'the second plan comes from the second model');
  await run();
  await secondOpinionItem.waitFor();
  const message = await secondOpinionItem.innerText();
  assert.match(message, /gave a different answer: this workflow found 13 rows, the second plan \d+ rows/);
  assert.match(message, /stock is less than 40/);
  log('different answers show as a critical item:', message.split('\n')[2]?.slice(0, 90));

  const approveBtn = page.getByRole('button', { name: 'Approve result' });
  for (const box of await page.locator('.review__check input').all()) await box.check();
  await page.locator('.review__approve input').fill('Aina (test)');
  await page.locator('.review__ex', { hasText: 'stock is blank' }).locator('textarea').fill('Not counted yet, follow up by hand');
  await page.locator('.review__ex', { hasText: 'stock is blank' }).getByRole('button', { name: 'Accept with this reason' }).click();
  assert.equal(await approveBtn.isDisabled(), true, 'approval stays closed until the disagreement has a reason');
  await page.screenshot({ path: 'tests/shots/second-opinion-1-blocked.png' });

  await secondOpinionItem.locator('textarea').fill('Under 50 is what purchasing uses');
  await secondOpinionItem.getByRole('button', { name: 'Accept with this reason' }).click();
  await approveBtn.click();
  await page.getByText(/Approved by Aina \(test\)/).waitFor();
  log('approval opened only after the disagreement was accepted with a reason');

  // 2. The report records it.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download report \(Excel\)/ }).click()]);
  const zip = unzipSync(new Uint8Array(readFileSync(await download.path())));
  const text = Object.keys(zip).filter(n => n.startsWith('xl/worksheets/')).map(n => strFromU8(zip[n])).join(' ');
  assert.match(text, /gave a different answer/);
  assert.match(text, /Under 50 is what purchasing uses/);
  log('the report records the disagreement and the reason');

  // 3. A changed workflow no longer carries that opinion.
  await page.locator('.react-flow__node').nth(1).click();
  await page.locator('#cfg-condition').fill('stock < 30');
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByRole('button', { name: /Run workflow|Run again/ }).click();
  await page.locator('.review').waitFor({ timeout: 20000 });
  assert.equal(await secondOpinionItem.count(), 0, 'the opinion was about the old workflow');
  log('after the workflow changed the disagreement is gone');

  // 4. Two plans, one answer: no item, a plain note.
  await build('stock < 50', 'stock <= 49');
  await page.getByText('A second plan, by another model, gave the same answer.').waitFor();
  await run();
  assert.equal(await secondOpinionItem.count(), 0);
  log('agreement is a note, not an item to accept');

  // 5. The same plan twice does not claim agreement.
  await build('stock < 50', 'stock < 50');
  await page.getByText(/The second model wrote the same plan, so it adds little evidence/).waitFor();
  log('the same plan twice says so');

  // 6. A failed second plan does not stop the workflow.
  await build('stock < 50', 'fail');
  await page.getByText(/No second opinion/).waitFor();
  log('a failed second plan still opens the workflow');

  // 7. No second model, or the same model twice: no extra AI calls and nothing about a second opinion.
  for (const second of ['', 'main-model']) {
    await settings(second);
    await build('stock < 50', 'stock < 40');
    assert.ok(asked.every(m => m === 'main-model'), `no call for a second plan with "${second}"`);
    await page.getByRole('button', { name: 'How it was done', exact: true }).click();
    assert.equal(await page.getByText(/second (plan|model|opinion)/i).count(), 0);
  }
  log('without a second model there is no second opinion and no extra call');

  log('PASS');
  console.log('\nSECOND OPINION E2E PASSED');
} catch (e) {
  await page.screenshot({ path: 'tests/shots/second-opinion-fail.png', fullPage: true }).catch(() => {});
  log('FAIL', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
