// The refined flow in the real app: generate → the agent tests the plan on your data (and revises it) → run → review
// (exceptions, assumptions) → approve → Excel report; and what the agent sends to the AI, checked on the wire.
// Needs the frontend, the AI backend and a model running (npm run dev:all). Uses a fresh browser profile.
// Usage: node tests/e2e-review.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';

const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, '');
const log = (...a) => console.log('[e2e-review]', ...a);
mkdirSync('tests/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await context.newPage();
const shot = name => page.screenshot({ path: `tests/shots/${name}.png` });
page.on('pageerror', e => log('page error:', e.message));

// Every body sent to the AI service, to check that no data value leaves the browser.
const aiBodies = [];
page.on('request', r => { if (/\/api\/(generate|refine|revise)$/.test(r.url())) aiBodies.push({ url: r.url(), body: r.postData() ?? '' }); });

const readStored = () => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('jwork-data', 1);
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const tx = req.result.transaction(['info', 'rows']);
    const all = tx.objectStore('info').getAll();
    all.onsuccess = () => {
      const info = all.result.find(d => d.name === 'student_marks');
      const rows = tx.objectStore('rows').get(info.id);
      rows.onsuccess = () => resolve(rows.result);
    };
  };
}));

const panelText = async () => (await page.locator('.editor__panel').innerText()).replace(/\s+/g, ' ');


/** A workflow opens on its Result; the canvas and its tabs are under "How it was done". */
const toSteps = async () => {
  const b = page.getByRole('button', { name: 'How it was done', exact: true });
  await b.waitFor();
  if (await b.getAttribute('aria-pressed') !== 'true') await b.click();
};
try {
  // 0. Data.
  await page.goto(`${base}/knowledge?tab=data`);
  await page.getByText('No data yet').waitFor();
  await page.locator('input[type=file]').first().setInputFiles(['sample_data/student_marks.xlsx']);
  await page.locator('.kb__row', { hasText: 'student_marks' }).waitFor();
  const rows = await readStored();
  const values = [...new Set(rows.flatMap(r => Object.values(r)).filter(v => typeof v === 'string' && v.length >= 3 && !/^\d+$/.test(v)))];
  log(`uploaded student_marks: ${rows.length} rows, ${values.length} distinct text values to watch for on the wire`);

  // 1. The agent revises a plan that fails when run. The model's first draft is replaced by a broken one (wrong column),
  //    so the run fails and the observation goes to /api/revise; the revision itself comes from the real model.
  await page.route('**/api/generate', async route => {
    const res = await route.fetch();
    const body = await res.json();
    const filter = body.flow.nodes.find(n => n.type === 'FILTER');
    if (filter) { filter.config.condition = 'marks < 50'; filter.name = 'Filter: marks < 50'; }
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`${base}/generate`);
  await page.locator('#prompt').fill('Find the students in my student_marks with a score below 50');
  await page.getByRole('button', { name: /build workflow/i }).click();
  await page.getByText(/Testing it on your data/).waitFor({ timeout: 120000 });
  await shot('r1-agent-testing');
  await page.waitForURL(/\/editor\//, { timeout: 240000 });
  await toSteps();
  await page.unroute('**/api/generate');
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByText('Tested by running it').waitFor();
  const rounds = await page.locator('.check__agent li > span').allInnerTexts();
  rounds.forEach((r, i) => log(`agent round ${i + 1}: ${r.replace(/\s+/g, ' ').slice(0, 200)}`));
  assert.match(rounds[0], /the run stopped with an error/i, 'round 1 saw the failing run');
  const revise = aiBodies.filter(b => b.url.endsWith('/api/revise'));
  assert.ok(revise.length >= 1, 'the agent asked the AI to revise');
  const sent = JSON.parse(revise[0].body);
  assert.match(sent.observation, /There is no column “marks”/);
  log('first observation sent:', JSON.stringify(sent.observation).slice(0, 220));
  await page.locator('.check__agent summary').first().click();
  await shot('r2-agent-rounds');

  // Nothing from the data went to the AI service, in any request.
  for (const b of aiBodies) for (const v of values) assert.ok(!b.body.includes(v), `data value “${v}” was sent to ${b.url}`);
  log(`${aiBodies.length} AI requests checked: no data value was sent`);

  // 2. Make sure the workflow is the intended one (whatever the model revised it to), then run and review.
  const plain = await page.locator('.check__explain li').allInnerTexts();
  log('workflow after the agent:', JSON.stringify(plain));
  if (!plain.some(s => /score is less than 50/.test(s))) {
    log('the revision did not land on “score < 50”; setting it by hand for the review part of the test');
    await page.locator('.react-flow__node', { hasText: /FILTER/i }).first().click();
    const cond = page.locator('.editor__panel textarea, .editor__panel input').filter({ hasText: '' }).first();
    await cond.fill('score < 50');
    await page.getByRole('tab', { name: /Check/ }).click();
  }
  await page.getByRole('button', { name: /Run workflow|Run again/ }).click();
  await page.getByText('Download CSV').waitFor({ timeout: 20000 });
  await page.locator('.review').waitFor();
  const blank = rows.filter(r => (r.score ?? '').trim() === '').length;
  const below = rows.filter(r => (r.score ?? '').trim() !== '' && Number(r.score) < 50).length;
  let text = await panelText();
  log('review totals:', text.match(/Read \d+ rows from .*?accounted for\./)?.[0]);
  assert.match(text, new RegExp(`Read ${rows.length} rows from “student_marks”: ${below} in the result, ${rows.length - below - blank} left out by the steps, ${blank} flagged\\. Every row is accounted for\\.`));
  assert.match(text, new RegExp(`${blank} rows? left out because score is blank`));
  const approveBtn = page.getByRole('button', { name: 'Approve result' });
  assert.equal(await approveBtn.isDisabled(), true, 'approval is closed while a critical exception is open');
  log('blockers:', JSON.stringify(await page.locator('.review__blockers li').allInnerTexts()));
  await shot('r3-review-open');

  // 3. Resolve: accept the exception with a reason, confirm every assumption, approve.
  await page.locator('.review__accept textarea').first().fill('Student was absent; marked separately');
  await page.getByRole('button', { name: 'Accept with this reason' }).click();
  for (const box of await page.locator('.review__check input').all()) await box.check();
  // The approver's name is not filled in for them (a new browser has no profile name), so approval waits for it.
  assert.equal(await approveBtn.isDisabled(), true);
  await page.locator('.review__approve input').fill('Jean (test)');
  assert.equal(await approveBtn.isDisabled(), false);
  await approveBtn.click();
  await page.getByText(/Approved by Jean \(test\)/).waitFor();
  text = await panelText();
  assert.match(text, /It is the result shown here\./);
  await shot('r4-approved');
  log('approved; the gate opened only after the exception was accepted and the assumptions confirmed');

  // 4. The report.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download report \(Excel\)/ }).click()]);
  const file = await download.path();
  const zip = unzipSync(new Uint8Array(readFileSync(file)));
  const sheet = n => strFromU8(zip[`xl/worksheets/sheet${n}.xml`]);
  assert.match(sheet(2), /APPROVED by Jean \(test\)/);
  assert.match(sheet(2), /Accepted: Student was absent; marked separately/);
  assert.match(sheet(3), /Output fingerprint \(SHA-256\)/);
  assert.match(sheet(3), /Tested by running it \(the agent\)/);
  log(`report downloaded (${download.suggestedFilename()}): approved, decision recorded, fingerprints and agent rounds included`);

  // 5. The approval is kept with the workflow: after a reload and a new run of the same workflow on the same data,
  //    the result is recognised as the approved one.
  await page.reload();
  await toSteps();
  await page.getByRole('tab', { name: /Check/ }).click();
  await page.getByRole('button', { name: /Run workflow|Run again/ }).click();
  await page.locator('.review').waitFor({ timeout: 20000 });
  await page.getByText(/It is the result shown here\./).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve result' }).count(), 0);
  log('after a reload and a new run, the approval still matches the result');

  log('PASS');
} catch (e) {
  await shot('r-failure').catch(() => {});
  log('FAIL', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
