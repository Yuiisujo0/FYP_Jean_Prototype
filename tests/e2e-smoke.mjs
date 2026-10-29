// Drives the real app in Edge/Chromium with the sample Excel files.
// Needs the frontend and the AI backend running (npm run dev:all). Datasets live in the browser's IndexedDB, so the
// test reads them there. Every run starts with a fresh browser profile, so the library is empty.
// Usage: node tests/e2e-smoke.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const sample = name => `sample_data/${name}`;
const log = (...a) => console.log('[e2e]', ...a);

mkdirSync('tests/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const shot = name => page.screenshot({ path: `tests/shots/${name}.png` });
page.on('console', m => m.type() === 'error' && log('browser console error:', m.text()));
page.on('pageerror', e => log('page error:', e.message));
const dataCalls = [];
page.on('request', r => { if (/\/api\/datasets/.test(r.url())) dataCalls.push(r.url()); });   // datasets must never go to a server

/** Reads the browser's own database, the way the app does (same names). */
const readDb = fn => page.evaluate(`(${fn.toString()})()`);
const datasets = () => readDb(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('jwork-data', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('info', { keyPath: 'id', autoIncrement: true }); req.result.createObjectStore('rows'); };
  req.onerror = () => reject(req.error);
  req.onsuccess = () => { const all = req.result.transaction('info').objectStore('info').getAll(); all.onsuccess = () => resolve(all.result); };
}));
const datasetRows = name => page.evaluate(n => new Promise((resolve, reject) => {
  const req = indexedDB.open('jwork-data', 1);
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const tx = req.result.transaction(['info', 'rows']);
    const all = tx.objectStore('info').getAll();
    all.onsuccess = () => {
      const info = all.result.find(d => d.name === n);
      const rows = tx.objectStore('rows').get(info.id);
      rows.onsuccess = () => resolve({ ...info, rows: rows.result });
    };
  };
}), name);

const choose = async files => { await page.locator('input[type=file]').first().setInputFiles(files.map(sample)); };
const rowsOf = async name => (await datasets()).find(d => d.name === name)?.rowCount;

/** A real browser drag and drop: dragenter, dragover, then drop with files in a DataTransfer. */
const dragFiles = async (files, { drop = true } = {}) => {
  const payload = files.map(f => ({ name: f, b64: readFileSync(sample(f)).toString('base64') }));
  await page.evaluate(({ payload, drop }) => {
    const dt = new DataTransfer();
    for (const { name, b64 } of payload) dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name));
    const target = document.querySelector('.data');
    const fire = type => target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    fire('dragenter');
    fire('dragover');
    if (drop) fire('drop');
  }, { payload, drop });
};
const saveDialog = async choice => {
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(400);
  await page.getByText(choice).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
};


/** A workflow opens on its Result; the canvas and its tabs are under "How it was done". */
const toSteps = async () => {
  const b = page.getByRole('button', { name: 'How it was done', exact: true });
  await b.waitFor();
  if (await b.getAttribute('aria-pressed') !== 'true') await b.click();
};
try {
  // 1. Two Excel files chosen at once, empty library: both saved with no dialog.
  await page.goto(`${base}/knowledge?tab=data`);
  await page.getByText('No data yet').waitFor();
  await choose(['student_marks.xlsx', 'courses.xlsx']);
  await page.locator('.kb__row', { hasText: 'courses' }).waitFor();
  await page.locator('.kb__row', { hasText: 'student_marks' }).waitFor();
  assert.equal(await rowsOf('student_marks'), 40);
  assert.equal(await rowsOf('courses'), 3);
  await shot('1-two-files-uploaded');
  log('2 files chosen at once: both saved (40 and 3 rows), no dialog');

  // The data is in the browser, so it must survive a reload.
  await page.reload();
  await page.locator('.kb__row', { hasText: 'student_marks' }).waitFor();
  assert.equal(await rowsOf('student_marks'), 40);
  assert.equal(await rowsOf('courses'), 3);
  log('after a page reload both datasets are still there');

  // 2. Generate with the dataset known to the model, then run.
  await page.goto(`${base}/generate`);
  await page.locator('#prompt').fill('Find the students in my student marks with a score below 50 and save them to the database');
  await page.getByRole('button', { name: /build workflow/i }).click();
  await page.waitForURL(/\/editor\//, { timeout: 120000 });
  await toSteps();
  await page.waitForTimeout(800);
  await shot('2-generated');
  const readStep = page.locator('.react-flow__node', { hasText: 'READ CSV' });
  assert.ok(await readStep.count(), 'the generated workflow has a READ CSV step');
  const needs = (await page.locator('.editor__needs').count()) > 0;
  log('banner "needs data" shown:', needs, '| step label:', (await readStep.first().innerText()).replace(/\s+/g, ' ').slice(0, 60));
  if (needs) {
    await page.getByRole('button', { name: 'Choose dataset' }).click();
    await page.locator('select').first().selectOption({ label: /student_marks/ });
  }
  const stored = await datasetRows('student_marks');
  const expected = stored.rows.filter(r => r.score !== '' && Number(r.score) < 50).length;

  // The Check tab explains the workflow in plain English and previews the result, without running anything for real.
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByText('In plain English').waitFor();
  await page.getByText(new RegExp(`${expected} rows? in the result`)).waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
  await shot('2c-preview');
  const sentences = await page.locator('.check__explain li').allInnerTexts();
  log('plain English:', JSON.stringify(sentences));
  assert.ok(sentences.some(s => /^Reads the “.+” dataset\./.test(s)));
  assert.ok(sentences.some(s => /^Keeps only the rows where .*score is less than 50/.test(s)));
  assert.equal((await datasets()).length, 2, 'the preview must not save a table');
  log(`preview shows ${expected} rows and saved nothing`);

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByText('Download CSV').waitFor({ timeout: 15000 });
  await shot('3-run-complete');
  const text = (await page.locator('.editor__panel').innerText()).replace(/\s+/g, ' ');
  log('run result:', text.match(/The result has \d+ rows?/)?.[0], '| expected rows with score < 50:', expected);
  assert.match(text, new RegExp(`The result has ${expected} rows?`));

  // 2b. Ask: change the workflow in plain English. First the failure path, then a real change.
  await page.getByRole('tab', { name: 'Ask' }).click();
  await page.route('**/api/refine', route => route.abort());
  await page.locator('#ask-input').fill('Change the filter so the score must be below 40');
  await page.getByRole('button', { name: 'Apply change' }).click();
  await page.locator('.ask__reply--error').waitFor();
  log('Ask, AI service unreachable:', (await page.locator('.ask__reply--error').innerText()).replace(/\s+/g, ' ').slice(0, 90));
  assert.equal(await page.locator('#ask-input').inputValue(), 'Change the filter so the score must be below 40', 'the text is kept after an error');
  await page.unroute('**/api/refine');

  await page.getByRole('button', { name: 'Apply change' }).click();
  await page.locator('.ask__reply--ok').waitFor({ timeout: 120000 });
  const askReply = (await page.locator('.ask__reply--ok').innerText()).replace(/\s+/g, ' ');
  log('Ask reply:', askReply.slice(0, 140));
  assert.match(askReply, /^Changed a step/);
  const below40 = stored.rows.filter(r => r.score !== '' && Number(r.score) < 40).length;
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByText(new RegExp(`${below40} rows? in the result`)).waitFor({ timeout: 20000 });
  assert.ok((await page.locator('.check__explain li').allInnerTexts()).some(t => /score is less than 40/.test(t)), 'the plain-English steps show the new limit');
  await shot('3b-after-ask');
  log(`Ask changed the filter to below 40 and the preview now shows ${below40} rows`);

  // 3. Two files that both need a decision: asked one after the other.
  await page.goto(`${base}/knowledge?tab=data`);
  await choose(['student_marks_late_submissions.xlsx', 'student_marks_other_headers.xlsx']);
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /\(1 of 2\)/);
  await page.waitForTimeout(400);
  await shot('4-dialog-1-of-2');
  await saveDialog('Add these rows to “student_marks”');
  await page.getByText('(2 of 2)').waitFor();
  await saveDialog('Add these rows to “student_marks”');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByText('2 files saved').waitFor();
  assert.equal(await rowsOf('student_marks'), 54);
  log('2 files needing decisions: asked in turn, 40 + 6 + 8 = 54');

  // 4. A mixed batch: one skipped, one unsupported file type.
  await choose(['student_marks_next_semester.xlsx', 'make_samples.py']);
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Skip this file' }).click();
  await page.getByText(/0 files saved, 1 skipped, 1 failed\. make_samples\.py: Only CSV and Excel/).waitFor();
  assert.equal(await rowsOf('student_marks'), 54);
  log('skip and unsupported type handled, nothing changed');

  // 5. Real drag and drop: overlay appears while dragging, then replace.
  await dragFiles(['student_marks_next_semester.xlsx'], { drop: false });
  await page.getByText('Drop files to upload').waitFor();
  await page.waitForTimeout(300);
  await shot('5-drag-overlay');
  await dragFiles(['student_marks_next_semester.xlsx']);
  await saveDialog('Replace “student_marks”');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByText('Drop files to upload').waitFor({ state: 'detached' });
  assert.equal(await rowsOf('student_marks'), 30);
  await shot('6-data-final');
  log('drag and drop: replaced with 30 rows');
  assert.deepEqual(dataCalls, [], 'the app must not call any /api/datasets endpoint');
  log('no request was made to a datasets endpoint: the data library is entirely in the browser');
  log('PASS');
} catch (e) {
  await shot('failure').catch(() => {});
  log('FAIL', e.message.split('\n').slice(0, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await browser.close();
}
