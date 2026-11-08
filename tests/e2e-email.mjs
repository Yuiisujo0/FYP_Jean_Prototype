// Drives the real app in Edge/Chromium: the email draft after approval.
// Needs only the frontend (npm run dev), no backend or model. Every run starts with a fresh browser profile.
// Usage: node tests/e2e-email.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const log = (...a) => console.log('[e2e-email]', ...a);
mkdirSync('tests/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const shot = name => page.screenshot({ path: `tests/shots/${name}.png`, fullPage: true });
page.on('pageerror', e => log('page error:', e.message));

const flowFile = 'tests/shots/email-flow.jwork.json';
const step = (id, type, name, config) => ({ id, type, name, description: name, config });
writeFileSync(flowFile, JSON.stringify({
  format: 'jwork.workflow', version: 1, name: 'Low stock list', description: 'Items running low',
  nodes: [
    step('a', 'READ_CSV', 'Read stock', { file: 'stock_list' }),
    step('b', 'FILTER', 'Low stock', { condition: 'stock < 50' }),
    step('c', 'OUTPUT', 'Show', { format: 'table' }),
  ],
}));
const [, ...lines] = readFileSync('sample_data/stock_list.csv', 'utf-8').trim().split(/\r?\n/);
const names = [...new Set(lines.map(l => l.split(',')[1]))];

const recipient = page.getByLabel("Recipient's email address");
const run = async () => {
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByRole('button', { name: /Run workflow|Run again/ }).click();
  await page.locator('.review').waitFor({ timeout: 20000 });
};

try {
  await page.goto(`${base}/knowledge?tab=data`);
  await page.locator('input[type=file]').first().setInputFiles(['sample_data/stock_list.xlsx']);
  await page.locator('.kb__row', { hasText: 'stock_list' }).waitFor();
  await page.goto(`${base}/workflows`);
  await page.getByRole('button', { name: 'Import' }).click();
  await page.locator('.dropzone input[type=file]').setInputFiles(flowFile);
  await page.waitForURL(/\/editor\//);
  await page.getByRole('button', { name: 'How it was done', exact: true }).click();
  await run();

  // 1. Nothing can be emailed before approval.
  assert.equal(await recipient.count(), 0, 'no email box before approval');
  log('before approval there is no email box');

  await page.locator('.review__accept textarea').first().fill('Not counted yet, follow up by hand');
  await page.getByRole('button', { name: 'Accept with this reason' }).click();
  for (const box of await page.locator('.review__check input').all()) await box.check();
  await page.locator('.review__approve input').fill('Aina (test)');
  await page.getByRole('button', { name: 'Approve result' }).click();
  await page.getByText(/Approved by Aina \(test\)/).waitFor();

  // 2. A wrong address cannot go further.
  await recipient.fill('buyer@example');
  assert.equal(await page.getByRole('button', { name: 'Prepare email' }).isDisabled(), true);
  assert.equal(await page.getByRole('link', { name: 'Prepare email' }).count(), 0);
  await recipient.fill('buyer@example.com?bcc=someone@example.com');
  assert.equal(await page.getByRole('link', { name: 'Prepare email' }).count(), 0);
  log('wrong addresses are refused');

  // 3. A good address gives a draft with the approval and no value from the data.
  await recipient.fill('buyer@example.com');
  const link = page.getByRole('link', { name: 'Prepare email' });
  const href = decodeURIComponent(await link.getAttribute('href'));
  assert.match(href, /^mailto:buyer@example\.com\?subject=Approved report: Low stock list&body=/);
  assert.match(href, /low-stock-list-report\.xlsx/);
  assert.match(href, /Approved by Aina \(test\) on /);
  assert.deepEqual(names.filter(n => href.includes(n)), [], 'no item name in the message');
  log(`draft is right; none of the ${names.length} item names is in it`);

  // 4. The button downloads the approved report and says what to do next.
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  assert.equal(download.suggestedFilename(), 'low-stock-list-report.xlsx');
  await page.getByText(/is open in your email app/).waitFor();
  await recipient.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'tests/shots/email-1-prepared.png' });
  log('report downloaded and the next step is shown');

  // The same box on the Result screen, at phone width: the address is readable and nothing runs off the side.
  await page.getByRole('button', { name: 'Result', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await recipient.fill('purchasing.manager@example.com');
  await recipient.scrollIntoViewIfNeeded();
  const box = await recipient.boundingBox();
  assert.ok(box.width > 280, `the address box is ${box.width}px wide`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling');
  await page.screenshot({ path: 'tests/shots/email-2-phone.png' });
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.getByRole('button', { name: 'How it was done', exact: true }).click();
  log('the box fits at phone width');

  // 5. A changed workflow loses its approval, and the email box goes with it.
  await page.locator('.react-flow__node', { hasText: 'Low stock' }).click();
  await page.locator('#cfg-condition').fill('stock < 40');
  await run();
  assert.equal(await recipient.count(), 0, 'no email box once the approval no longer applies');
  log('after the workflow changed the email box is gone');

  log('PASS');
  console.log('\nEMAIL E2E PASSED');
} catch (e) {
  await shot('email-fail').catch(() => {});
  log('FAIL', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
