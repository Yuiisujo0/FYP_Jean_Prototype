// Drives the real app in Edge/Chromium: back up datasets, wipe the browser's data, restore, and check everything came back.
// Needs only the frontend (npm run dev), no backend or model. Every run starts with a fresh browser profile.
// Usage: node tests/e2e-backup.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const log = (...a) => console.log('[e2e-backup]', ...a);
mkdirSync('tests/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, acceptDownloads: true });
const shot = name => page.screenshot({ path: `tests/shots/${name}.png` });
page.on('console', m => m.type() === 'error' && log('browser console error:', m.text()));
page.on('pageerror', e => log('page error:', e.message));

const readAll = () => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('jwork-data', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('info', { keyPath: 'id', autoIncrement: true }); req.result.createObjectStore('rows'); };
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
        r.onsuccess = () => { out.push({ name: d.name, columns: d.columns, rowCount: d.rowCount, rows: r.result }); if (!--left) resolve(out.sort((a, b) => a.name.localeCompare(b.name))); };
      }
    };
  };
}));
const wipeLibrary = () => page.evaluate(() => new Promise(resolve => {
  const req = indexedDB.deleteDatabase('jwork-data');
  req.onsuccess = req.onerror = req.onblocked = () => resolve();
}));
const restore = async path => {
  await page.locator('input[type=file][accept*="json"]').setInputFiles(path);
};

try {
  // 1. Two datasets in the library.
  await page.goto(`${base}/knowledge?tab=data`);
  await page.getByText('No data yet').waitFor();
  await page.locator('input[type=file]').first().setInputFiles(['sample_data/student_marks.xlsx', 'sample_data/courses.xlsx']);
  await page.locator('.kb__row', { hasText: 'courses' }).waitFor();
  await page.locator('.kb__row', { hasText: 'student_marks' }).waitFor();
  const before = await readAll();
  assert.deepEqual(before.map(d => d.name), ['courses', 'student_marks']);
  log('library has', before.map(d => `${d.name} (${d.rowCount} rows)`).join(', '));

  // 2. The Data page points to the backup.
  await page.getByRole('link', { name: /download a backup/i }).click();
  await page.waitForURL(/\/profile/);
  await page.getByText('You have not made a backup yet.').waitFor();
  await page.getByText('Browser storage').waitFor();
  await page.locator('.profile__stats', { hasText: 'Datasets' }).getByText('2', { exact: true }).waitFor();
  await shot('b1-profile-before-backup');
  const persisted = await page.evaluate(() => navigator.storage?.persisted?.());
  log('storage persisted?', persisted, '| panel:', (await page.locator('.profile__panel', { hasText: 'Browser storage' }).innerText()).replace(/\s+/g, ' ').slice(0, 160));

  // 3. Download a backup and read the file.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
  const backupPath = 'tests/shots/jwork-backup-test.json';
  await download.saveAs(backupPath);
  const file = JSON.parse(readFileSync(backupPath, 'utf8'));
  assert.equal(file.format, 'jwork.workspace');
  assert.equal(file.version, 2);
  assert.deepEqual(file.datasets.map(d => d.name).sort(), ['courses', 'student_marks']);
  assert.equal(file.datasets.find(d => d.name === 'student_marks').rows.length, 40);
  await page.getByText(/Backup downloaded \(.*2 datasets\)/).waitFor();
  await page.getByText(/Last backup: /).waitFor();
  log('backup file: version', file.version, '|', file.datasets.map(d => `${d.name}: ${d.rows.length} rows`).join(', '), '|', Math.round(readFileSync(backupPath).length / 1024), 'KB');

  // 4. Wipe the library (what "clear browsing data" does) and restore.
  await wipeLibrary();
  await page.goto(`${base}/knowledge?tab=data`);
  await page.getByText('No data yet').waitFor();
  assert.deepEqual(await readAll(), []);
  await page.goto(`${base}/profile`);
  await restore(backupPath);
  await page.getByText(/Restored .* and 2 datasets/).waitFor();
  const after = await readAll();
  assert.deepEqual(after, before, 'restored datasets are identical to the originals');
  await page.locator('.profile__stats', { hasText: 'Datasets' }).getByText('2', { exact: true }).waitFor();
  await shot('b2-restored');
  log('after wipe and restore the datasets are identical (columns, counts and every row)');

  // 5. A version 1 backup (no datasets) must leave the library alone.
  const v1Path = 'tests/shots/jwork-backup-v1.json';
  writeFileSync(v1Path, JSON.stringify({ format: 'jwork.workspace', version: 1, flows: file.flows, knowledge: [], profile: file.profile }));
  await restore(v1Path);
  await page.getByText(/before datasets were included, so your datasets were not changed/).waitFor();
  assert.deepEqual(await readAll(), before);
  log('a version 1 backup restored the workflows and left the datasets untouched');

  // 6. A file that is not a backup is refused and changes nothing.
  const junk = 'tests/shots/not-a-backup.json';
  writeFileSync(junk, JSON.stringify({ hello: 'world' }));
  await restore(junk);
  await page.getByText('This is not a jwork backup file.').waitFor();
  assert.deepEqual(await readAll(), before);
  log('a file that is not a backup was refused');

  console.log('\nBACKUP E2E PASSED');
} catch (e) {
  await shot('b-failure').catch(() => {});
  console.error('\nBACKUP E2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
