// What a file dropped on a prompt box is, from its name and its first bytes, so a PDF or an old .xls is turned away with a
// reason instead of failing later in the Data library.
// Run with: node --test tests/file-kind.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFile } from '../src/lib/fileKind.ts';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

test('CSV and Excel workbooks are accepted', () => {
  assert.deepEqual(classifyFile('Stock_Count_Dec2026.csv', text('Item Code,Qty On Hand\nCT-1001,81\n')), { kind: 'csv', ok: true, label: 'CSV file' });
  assert.deepEqual(classifyFile('Stock_Count_Dec2026.xlsx', ZIP), { kind: 'xlsx', ok: true, label: 'Excel workbook' });
  assert.equal(classifyFile('Report.XLSM', ZIP).ok, true);
  assert.equal(classifyFile('empty.csv', new Uint8Array()).ok, true);
});

test('a CSV saved with a byte-order mark is still text', () => {
  assert.equal(classifyFile('hr.csv', bytes(0xef, 0xbb, 0xbf, 0x4e, 0x61, 0x6d, 0x65)).ok, true);
});

test('an old Excel file is turned away with how to fix it', () => {
  const r = classifyFile('Stock.xls', OLE);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'xls');
  assert.match(r.reason ?? '', /\.xlsx/);
});

test('other common files are named, not just rejected', () => {
  assert.equal(classifyFile('invoice.pdf', text('%PDF-1.7')).kind, 'pdf');
  assert.equal(classifyFile('photo.png', bytes(0x89, 0x50, 0x4e, 0x47)).kind, 'image');
  assert.equal(classifyFile('photo.jpg', bytes(0xff, 0xd8, 0xff)).kind, 'image');
  assert.equal(classifyFile('notes.docx', ZIP).kind, 'word');
  assert.equal(classifyFile('notes.txt', text('hello')).kind, 'text');
  for (const name of ['invoice.pdf', 'photo.png', 'notes.docx', 'notes.txt']) assert.equal(classifyFile(name, text('x')).ok, false);
});

test('the contents win when the name does not match them', () => {
  const pdf = classifyFile('stock.csv', text('%PDF-1.4'));
  assert.equal(pdf.ok, false);
  assert.equal(pdf.kind, 'pdf');
  assert.match(pdf.reason ?? '', /named \.csv/);
  const notZip = classifyFile('stock.xlsx', text('Item,Qty\n'));
  assert.equal(notZip.ok, false);
  assert.match(notZip.reason ?? '', /not a real Excel workbook/);
});
