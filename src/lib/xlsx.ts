/**
 * The deliverable: an Excel workbook with the result, the review (row register, exceptions and decisions) and the
 * method (request, steps, assumptions, the agent's test rounds, approval and fingerprints).
 *
 * A minimal .xlsx writer on top of fflate (already used to read Excel files). Text is written as inline strings, so a
 * cell such as "=1+1" stays text and is never run as a formula. Plain numbers ("42", "3.5") become number cells;
 * anything that would change when read as a number ("007", "1.50") stays text.
 * Tested in tests/xlsx.test.ts by reading the file back with the app's own reader (src/lib/tables.ts).
 */
import { strToU8, zipSync } from 'fflate';
import type { AgentRound, ApprovalRecord, RunResult, Step } from '../types';
import { explainStep } from './explain.ts';
import type { Assumption, ReviewDecisions } from './review.ts';

export type Cell = string | number;

export interface Sheet {
  name: string;
  rows: Cell[][];
  /** Row indexes (0-based) to show in bold: headers and section titles. */
  bold?: number[];
  /** Column widths in characters. */
  widths?: number[];
}

const NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
/** A value that reads back exactly the same as a number. */
export const asCell = (v: string): Cell => (NUMBER.test(v) && String(Number(v)) === v ? Number(v) : v);

const escapeXml = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')   // characters XML cannot hold
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(sheet: Sheet): string {
  const bold = new Set(sheet.bold ?? []);
  const rows = sheet.rows.map((cells, r) => {
    const style = bold.has(r) ? ' s="1"' : '';
    const xml = cells.map((v, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      const text = String(v ?? '');
      if (text === '') return '';
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${xml}</row>`;
  }).join('');
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

/** Excel's rules for sheet names: at most 31 characters, none of []:*?/\, unique. */
function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map(n => {
    const base = (n.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 28)} ${k}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  if (!sheets.length) throw new Error('A workbook needs at least one sheet.');
  const names = sheetNames(sheets.map(s => s.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s)); });
  return zipSync(files, { level: 6 });
}

/* ---------------- the review report ---------------- */

export interface ReportInput {
  flowName: string;
  request: string;
  steps: Step[];
  result: RunResult;
  assumptions: Assumption[];
  decisions: ReviewDecisions;
  approval: ApprovalRecord | null;
  checks: AgentRound[];
  madeAt: Date;
}

const MAX_ROWS_LISTED = 60;
const rowList = (rows: number[]) =>
  rows.length > MAX_ROWS_LISTED ? `${rows.slice(0, MAX_ROWS_LISTED).join(', ')} … (${rows.length} in all)` : rows.join(', ');

/** One source row stays a number; a group lists its rows. */
const sourceRows = (ids: number[] = []): string | number => (ids.length === 1 ? ids[0] : ids.join(', '));

export function reportSheets(r: ReportInput): Sheet[] {
  const { result, decisions } = r;
  const names = new Map(r.steps.map(s => [s.id, s.name]));

  // 1. Result, with each row's place in the source.
  const resultSheet: Sheet = {
    name: 'Result',
    rows: [['Source row', ...result.columns], ...result.rows.map((row, i) => [sourceRows(result.lineage[i]), ...result.columns.map(c => asCell(row[c] ?? ''))])],
    bold: [0],
    widths: [11, ...result.columns.map(() => 16)],
  };

  // 2. Review: totals, exceptions with decisions, and every source row's fate.
  const review: Cell[][] = [];
  const reviewBold: number[] = [];
  const title = (t: string) => { reviewBold.push(review.length); review.push([t]); };
  const header = (...h: string[]) => { reviewBold.push(review.length); review.push(h); };
  review.push(['Status', r.approval ? `APPROVED by ${r.approval.approver} on ${new Date(r.approval.approvedAt).toISOString()}` : 'DRAFT: not approved']);
  const reg = result.register;
  if (reg) {
    review.push(['Source', reg.source], ['Rows read', reg.total], ['Kept (in the result)', reg.kept], ['Left out (did not match)', reg.excluded],
      ['Flagged (could not be checked)', reg.flagged], ['Totals add up', reg.balanced ? 'Yes' : 'NO']);
  } else {
    review.push(['Source', 'This workflow reads no data.']);
  }
  review.push([]);
  title('Exceptions');
  if (!result.exceptions.length) review.push(['None.']);
  else {
    header('Severity', 'Step', 'What happened', 'Source rows', 'Decision');
    for (const e of result.exceptions) {
      const note = (decisions.accepted[e.id] ?? '').trim();
      const decision = e.severity === 'warning' ? 'Shown to the reviewer' : note ? `Accepted: ${note}` : 'OPEN';
      review.push([e.severity, names.get(e.stepId) ?? e.stepName, e.message, rowList(e.rows), decision]);
    }
  }
  if (reg) {
    review.push([]);
    title('Row register (every source row)');
    header('Source row', 'Status', 'Step', 'Reason');
    for (const row of reg.rows) review.push([row.row, row.status, row.stepId ? names.get(row.stepId) ?? '' : '', row.reason ?? '']);
  }

  // 3. Method: what was asked, what ran, what was assumed, how it was tested, who approved it.
  const method: Cell[][] = [];
  const methodBold: number[] = [];
  const mTitle = (t: string) => { methodBold.push(method.length); method.push([t]); };
  method.push(['Workflow', r.flowName], ['Request', r.request || '(none recorded)'], ['Report made', r.madeAt.toISOString()], []);
  mTitle('Steps');
  const traced = new Map(result.trace.map(t => [t.stepId, t]));
  r.steps.forEach((s, i) => method.push([`${i + 1}. ${s.name}`, explainStep(s), traced.get(s.id)?.message ?? 'Did not run']));
  method.push([]);
  mTitle('Assumptions');
  if (!r.assumptions.length) method.push(['None.']);
  for (const a of r.assumptions) method.push([decisions.confirmed[a.id] ? 'Confirmed' : 'Not confirmed', a.text]);
  method.push([]);
  mTitle('Tested by running it (the agent)');
  if (!r.checks.length) method.push(['This workflow was not tested by the agent.']);
  for (const c of r.checks) method.push([`Round ${c.round}: ${c.outcome}`, c.detail, c.sent ? `Sent to the AI: ${c.sent}` : 'Nothing was sent to the AI.']);
  method.push([]);
  mTitle('Approval');
  if (!r.approval) method.push(['Not approved. This report is a draft.']);
  else {
    const a = r.approval;
    method.push(['Approved by', a.approver], ['Approved at', new Date(a.approvedAt).toISOString()],
      ['Workflow fingerprint (SHA-256)', a.workflowHash], ['Input fingerprint (SHA-256)', a.inputHash ?? 'no input'], ['Output fingerprint (SHA-256)', a.outputHash]);
  }

  return [
    resultSheet,
    { name: 'Review', rows: review, bold: reviewBold, widths: [30, 22, 70, 30, 40] },
    { name: 'Method', rows: method, bold: methodBold, widths: [32, 70, 70] },
  ];
}

export const buildReport = (r: ReportInput) => buildXlsx(reportSheets(r));
