// The first visit in a fresh browser: no borrowed name, the starter workflows, sample data in one click, an example
// request generated, and the purpose-first Result view (answer, what the AI understood, what needs your eye, approve).
// Needs the frontend and an AI service. Against the hosted Worker (costs about 30 neurons per generate):
//   VITE_API_URL=https://jwork-ai.jwork-fyp.workers.dev npx vite   then   node tests/e2e-result.mjs
// Usage: node tests/e2e-result.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const log = (...a) => console.log('[e2e-result]', ...a);
mkdirSync('tests/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: process.env.PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const shot = name => page.screenshot({ path: `tests/shots/${name}.png`, fullPage: true });
page.on('pageerror', e => log('page error:', e.message));

try {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1.welcome').waitFor();
  // The landing cover is skipped in some browsers (reduced motion, no WebGL); close it when it is there.
  const enter = page.getByRole('button', { name: 'Enter your workspace' });
  if (await enter.count()) { await enter.click(); await page.locator('.landing').waitFor({ state: 'detached' }); }

  // An honest first screen.
  const heading = await page.locator('h1.welcome').innerText();
  assert.equal(heading.trim(), 'Welcome to jwork');
  assert.equal(await page.getByText('Jean').count(), 0, 'nobody is greeted by the author\'s name');
  await page.getByText('Student score review').waitFor();
  await shot('result-01-dashboard');
  log('dashboard: no name; the three starter workflows are there');

  // Sample data, then an example request.
  await page.goto(`${base}/generate`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add sample data' }).click();
  await page.getByText(/Added 4 sample datasets/).waitFor();
  await page.getByRole('button', { name: 'Add sample data' }).waitFor({ state: 'detached' });
  const example = process.env.EXAMPLE ?? 'From employees, list everyone in Sales earning over 6000, highest salary first';
  await page.getByRole('button', { name: example }).click();
  const started = Date.now();
  await page.getByRole('button', { name: 'Build workflow' }).click();
  await page.waitForURL(/\/editor\//, { timeout: 120_000 });
  log(`generated in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // The Result view, run without asking because the steps only read and reshape data.
  await page.locator('.rv').waitFor();
  await page.locator('.review__totals').waitFor({ timeout: 30_000 });
  const totals = (await page.locator('.review__totals').innerText()).replace(/\s+/g, ' ');
  log('totals:', totals);
  assert.match(totals, /Every row is accounted for/);
  assert.match(await page.locator('.rv__request').innerText(), /You asked/i);
  const sections = await page.locator('.rv__sec h2').allInnerTexts();
  log('sections:', sections.map(s => s.replace(/\s+/g, ' ')).join(' | '));
  assert.equal(sections.length, 4);
  const rows = await page.locator('.rv__table tbody tr').count();
  log('rows in the answer:', rows);
  log('understood:', (await page.locator('.rv__explain').innerText()).replace(/\n/g, ' / '));
  await shot('result-02-result-view');

  // Approve if nothing blocks it, then the report.
  const approve = page.getByRole('button', { name: 'Approve result' });
  for (const box of await page.locator('.review__check input').all()) await box.check();
  await page.locator('.review__approve input').fill('Test reviewer');
  if (await approve.isEnabled()) {
    await approve.click();
    await page.getByText(/Approved by Test reviewer/).waitFor();
    log('approved');
  } else {
    log('approval blocked:', (await page.locator('.review__blockers').innerText()).replace(/\n/g, ' / '));
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download report/ }).click()]);
  log('report:', download.suggestedFilename());

  // The canvas is one click away and still has its tools.
  await page.getByRole('button', { name: 'How it was done', exact: true }).click();
  await page.locator('.react-flow__node').first().waitFor();
  await page.getByRole('tab', { name: /Check/ }).click();
  await shot('result-03-steps');
  await page.getByRole('button', { name: 'Result', exact: true }).click();
  await page.locator('.review__totals').waitFor();
  log('switched to the steps and back');

  log('PASS');
} catch (e) {
  await shot('result-failure').catch(() => {});
  log('FAIL', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
