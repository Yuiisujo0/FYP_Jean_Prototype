/**
 * Reviewing and approving a run's result. The AI proposes the workflow and the engine runs it; this module decides
 * whether a person may approve the result, and records what they approved.
 *
 * - Assumptions are read from the steps themselves (no model): which dataset, what a condition means at its limit,
 *   which column a word was matched to, which columns are dropped. Each one must be confirmed.
 * - Critical exceptions (rows that could not be checked, steps that did not run) must each be accepted with a reason,
 *   or fixed by changing the workflow and running it again.
 * - The approval record keeps SHA-256 fingerprints of the workflow, the input and the output, so a later change is
 *   visible, and the resolutions and assumptions as they were confirmed.
 *
 * Pure functions apart from hashing (Web Crypto, available in browsers and in Node), tested in tests/review.test.ts.
 */
import type { ApprovalRecord, RunException, RunResult, Step } from '../types';
import { conditionColumns, describeCondition, mixesAndOr, parseTransform } from './engine.ts';

export interface Assumption {
  /** Stable for the same workflow, so a confirmation can be kept while nothing changes. */
  id: string;
  stepId: string;
  text: string;
}

export interface ReviewDecisions {
  /** Critical exception id → the reason it was accepted. */
  accepted: Record<string, string>;
  /** Assumption id → confirmed. */
  confirmed: Record<string, boolean>;
}

export const emptyDecisions = (): ReviewDecisions => ({ accepted: {}, confirmed: {} });

/** Shortest reason accepted for leaving a critical exception as it is. */
export const MIN_REASON = 5;

/** Exceptions that cannot be accepted, only fixed: the result itself cannot be trusted. */
const UNACCEPTABLE = new Set(['unbalanced']);
export const canAccept = (e: RunException) => e.severity === 'critical' && !UNACCEPTABLE.has(e.kind);

/** What a person must agree to before the result counts, read from the steps and from what the run saw. */
export function assumptionsFor(steps: Step[], result: RunResult): Assumption[] {
  const out: Assumption[] = [];
  const add = (step: Step, key: string, text: string) => out.push({ id: `${step.id}:${key}`, stepId: step.id, text });
  const traced = new Map(result.trace.map(t => [t.stepId, t]));

  let sorted = false;
  for (const step of steps) {
    const t = traced.get(step.id);
    if (!t) continue;   // the step did not run (the run stopped before it)
    const c = step.config ?? {};
    switch (step.type) {
      case 'READ_CSV':
        add(step, 'source', `The data is the dataset ${result.input?.name ?? `“${c.file}”`} (${t.rowsOut} ${t.rowsOut === 1 ? 'row' : 'rows'}).`);
        break;
      case 'HTTP_REQUEST':
        add(step, 'source', `The data comes from ${c.url}.`);
        break;
      case 'FILTER': {
        const condition = c.condition ?? '';
        const plain = describeCondition(condition);
        const edges: string[] = [];
        if (/\bis (at least|at most)\b/.test(plain)) edges.push('a row exactly at the limit is kept');
        if (/\bis (less|more) than\b/.test(plain)) edges.push('a row exactly at the limit is left out');
        add(step, 'meaning', `Keep the rows where ${plain}${edges.length ? `: ${edges.join('; ')}` : ''}.`);
        for (const { written, column } of conditionColumns(condition, t.columnsIn)) {
          if (written !== column) add(step, `column:${column}`, `“${written}” means the column “${column}”.`);
        }
        if (mixesAndOr(condition)) add(step, 'and-or', '“and” is applied before “or” in this condition, as written.');
        break;
      }
      case 'TRANSFORM': {
        const op = parseTransform(c.operation ?? '');
        if (op.kind === 'select') {
          const gone = t.columnsIn.filter(col => !t.columnsOut.includes(col));
          if (gone.length) add(step, 'select', `Only the columns ${t.columnsOut.join(', ')} are kept; ${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} left out of the result.`);
        } else if (op.kind === 'drop') {
          add(step, 'drop', `The columns ${op.names.join(', ')} are removed from the result.`);
        } else if (op.kind === 'limit') {
          add(step, 'limit', `Only the first ${op.n} rows${sorted ? ', in the sorted order,' : ''} are kept.`);
        } else if (op.kind === 'sort') {
          sorted = true;
        } else if (op.kind === 'dedupe') {
          add(step, 'dedupe', `Rows count as repeats when ${op.by.length ? op.by.join(' and ') : 'every column'} match (capitals and spaces ignored); only the first copy is kept.`);
        } else if (op.kind === 'group') {
          add(step, 'group', op.by === null
            ? 'All rows are summarised into a single row; the individual rows are not in the result.'
            : `Rows with the same ${op.by} (capitals and spaces ignored) are combined into one row, so the individual rows are not in the result.`);
        } else if (op.kind === 'join') {
          add(step, 'join', `Each row is matched to the first row of ${op.dataset} with the same ${op.left}${op.right !== op.left ? ` / ${op.right}` : ''} (capitals and spaces ignored).`);
        }
        break;
      }
      case 'DATABASE':
        add(step, 'save', (c.mode ?? '').trim().toLowerCase() === 'append'
          ? `Each run adds the rows to the table “${c.table}” again.`
          : `Each run replaces the table “${c.table}” in your Data library.`);
        break;
    }
  }
  return out;
}

export interface Gate {
  canApprove: boolean;
  /** Critical exceptions without an accepted reason. */
  openCritical: RunException[];
  unconfirmed: Assumption[];
  /** Why approval is not possible, one sentence each. */
  blockers: string[];
}

/** Whether the result may be approved. `stale` means the workflow changed after this run. */
export function reviewGate(result: RunResult, assumptions: Assumption[], decisions: ReviewDecisions, stale = false): Gate {
  const openCritical = result.exceptions.filter(e => e.severity === 'critical' && !(canAccept(e) && (decisions.accepted[e.id] ?? '').trim().length >= MIN_REASON));
  const unconfirmed = assumptions.filter(a => !decisions.confirmed[a.id]);
  const blockers: string[] = [];
  if (stale) blockers.push('The workflow changed after this run. Run it again.');
  if (result.register && !result.register.balanced) blockers.push('The row totals do not add up, so this result cannot be approved.');
  const n = openCritical.filter(e => canAccept(e)).length;
  if (n) blockers.push(`${n} critical ${n === 1 ? 'exception needs' : 'exceptions need'} a decision: fix the workflow, or accept ${n === 1 ? 'it' : 'each'} with a reason.`);
  if (unconfirmed.length) blockers.push(`${unconfirmed.length} ${unconfirmed.length === 1 ? 'assumption is' : 'assumptions are'} not confirmed yet.`);
  return { canApprove: blockers.length === 0, openCritical, unconfirmed, blockers };
}

/* ---------------- fingerprints ---------------- */

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The part of a workflow that decides its result: step types and parameters, in order (names and positions do not count). */
export const workflowKey = (steps: Pick<Step, 'type' | 'config'>[]) =>
  JSON.stringify(steps.map(s => [s.type, Object.entries(s.config ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))]));

export const workflowHash = (steps: Pick<Step, 'type' | 'config'>[]) => sha256(workflowKey(steps));

export const tableHash = (t: { columns: string[]; rows: Record<string, string>[] }) =>
  sha256(JSON.stringify([t.columns, t.rows.map(r => t.columns.map(c => r[c] ?? ''))]));

/** Builds the approval record. Throws if the gate is closed, so an approval can never skip the review. */
export async function approve(
  steps: Step[], result: RunResult, assumptions: Assumption[], decisions: ReviewDecisions, approver: string, now = Date.now(),
): Promise<ApprovalRecord> {
  const gate = reviewGate(result, assumptions, decisions);
  if (!gate.canApprove) throw new Error(`This result cannot be approved yet. ${gate.blockers.join(' ')}`);
  const reg = result.register;
  return {
    approvedAt: now,
    approver: approver.trim() || 'Unnamed reviewer',
    workflowHash: await workflowHash(steps),
    inputHash: result.input ? await tableHash(result.input) : null,
    outputHash: await tableHash(result),
    source: reg?.source ?? null,
    counts: reg ? { total: reg.total, kept: reg.kept, excluded: reg.excluded, flagged: reg.flagged } : null,
    resultRows: result.rows.length,
    resolutions: result.exceptions
      .filter(e => e.severity === 'critical')
      .map(e => ({ exceptionId: e.id, message: e.message, note: (decisions.accepted[e.id] ?? '').trim() })),
    warnings: result.exceptions.filter(e => e.severity === 'warning').map(e => e.message),
    assumptions: assumptions.map(a => a.text),
  };
}

/** Reads an approval saved with a workflow, or null if it is missing or damaged. */
export function readApproval(raw: unknown): ApprovalRecord | null {
  const a = raw as Partial<ApprovalRecord> | null;
  if (!a || typeof a !== 'object' || typeof a.approvedAt !== 'number' || typeof a.workflowHash !== 'string' || typeof a.outputHash !== 'string') return null;
  return {
    approvedAt: a.approvedAt,
    approver: typeof a.approver === 'string' ? a.approver : '',
    workflowHash: a.workflowHash,
    inputHash: typeof a.inputHash === 'string' ? a.inputHash : null,
    outputHash: a.outputHash,
    source: typeof a.source === 'string' ? a.source : null,
    counts: a.counts && typeof a.counts === 'object' ? a.counts : null,
    resultRows: typeof a.resultRows === 'number' ? a.resultRows : 0,
    resolutions: Array.isArray(a.resolutions) ? a.resolutions : [],
    warnings: Array.isArray(a.warnings) ? a.warnings : [],
    assumptions: Array.isArray(a.assumptions) ? a.assumptions : [],
  };
}
