/**
 * Reads an uploaded CSV or Excel (.xlsx) file into columns and rows, in the browser. A port of backend/app/tables.py:
 * tests/tables.test.ts checks that both read the same files into identical tables (including odd cases such as blank
 * header cells, duplicate columns, dates, times and formulas), so uploads behave the same with or without the backend.
 *
 * Every cell becomes a string, as the engine expects. Nothing here is sent anywhere: the file never leaves the browser.
 */
import { strFromU8, unzipSync } from 'fflate';

export type Row = Record<string, string>;
export interface Table { columns: string[]; rows: Row[] }
export interface Parsed extends Table { sheet: string | null }

export const MAX_ROWS = 50_000;
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;   // a defence against zip bombs

/** Case- and punctuation-insensitive key, the same as the engine's and the backend's `norm`. */
export const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export const stripExt = (name: string) => name.replace(/\.[A-Za-z0-9]{1,5}$/, '');

/* ---------------- header and rows ---------------- */

/** First non-empty row is the header. Blank rows are skipped. Trailing empty columns are dropped. */
export function tableFromMatrix(matrix: string[][]): Table {
  let at = matrix.findIndex(r => r.some(c => c.trim() !== ''));
  if (at < 0) throw new Error('The file has no header row.');
  const header = matrix[at].map(c => c.trim());
  while (header.length && !header[header.length - 1]) header.pop();
  const columns = header.map((h, i) => h || `column_${i + 1}`);
  if (new Set(columns.map(c => c.toLowerCase())).size !== columns.length) throw new Error('Column names must be unique.');
  const rows: Row[] = [];
  for (at++; at < matrix.length; at++) {
    const r = matrix[at];
    if (!r.some(c => c.trim() !== '')) continue;
    if (rows.length >= MAX_ROWS) throw new Error(`Too many rows (limit ${MAX_ROWS}).`);
    rows.push(Object.fromEntries(columns.map((col, i) => [col, i < r.length ? r[i].trim() : ''])));
  }
  return { columns, rows };
}

/* ---------------- CSV ---------------- */

/** A CSV reader that follows the rules of Python's csv module (quotes, doubled quotes, newlines in cells, any line ending). */
function readCsv(text: string, delimiter: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'recordStart' | 'fieldStart' | 'field' | 'quoted' | 'afterQuote' = 'recordStart';
  const endField = () => { row.push(field); field = ''; };
  const endRecord = () => { out.push(row); row = []; state = 'recordStart'; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const newline = c === '\n' || c === '\r';
    if (newline && c === '\r' && text[i + 1] === '\n' && state !== 'quoted') i++;   // \r\n is one line ending
    switch (state) {
      case 'recordStart':
      case 'fieldStart':
        if (c === '"') state = 'quoted';
        else if (c === delimiter) { endField(); state = 'fieldStart'; }
        else if (newline) { if (state === 'recordStart') out.push([]); else { endField(); endRecord(); } }
        else { field += c; state = 'field'; }
        break;
      case 'field':
        if (c === delimiter) { endField(); state = 'fieldStart'; }
        else if (newline) { endField(); endRecord(); }
        else field += c;
        break;
      case 'quoted':
        if (c === '"') state = 'afterQuote'; else field += c;
        break;
      case 'afterQuote':
        if (c === '"') { field += '"'; state = 'quoted'; }
        else if (c === delimiter) { endField(); state = 'fieldStart'; }
        else if (newline) { endField(); endRecord(); }
        else { field += c; state = 'field'; }   // lenient, as Python is: text after a closing quote is kept
        break;
    }
  }
  if (state !== 'recordStart') { endField(); out.push(row); }
  return out;
}

export function parseCsv(text: string, delimiter = ','): Table {
  return tableFromMatrix(readCsv(text.replace(/^﻿+/, ''), delimiter));
}

/* ---------------- Excel (.xlsx) ---------------- */

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  }
  return entities[e] ?? m;
});
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const texts = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decode(m[1])).join('');

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function isDateFormat(id: number, code: string | undefined): boolean {
  if (code === undefined) return BUILTIN_DATE_FORMATS.has(id);
  const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(bare);
}

const columnIndex = (ref: string) => [...ref.replace(/[0-9]+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Python's `format(v, '.15g')`: up to 15 significant digits, no trailing zeros, exponent form for very small or large numbers. */
function formatG15(n: number): string {
  const [mantissa, e] = n.toExponential(14).split('e');
  const exponent = Number(e);
  if (exponent < -4 || exponent >= 15) {
    const m = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
    return `${m}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  return String(parseFloat(n.toPrecision(15)));
}

function numberText(raw: string): string {
  const text = raw.trim();
  if (/^-?\d+$/.test(text)) return BigInt(text).toString();
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  return Number.isInteger(n) ? BigInt(n).toString() : formatG15(n);
}

/** An Excel date or time serial as text, the way openpyxl and the backend read it. */
function serialText(serial: number): string {
  let v = serial;
  if (v > 1 && v < 60) v += 1;                                  // Excel treats 1900 as a leap year
  const day = Math.floor(v);
  const ms = Math.round((v - day) * 86_400_000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const clock = (msOfDay: number) => `${pad(Math.floor(msOfDay / 3_600_000))}:${pad(Math.floor(msOfDay / 60_000) % 60)}:${pad(Math.floor(msOfDay / 1000) % 60)}`;
  if (v >= 0 && v < 1) return clock(ms) + (ms % 1000 ? `.${pad((ms % 1000) * 1000, 6)}` : '');
  const d = new Date(Date.UTC(1899, 11, 30) + day * 86_400_000 + ms);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const msOfDay = d.getTime() - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return msOfDay === 0 ? date : `${date} ${clock(msOfDay)}`;
}

const BAD_XLSX = 'This is not a valid .xlsx file. Older .xls files are not supported; save it as .xlsx or CSV.';

export function parseXlsx(bytes: Uint8Array): Parsed {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: f => f.originalSize <= MAX_UNZIPPED_BYTES && /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(f.name) });
  } catch {
    throw new Error(BAD_XLSX);
  }
  const part = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  const workbook = part('xl/workbook.xml');
  if (!workbook) throw new Error(BAD_XLSX);

  const targets = new Map<string, string>();
  for (const m of part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(m => ({ name: decode(attr(m[0], 'name') ?? ''), path: targets.get(attr(m[0], 'r:id') ?? '') ?? '' }));

  const shared = [...part('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map(m => (m[1] ? texts(m[1]) : ''));

  const customFormats = new Map<number, string>();
  for (const m of part('xl/styles.xml').matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode');
    if (Number.isFinite(id) && code !== undefined) customFormats.set(id, decode(code));
  }
  const xfBlock = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(part('xl/styles.xml'))?.[0] ?? '';
  const dateStyle = [...xfBlock.matchAll(/<xf\b[^>]*>/g)].map(m => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    return isDateFormat(id, customFormats.get(id));
  });

  let lastError = 'The workbook has no data.';
  for (const sheet of sheets) {
    const xml = files[sheet.path] ? strFromU8(files[sheet.path]) : '';
    const matrix: string[][] = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      for (const c of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = c[1];
        const inner = c[2] ?? '';
        const type = attr(tag, 't');
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 'inlineStr') value = texts(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '').trim();
        else if (v !== undefined) {
          if (type === 's') value = (shared[Number(v)] ?? '').trim();
          else if (type === 'str' || type === 'e') value = decode(v).trim();
          else if (type === 'b') value = v.trim() === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'd') value = decode(v).trim().replace('T', ' ').replace(/\.0+$/, '').replace(/ 00:00:00$/, '');
          else {
            const style = Number(attr(tag, 's') ?? 0);
            const n = Number(v);
            value = dateStyle[style] && Number.isFinite(n) ? serialText(n) : numberText(v);
          }
        }
        const ref = attr(tag, 'r');
        const col = ref ? columnIndex(ref) : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = value;
      }
      matrix.push(cells);
    }
    try {
      return { ...tableFromMatrix(matrix), sheet: sheet.name };
    } catch (e) {
      lastError = `Sheet “${sheet.name}”: ${e instanceof Error ? e.message : 'unreadable'}`;
    }
  }
  throw new Error(lastError);
}

/** Reads an uploaded file by its extension. */
export function parseUpload(filename: string, content: { text?: string; bytes?: Uint8Array }, delimiter = ','): Parsed {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    if (!content.bytes) throw new Error('The Excel file was not received.');
    return parseXlsx(content.bytes);
  }
  if (lower.endsWith('.xls')) throw new Error('Older .xls files are not supported. Save it as .xlsx or CSV.');
  return { ...parseCsv(content.text ?? '', delimiter), sheet: null };
}
