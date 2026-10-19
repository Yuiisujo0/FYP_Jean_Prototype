// The browser table reader (src/lib/tables.ts) must read files exactly as the Python reference does.
// backend/eval/golden_tables.json holds what Python read from the sample and edge-case files. Regenerate with:
//   backend\.venv\Scripts\python backend\scripts\export_tables_golden.py
// Run with: npm run test:tables
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCsv, parseUpload, parseXlsx, tableFromMatrix } from '../src/lib/tables.ts';

const golden = JSON.parse(readFileSync('backend/eval/golden_tables.json', 'utf-8')) as {
  xlsx: { path: string; columns: string[]; rows: Record<string, string>[]; sheet: string }[];
  csv: { name: string; text: string; delimiter: string; expected?: { columns: string[]; rows: Record<string, string>[] }; error?: string }[];
};

for (const c of golden.xlsx) {
  test(`Excel: ${c.path} is read exactly as Python reads it`, () => {
    const parsed = parseXlsx(new Uint8Array(readFileSync(c.path)));
    assert.equal(parsed.sheet, c.sheet);
    assert.deepEqual(parsed.columns, c.columns);
    assert.deepEqual(parsed.rows, c.rows);
  });
}

for (const c of golden.csv) {
  test(`CSV: ${c.name}`, () => {
    if (c.error) assert.throws(() => parseCsv(c.text, c.delimiter), new Error(c.error));
    else {
      const parsed = parseCsv(c.text, c.delimiter);
      assert.deepEqual({ columns: parsed.columns, rows: parsed.rows }, c.expected);
    }
  });
}

test('broken and unsupported files give clear messages, never a crash', () => {
  assert.throws(() => parseXlsx(new TextEncoder().encode('not a zip')), /not a valid \.xlsx/);
  assert.throws(() => parseUpload('old.xls', { bytes: new Uint8Array([1, 2, 3]) }), /\.xls files are not supported/);
  assert.throws(() => parseUpload('x.xlsx', {}), /not received/);
  const csv = parseUpload('a.csv', { text: 'a,b\n1,2\n' });
  assert.deepEqual([csv.columns, csv.sheet], [['a', 'b'], null]);
});

test('the row limit is enforced', () => {
  const matrix = [['a'], ...Array.from({ length: 50_001 }, (_, i) => [String(i)])];
  assert.throws(() => tableFromMatrix(matrix), /Too many rows/);
});
