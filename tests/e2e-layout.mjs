// Arranging "How it was done": the Layout menu puts the Logs on the left, the right or the bottom and the tools on either
// side; dragging the Logs by their grip to an edge moves them there; the choice is remembered after a reload; Reset restores
// it. Needs only the frontend (npm run dev). Usage: node tests/e2e-layout.mjs [frontendUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const base = (process.argv[2] ?? 'http://localhost:5173/FYP_Jean_Prototype').replace(/\/$/, ''), out = 'tests/shots';
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: 'msedge' });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(`${base}/knowledge?tab=data`); await p.locator('input[type=file]').first().setInputFiles(['sample_data/stock_list.xlsx']); await p.locator('.kb__row', { hasText: 'stock_list' }).waitFor();
await p.goto(`${base}/workflows`); await p.getByText('Low stock review').first().click(); await p.waitForURL(/\/editor\//);
await p.getByRole('button', { name: 'How it was done', exact: true }).click(); await p.locator('.logs').waitFor(); await p.waitForTimeout(1000);
await p.locator('.logs__step').nth(1).click();
await p.getByRole('button', { name: 'Layout' }).click(); await p.waitForTimeout(300);
await p.screenshot({ path: `${out}/layout-1-menu.png` });
await p.getByRole('radiogroup', { name: 'Logs' }).getByRole('radio', { name: 'Left' }).click(); await p.waitForTimeout(500);
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
await p.screenshot({ path: `${out}/layout-2-logs-left.png` });
assert.match(await p.locator('.logs').getAttribute('class'), /is-left/); console.log('[e2e-layout] Layout menu: Logs on the left');
// Tools on the left too, then open the Check tab
await p.getByRole('button', { name: 'Layout' }).click();
await p.getByRole('radiogroup', { name: 'Tools' }).getByRole('radio', { name: 'Left' }).click(); await p.keyboard.press('Escape');
await p.getByRole('tab', { name: /Check/ }).click(); await p.waitForTimeout(500);
await p.screenshot({ path: `${out}/layout-3-both-left-tools-open.png` });
// Drag the grip to the right edge
const grip = p.getByRole('button', { name: /Move the logs/ });
const g = await grip.boundingBox();
await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await p.mouse.down();
await p.mouse.move(900, 450, { steps: 8 }); await p.mouse.move(1380, 450, { steps: 8 });
await p.screenshot({ path: `${out}/layout-4-dragging.png` });
await p.mouse.up(); await p.waitForTimeout(500);
assert.match(await p.locator('.logs').getAttribute('class'), /is-right/); console.log('[e2e-layout] dragged by the grip: Logs on the right');
await p.screenshot({ path: `${out}/layout-5-logs-right.png` });
// Persisted across reload
await p.reload(); await p.getByRole('button', { name: 'How it was done', exact: true }).click(); await p.locator('.logs').waitFor();
assert.match(await p.locator('.logs').getAttribute('class'), /is-right/); assert.equal(await p.locator('.editor__body').getAttribute('data-tools'), 'left'); console.log('[e2e-layout] remembered after a reload');
// Fold the side logs
await p.getByRole('button', { name: 'Fold the logs away' }).click(); await p.waitForTimeout(400);
await p.screenshot({ path: `${out}/layout-6-folded-right.png` });
// Reset
await p.getByRole('button', { name: 'Open the logs' }).click(); await p.getByRole('button', { name: 'Layout' }).click(); await p.getByRole('button', { name: 'Reset layout' }).click(); await p.waitForTimeout(300);
assert.match(await p.locator('.logs').getAttribute('class'), /is-bottom/); assert.equal(await p.locator('.editor__body').getAttribute('data-tools'), 'right'); console.log('[e2e-layout] Reset layout: back to the bottom and the right');
assert.deepEqual(errs, []); console.log('[e2e-layout] PASS');
await b.close();
