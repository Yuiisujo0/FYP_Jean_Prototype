// Drives the real app in Edge/Chromium: the Database step's modes and the split between uploads and saved results.
// Needs only the frontend (npm run dev), no backend or model. Every run starts with a fresh browser profile.
// Usage: node tests/e2e-database.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const log = (...a) => console.log('[e2e-database]', ...a);
mkdirSync('tests/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const shot = name => page.screenshot({ path: `tests/shots/${name}.png` });
page.on('console', m => m.type() === 'error' && log('browser console error:', m.text()));
page.on('pageerror', e => log('page error:', e.message));

const library = () => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('jwork-data', 1);
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const tx = req.result.transaction(['info', 'rows']);
    const info = tx.objectStore('info').getAll();
    info.onsuccess = () => {
      const out = [];
      let left = info.result.length;
      if (!left) resolve(out);
      for (const d of info.result) {
        const r = tx.objectStore('rows').get(d.id);
        r.onsuccess = () => { out.push({ name: d.name, origin: d.origin, rows: r.result.length, columns: d.columns }); if (!--left) resolve(out); };
      }
    };
  };
}));
const find = async name => (await library()).find(d => d.name === name);

const flowFile = 'tests/shots/db-flow.jwork.json';
const step = (id, type, name, config) => ({ id, type, name, description: name, config });
writeFileSync(flowFile, JSON.stringify({
  format: 'jwork.workflow', version: 1, name: 'Log low scores', description: 'Adds low scores to a log',
  nodes: [
    step('a', 'READ_CSV', 'Read marks', { file: 'student_marks' }),
    step('b', 'FILTER', 'Low scores', { condition: 'score < 50' }),
    step('c', 'DATABASE', 'Log them', { table: 'low_log', mode: 'append' }),
    step('d', 'OUTPUT', 'Show', { format: 'table' }),
  ],
}));

const runAndWait = async () => {
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByText(/Ran 4 steps|stopped the run/).first().waitFor({ timeout: 15000 });
};


/** A workflow opens on its Result; the canvas and its tabs are under "How it was done". */
const toSteps = async () => {
  const b = page.getByRole('button', { name: 'How it was done', exact: true });
  await b.waitFor();
  if (await b.getAttribute('aria-pressed') !== 'true') await b.click();
};
try {
  // 1. Upload data, import a workflow whose Database step appends.
  await page.goto(`${base}/knowledge?tab=data`);
  await page.getByText('No data yet').waitFor();
  await page.locator('input[type=file]').first().setInputFiles(['sample_data/student_marks.xlsx', 'sample_data/courses.xlsx']);
  await page.locator('.kb__row', { hasText: 'courses' }).waitFor();
  const marks = await find('student_marks');
  assert.equal(marks.origin, 'upload');

  await page.goto(`${base}/workflows`);
  await page.getByRole('button', { name: 'Import' }).click();
  await page.locator('.dropzone input[type=file]').setInputFiles(flowFile);
  await page.waitForURL(/\/editor\//);
  await toSteps();
  await page.waitForTimeout(600);

  // 2. The inspector offers the mode as a choice.
  await page.locator('.react-flow__node', { hasText: 'Log them' }).click();
  const mode = page.locator('#cfg-mode');
  assert.equal(await mode.inputValue(), 'append');
  await page.getByText(/created the first time/i).waitFor();
  await shot('d1-inspector-append');
  log('inspector shows the Database step mode: append');

  // The preview says what would happen and saves nothing.
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByText(/Adds the rows to the table “low_log”/).waitFor();
  assert.equal(await find('low_log'), undefined, 'a preview must not create the table');
  log('plain English says it adds rows; the preview created nothing');

  // 3. Run twice: created, then added.
  await runAndWait();
  const expected = (await find('low_log')).rows;
  assert.ok(expected > 0);
  assert.equal((await find('low_log')).origin, 'result');
  await runAndWait();
  assert.equal((await find('low_log')).rows, expected * 2);
  log(`run 1 created low_log with ${expected} rows, run 2 added ${expected} more (${expected * 2} in total)`);

  // 4. The Data page keeps uploads and saved results apart.
  await page.goto(`${base}/knowledge?tab=data`);
  await page.getByRole('heading', { name: 'Your data' }).waitFor();
  await page.getByRole('heading', { name: 'Saved by workflows' }).waitFor();
  const yours = await page.locator('section[aria-label="Your data"] .kb__row').allInnerTexts();
  const saved = await page.locator('section[aria-label="Saved by workflows"] .kb__row').allInnerTexts();
  assert.ok(yours.some(t => /student_marks/.test(t)) && yours.some(t => /courses/.test(t)));
  assert.ok(!yours.some(t => /low_log/.test(t)), 'a saved result is not listed with uploads');
  assert.equal(saved.length, 1);
  assert.match(saved[0], /low_log[\s\S]*saved by a workflow/);
  await page.locator('section[aria-label="Saved by workflows"] .kb__row').click();
  assert.equal(await page.getByRole('button', { name: 'Update with a new file' }).count(), 0, 'a saved result has no "update with a file" button');
  await shot('d2-data-sections');
  log('Data page: uploads under "Your data", low_log under "Saved by workflows" (no update-with-file button)');

  // 5. A new upload with the same columns as the result is not offered as an update to it.
  await page.locator('input[type=file]').first().setInputFiles('sample_data/student_marks_next_semester.xlsx');
  await page.getByRole('dialog').waitFor();
  const dialog = await page.getByRole('dialog').innerText();
  assert.ok(!/low_log/.test(dialog), 'the upload dialog must not offer the saved result as a target');
  await page.getByRole('button', { name: 'Cancel' }).click();
  log('the upload dialog does not offer low_log as something to replace');

  // 6. Switch to replace: the table is replaced, not added to.
  await page.goto(`${base}/workflows`);
  await page.getByText('Log low scores').first().click();
  await page.waitForURL(/\/editor\//);
  await toSteps();
  await page.waitForTimeout(600);
  await page.locator('.react-flow__node', { hasText: 'Log them' }).click();
  await page.locator('#cfg-mode').selectOption('replace');
  await page.getByText(/A table you uploaded yourself is never replaced/).waitFor();
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByText(/replacing its contents/).waitFor();
  await runAndWait();
  assert.equal((await find('low_log')).rows, expected);
  log(`mode replace: low_log is back to ${expected} rows`);

  // 7. Pointing the step at uploaded data in replace mode is refused, and the upload is untouched.
  await page.locator('.react-flow__node', { hasText: 'Log them' }).click();
  await page.locator('#cfg-table').fill('courses');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.locator('.react-flow__node', { hasText: 'Log them' }).getByText(/data you uploaded/).waitFor({ timeout: 10000 });
  assert.equal((await find('courses')).rows, 3);
  assert.equal((await find('courses')).origin, 'upload');
  await shot('d3-refused');
  log('replace onto the uploaded dataset "courses" was refused; courses still has 3 rows');

  console.log('\nDATABASE E2E PASSED');
} catch (e) {
  await shot('d-failure').catch(() => {});
  console.error('\nDATABASE E2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
