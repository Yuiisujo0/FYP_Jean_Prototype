/**
 * An email draft for an approved report. It opens in the user's own email app, so jwork sends nothing itself and the
 * person checks the message, attaches the report and presses send. A mailto link cannot carry a file.
 */
const ADDRESS = /^[^\s@,;?&<>"]+@[^\s@,;?&<>"]+\.[^\s@,;?&<>".]+$/;

export const isEmailAddress = (text: string): boolean => ADDRESS.test(text.trim());

export interface EmailDraft {
  to: string;
  workflow: string;
  /** Rows in the approved result, or null when the workflow reads no data. */
  rows: number | null;
  approver: string;
  approvedOn: string;
  filename: string;
}

/** Names come from people, so a line break must not start a new email field. */
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();

/** The message holds only the report's name, its size and the approval, never a value from the data. */
export function emailDraftUrl(d: EmailDraft): string {
  const subject = `Approved report: ${oneLine(d.workflow)}`;
  const size = d.rows === null ? '' : ` It has ${d.rows} ${d.rows === 1 ? 'row' : 'rows'}.`;
  const body = [
    'Hello,',
    '',
    `Please find attached the approved report "${oneLine(d.workflow)}" (${oneLine(d.filename)}).${size}`,
    `Approved by ${oneLine(d.approver)} on ${oneLine(d.approvedOn)}.`,
    '',
    'Prepared with jwork.',
  ].join('\r\n');
  const to = encodeURIComponent(d.to.trim()).replace('%40', '@');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
