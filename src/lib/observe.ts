/**
 * What a test run of a workflow showed, in a form that may be sent to the AI.
 *
 * Privacy rule: an observation holds counts, column names, step parameters and the engine's own messages, never a
 * cell value. The rows stay in the browser; tests/observe.test.ts checks that no value from the data appears.
 *
 * Signals are the cheap, model-free hints that a workflow may not do what was asked. They cannot prove a result is
 * wrong (only the user knows what they meant); they say when it is worth asking the model to look again.
 */
import type { RunResult, Step } from '../types';
import { conditionColumns } from './engine.ts';
import { explainStep } from './explain.ts';
import { groundingFindings, type Finding, type GroundingKind } from './grounding.ts';

export type SignalKind = 'run_error' | 'no_rows' | 'skipped_step' | 'undecided_rows' | 'filter_kept_all' | GroundingKind;

/**
 * Signals worth asking the model about. `undecided_rows` is left to the person reviewing the result: blank or
 * non-numeric cells are a fact about the data, not a mistake in the plan. (Decided after tests/signal-analysis.ts
 * showed it fired on more right workflows than wrong ones, 18 to 10, over all saved runs including the holdout.)
 */
export const REVISE_ON: ReadonlySet<SignalKind> = new Set<SignalKind>(['run_error', 'no_rows', 'skipped_step', 'filter_kept_all', 'unused_value', 'wrong_column', 'invented_value', 'no_sort', 'mixed_logic']);

export interface Signal {
  kind: SignalKind;
  stepId?: string;
}

export interface Observation {
  signals: Signal[];
  /** The request-versus-workflow findings behind the grounding signals (empty without a request). */
  findings: Finding[];
  /** The text the AI would see. */
  text: string;
}

export type TestOutcome = { result: RunResult } | { error: string };

const isNumeric = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));

/** "40 rows: 39 numbers, 1 blank". Counts only. */
function columnProfile(rows: Record<string, string>[], column: string): string {
  let numbers = 0, blanks = 0, text = 0;
  for (const r of rows) {
    const v = r[column] ?? '';
    if (v.trim() === '') blanks++;
    else if (isNumeric(v)) numbers++;
    else text++;
  }
  const parts = [numbers && `${numbers} numbers`, text && `${text} text values`, blanks && `${blanks} blank`].filter(Boolean);
  return parts.join(', ') || 'no values';
}

/**
 * `request` (the user's own words) switches on the grounding checks: whether the workflow uses the values the request names,
 * and nothing else. Without it only the run itself is observed.
 */
export function observeRun(steps: Step[], outcome: TestOutcome, request?: string): Observation {
  const signals: Signal[] = [];
  const lines: string[] = [];

  if ('error' in outcome) {
    signals.push({ kind: 'run_error' });
    lines.push(`The run stopped with an error: ${outcome.error}`);
    return { signals, findings: [], text: lines.join('\n') };
  }

  const r = outcome.result;
  const byId = new Map(steps.map(s => [s.id, s]));
  r.trace.forEach((t, i) => {
    const step = byId.get(t.stepId);
    lines.push(`Step ${i + 1} (${t.type}${step ? `: ${explainStep(step)}` : ''}) ${t.rowsIn} rows in, ${t.rowsOut} rows out.${t.skipped ? ' This step did not run.' : ''}`);
    if (t.type === 'FILTER' && t.rowsIn >= 2 && t.rowsOut === t.rowsIn) signals.push({ kind: 'filter_kept_all', stepId: t.stepId });
    if (t.skipped) signals.push({ kind: 'skipped_step', stepId: t.stepId });
  });

  for (const e of r.exceptions) {
    if (e.kind === 'undecided_rows') signals.push({ kind: 'undecided_rows', stepId: e.stepId });
    if (e.kind !== 'skipped_step') lines.push(`Note: ${e.message}`);
  }
  if (r.register && r.rows.length === 0) signals.push({ kind: 'no_rows' });

  const findings = request ? groundingFindings(request, steps, r.input) : [];
  if (request) {
    for (const f of findings) {
      signals.push({ kind: f.kind, stepId: f.stepId });
      lines.push(`Check: ${f.text}`);
    }
  }

  // How the columns the conditions use are filled, so a model can tell text from numbers. Counts only.
  if (r.input) {
    const used = new Map<string, string>();
    for (const s of steps) {
      if (s.type !== 'FILTER') continue;
      for (const { column } of conditionColumns(s.config.condition ?? '', r.input.columns)) used.set(column, columnProfile(r.input.rows, column));
    }
    for (const [column, profile] of used) lines.push(`Column ${column} in the data: ${profile}.`);
  }
  lines.push(`The result has ${r.rows.length} ${r.rows.length === 1 ? 'row' : 'rows'}${r.columns.length ? ` and the columns ${r.columns.join(', ')}` : ''}.`);
  return { signals, findings, text: lines.join('\n') };
}
