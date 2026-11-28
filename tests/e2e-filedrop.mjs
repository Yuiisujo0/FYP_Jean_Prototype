// Files given to a prompt box: chosen with the paperclip or dropped on the page, on the cover, the Overview and Generate.
// A CSV or Excel file goes to the Data library and is saved there, and the request typed with it waits with a Build button;
// a PDF (even one named .csv) or an old .xls is turned away with the reason, and the page stays where it was.
// Needs only the frontend (no AI is called: Build is not pressed). Usage: npx vite, then node tests/e2e-filedrop.mjs [frontendUrl]
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const log = (...a) => console.log('[e2e-filedrop]', ...a);
mkdirSync('tests/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const shot = name => page.screenshot({ path: `tests/shots/${name}.png` });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

const csv = { name: 'inventory.csv', mimeType: 'text/csv', buffer: readFileSync('src/data/samples/inventory.csv') };
const fakeCsv = { name: 'stock.csv', mimeType: 'text/csv', buffer: Buffer.from('%PDF-1.7\n%binary') };
const oldXls = { name: 'Stock.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]) };
const toast = () => page.locator('.toast').last().innerText();

/** Drops files on an element the way a browser does: dragenter, dragover, drop, with a DataTransfer holding real Files. */
async function drop(selector, files) {
  await page.evaluate(async ({ selector, files }) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    const el = document.querySelector(selector);
    for (const type of ['dragenter', 'dragover']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { selector, files: files.map(f => ({ name: f.name, type: f.mimeType, bytes: [...f.buffer] })) });
}

try {
  // 1. Overview: type a request, choose a CSV with the paperclip.
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('h1.welcome').waitFor();
  const request = 'List the items with fewer than 5 in stock';
  await page.locator('.ask input[aria-label]').fill(request);
  await page.locator('.ask [data-testid="prompt-file"]').setInputFiles(csv);
  await page.waitForURL(/\/knowledge\?tab=data/);
  await page.locator('.data__next').waitFor();
  const next = await page.locator('.data__next').innerText();
  log('Overview paperclip → Data library:', next.replace(/\s+/g, ' '));
  assert.match(next, /Your data is in/);
  assert.match(next, new RegExp(request));
  await page.getByRole('button', { name: 'Build it now' }).waitFor();
  assert.match(await page.locator('.kb__list').innerText(), /inventory/i);
  await shot('filedrop-01-data-library');

  // 2. Generate: a PDF renamed .csv and an old .xls are turned away, and the page stays.
  await page.goto(`${base}/generate`, { waitUntil: 'domcontentloaded' });
  await page.locator('#prompt').fill('Total stock by category');
  await page.locator('.gen [data-testid="prompt-file"]').setInputFiles(fakeCsv);
  await page.locator('.toast').waitFor();
  const refused = await toast();
  log('PDF named .csv:', refused);
  assert.match(refused, /really a PDF document/);
  assert.match(page.url(), /\/generate$/);
  await page.locator('.toast').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
  await drop('.page.gen', [oldXls]);
  await page.locator('.toast').waitFor();
  const old = await toast();
  log('old .xls dropped:', old);
  assert.match(old, /Old Excel file \(\.xls\)/);
  assert.match(page.url(), /\/generate$/);
  assert.equal(await page.locator('#prompt').inputValue(), 'Total stock by category', 'the typed request is untouched');

  // 3. Generate: the drop overlay shows while dragging, and a good file dropped with a bad one goes through alone.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['a,b\n1,2\n'], 'x.csv', { type: 'text/csv' }));
    document.querySelector('.page.gen').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.locator('.filedrop').waitFor();
  await shot('filedrop-02-overlay');
  log('overlay shown while dragging:', (await page.locator('.filedrop b').innerText()));
  await drop('.page.gen', [{ ...csv, name: 'inventory_copy.csv' }, oldXls]);
  await page.waitForURL(/\/knowledge\?tab=data/);
  // Same columns as the "inventory" saved in step 1, so the Data library asks what to do, as it does for any upload.
  await page.getByText('What should happen to this file?').waitFor();
  await page.getByText('Add these rows to “inventory”').click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.data__next').waitFor();
  assert.match(await page.locator('.kb__detail').innerText(), /52 rows/, 'the 26 rows were added to inventory');
  assert.match(await page.locator('.data__next').innerText(), /Total stock by category/);
  log('good + bad dropped on Generate: good one saved, request waiting');

  // 4. An Excel workbook, when the mock company file is present.
  const xlsx = 'docs/test-data/Stock_Count_Dec2026.xlsx';
  if (existsSync(xlsx)) {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('h1.welcome').waitFor();
    await drop('.page.dash', [{ name: 'Stock_Count_Dec2026.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: readFileSync(xlsx) }]);
    await page.waitForURL(/\/knowledge\?tab=data/);
    await page.locator('.data__next').waitFor();
    assert.match(await page.locator('.kb__list').innerText(), /Stock_Count_Dec2026/i);
    log('Excel dropped on the Overview: saved, no request typed →', (await page.locator('.data__next').innerText()).replace(/\s+/g, ' '));
  } else log('skipped the Excel check (no docs/test-data)');

  // 5. The cover (forced on with ?intro=1): the paperclip closes it and goes to the Data library.
  await page.goto(`${base}/?intro=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('.landing').waitFor();
  await page.locator('.landing__chat input[aria-label]').fill('Which items need reordering?');
  await page.locator('.landing [data-testid="prompt-file"]').setInputFiles({ ...csv, name: 'inventory_cover.csv' });
  await page.waitForURL(/\/knowledge\?tab=data/);
  await page.locator('.landing').waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByText('What should happen to this file?').waitFor();   // same columns as "inventory" again
  await page.getByRole('button', { name: 'Save' }).click();             // the default: save as a new dataset
  await page.locator('.data__next').waitFor();
  assert.match(await page.locator('.kb__list').innerText(), /inventory_cover/);
  assert.match(await page.locator('.data__next').innerText(), /Which items need reordering\?/);
  await shot('filedrop-03-from-cover');
  log('cover paperclip → cover closed, Data library, request waiting');

  assert.deepEqual(errors, [], 'no page errors');
  log('PASS');
} catch (e) {
  await shot('filedrop-failed').catch(() => {});
  console.error('[e2e-filedrop] FAIL', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
