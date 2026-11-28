/**
 * What kind of file someone dropped or chose, from its name and its first bytes. The Data library reads CSV and Excel
 * workbooks (.xlsx, .xlsm); anything else is named and turned away with a reason, so it does not fail later.
 * The contents win over the name: a PDF renamed to .csv is still a PDF.
 */
export type FileKind = 'csv' | 'xlsx' | 'xls' | 'pdf' | 'image' | 'word' | 'text' | 'other';

export interface FileCheck {
  kind: FileKind;
  ok: boolean;
  label: string;
  /** Why it cannot be used, in plain words (only when ok is false). */
  reason?: string;
}

/** How many leading bytes classifyFile needs. */
export const HEAD_BYTES = 16;

const starts = (head: Uint8Array, sig: number[]) => sig.every((b, i) => head[i] === b);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];   // old Office files: .xls, .doc
const PDF = [0x25, 0x50, 0x44, 0x46];   // %PDF
const IMAGES = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46]];   // PNG, JPEG, GIF, WEBP (RIFF)

/** Text has no NUL bytes and few control characters (tab, line breaks and a byte-order mark are fine). */
function looksLikeText(head: Uint8Array): boolean {
  let odd = 0;
  for (const b of head) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) odd++;
  }
  return odd <= 1;
}

const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

export function classifyFile(name: string, head: Uint8Array): FileCheck {
  const ext = extOf(name);
  const no = (kind: FileKind, label: string, why: string): FileCheck => ({ kind, ok: false, label, reason: `${label}: ${why}` });
  // A PDF or picture whose name says otherwise (for example renamed to .csv) is named for what it really is.
  const asKind = (kind: FileKind, label: string, what: string, why: string, own: string[]): FileCheck =>
    no(kind, label, ext && !own.includes(ext) ? `the file is named .${ext}, but it is really ${what}. ${why}` : why);

  if (starts(head, PDF)) return asKind('pdf', 'PDF document', 'a PDF document', 'jwork reads tables from CSV or Excel files. Export the table to Excel or CSV first.', ['pdf']);
  if (IMAGES.some(sig => starts(head, sig))) return asKind('image', 'Image', 'a picture', 'jwork cannot read a table from a picture. Use the CSV or Excel file it came from.', ['png', 'jpg', 'jpeg', 'gif', 'webp']);
  if (starts(head, OLE)) {
    if (ext === 'doc') return no('word', 'Word document', 'jwork reads tables from CSV or Excel files.');
    return no('xls', 'Old Excel file (.xls)', 'open it in Excel and choose Save As, Excel Workbook (.xlsx), then upload that.');
  }
  if (starts(head, ZIP)) {
    if (ext === 'xlsx' || ext === 'xlsm') return { kind: 'xlsx', ok: true, label: 'Excel workbook' };
    if (ext === 'docx') return no('word', 'Word document', 'jwork reads tables from CSV or Excel files. Copy the table into Excel first.');
    return no('other', `${ext ? `.${ext} file` : 'This file'}`, 'it is a packed (zip) file that jwork cannot read. CSV and Excel (.xlsx) files are supported.');
  }
  if (ext === 'xlsx' || ext === 'xlsm') return no('other', 'Damaged workbook', `it is named .${ext} but is not a real Excel workbook. Open it in Excel and save it again.`);
  if (looksLikeText(head)) {
    if (ext === 'csv') return { kind: 'csv', ok: true, label: 'CSV file' };
    return no('text', `${ext ? `.${ext} text file` : 'Text file'}`, 'save the table as CSV (comma-separated) or as an Excel workbook, then upload that.');
  }
  return no('other', `${ext ? `.${ext} file` : 'This file'}`, 'jwork can only read CSV and Excel (.xlsx) files.');
}

/** Reads the first bytes of a browser File and classifies it. */
export async function checkFile(file: File): Promise<FileCheck> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  return classifyFile(file.name, head);
}
