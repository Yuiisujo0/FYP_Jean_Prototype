// Drives the real app: the Patterns tab shows the workflow patterns the AI is really given, and says what is not sent to it.
// Needs only the frontend (npm run dev). Usage: node tests/e2e-patterns.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const log = (...a) => console.log('[e2e-patterns]', ...a);
mkdirSync('tests/shots', { recursive: true });

// The truth to compare with: the library the generator actually uses (generated from the Python reference).
const lib = JSON.parse(readFileSync('backend/eval/tasks.json', 'utf8')).tasks.filter(t => t.split === 'library');

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const shot = name => page.screenshot({ path: `tests/shots/${name}.png` });
page.on('console', m => m.type() === 'error' && log('browser console error:', m.text()));
page.on('pageerror', e => log('page error:', e.message));

try {
  await page.goto(`${base}/knowledge`);
  await page.locator('.kb__row').first().waitFor();
  const rows = await page.locator('.kb__row').count();
  const patternTitles = await page.locator('.kb__row', { has: page.locator('svg.lucide-workflow') }).locator('b').allInnerTexts();
  assert.equal(patternTitles.length, lib.length, 'every library pattern is listed');
  assert.deepEqual(patternTitles.sort(), lib.map(t => t.title).sort());
  log(`${patternTitles.length} workflow patterns listed (the library has ${lib.length}), ${rows - patternTitles.length} notes`);
  await page.getByText(/shown to the AI as examples, and 6 notes for reading/).waitFor();

  // A pattern: badges, plain-English steps, and the request can be tried.
  const s3 = lib.find(t => t.id === 'S3');
  await page.locator('.kb__row', { hasText: s3.title }).click();
  await page.getByText('Shown to the AI', { exact: true }).waitFor();
  await page.getByText('Checked on sample data', { exact: true }).waitFor();
  await page.getByText(`A user might type: “${s3.request}”`).waitFor();
  const steps = await page.locator('.kb__steps li').allInnerTexts();
  assert.equal(steps.length, s3.steps.length);
  assert.ok(steps.some(t => /Keeps only the rows where .*course is CS101 and attendance_pct is less than 70/.test(t.replace(/\s+/g, ' '))), steps.join(' | '));
  await shot('p1-pattern');
  log('pattern detail shows its request and its steps in plain English');

  // An example that cannot be checked offline says so.
  const u1 = lib.find(t => t.id === 'U1');
  await page.locator('.kb__row', { hasText: u1.title }).click();
  await page.getByText('Example only', { exact: true }).waitFor();
  log('an HTTP example is labelled "Example only"');

  // A note is labelled as not sent to the AI.
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.locator('.kb__row').first().click();
  await page.getByText('Reading only', { exact: true }).waitFor();
  await page.getByText('This note is for you. It is not sent to the AI.').waitFor();
  assert.equal(await page.locator('.kb__row svg.lucide-workflow').count(), 0, 'the Notes filter shows no patterns');
  log('notes are labelled "Reading only" and are filtered apart from patterns');

  // Try this request opens Generate with the text filled in.
  await page.getByRole('button', { name: 'Workflow patterns', exact: true }).click();
  await page.locator('.kb__row', { hasText: s3.title }).click();
  await page.getByRole('button', { name: 'Try this request' }).click();
  await page.waitForURL(/\/generate/);
  assert.equal(await page.locator('#prompt').inputValue(), s3.request);
  log('"Try this request" opens Generate with the request typed in');

  // Search works across both kinds.
  await page.goto(`${base}/knowledge`);
  await page.getByLabel('Search knowledge').fill('rename');
  await page.locator('.kb__row').first().waitFor();
  const found = await page.locator('.kb__row').allInnerTexts();
  const expectedHits = lib.filter(t => `${t.title} ${t.request}`.toLowerCase().includes('rename')).length;
  assert.ok(found.length >= expectedHits && found.length > 0 && found.every(t => /rename/i.test(t)), found.join(' | '));
  log(`search "rename" finds ${found.length} entries (${expectedHits} patterns mention it)`);

  console.log('\nPATTERNS E2E PASSED');
} catch (e) {
  await shot('p-failure').catch(() => {});
  console.error('\nPATTERNS E2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
