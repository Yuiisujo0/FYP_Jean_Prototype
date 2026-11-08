import test from 'node:test';
import assert from 'node:assert/strict';
import { emailDraftUrl, isEmailAddress } from '../src/lib/emailDraft.ts';

const draft = { to: 'buyer@example.com', workflow: 'Low stock review', rows: 12, approver: 'Aina', approvedOn: '1 Nov 2026', filename: 'low-stock-review-report.xlsx' };
const read = (url: string) => {
  const parsed = new URL(url);
  return { protocol: parsed.protocol, to: decodeURIComponent(parsed.pathname), subject: parsed.searchParams.get('subject'), body: parsed.searchParams.get('body'), keys: [...parsed.searchParams.keys()] };
};

test('an email address needs one @ and a domain', () => {
  for (const good of ['buyer@example.com', ' a.b+c@mail.example.my ']) assert.equal(isEmailAddress(good), true, good);
  for (const bad of ['', 'buyer', 'buyer@', '@example.com', 'buyer@example', 'a b@example.com', 'a@b.com,c@d.com', 'a@b.com;c@d.com']) assert.equal(isEmailAddress(bad), false, bad);
});

test('an address cannot smuggle in other recipients or fields', () => {
  for (const bad of ['a@b.com?bcc=c@d.com', 'a@b.com&body=x', 'a@b.com\nbcc:c@d.com', '<a@b.com>']) assert.equal(isEmailAddress(bad), false, bad);
});

test('the draft names the recipient, the report, the rows and the approval', () => {
  const m = read(emailDraftUrl(draft));
  assert.equal(m.protocol, 'mailto:');
  assert.equal(m.to, 'buyer@example.com');
  assert.deepEqual(m.keys, ['subject', 'body']);
  assert.equal(m.subject, 'Approved report: Low stock review');
  assert.match(m.body!, /low-stock-review-report\.xlsx/);
  assert.match(m.body!, /It has 12 rows\./);
  assert.match(m.body!, /Approved by Aina on 1 Nov 2026\./);
});

test('one row is not "1 rows", and a workflow without a row count leaves the sentence out', () => {
  assert.match(read(emailDraftUrl({ ...draft, rows: 1 })).body!, /It has 1 row\./);
  assert.doesNotMatch(read(emailDraftUrl({ ...draft, rows: null })).body!, /It has/);
});

test('line breaks in a name cannot add email fields', () => {
  const m = read(emailDraftUrl({ ...draft, workflow: 'Report\r\nBcc: c@d.com', approver: 'Aina\nBcc: c@d.com' }));
  assert.equal(m.subject, 'Approved report: Report Bcc: c@d.com');
  assert.match(m.body!, /Approved by Aina Bcc: c@d\.com on/);
  assert.deepEqual(m.keys, ['subject', 'body']);
});

test('characters with a meaning in a web address survive the round trip', () => {
  const m = read(emailDraftUrl({ ...draft, workflow: 'Q&A = 100% #1?' }));
  assert.equal(m.subject, 'Approved report: Q&A = 100% #1?');
});
