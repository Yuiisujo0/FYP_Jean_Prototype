/**
 * A second opinion on a finished workflow. A wrong plan that runs without an error is the hardest mistake to see, so a
 * second plan is written by another model, tested the same way, and both are run on the user's data. Different answers become
 * a critical exception: one of the two plans is wrong, and only a person can say which. Agreement is reported too, but
 * it proves nothing on its own, because both plans can make the same mistake.
 *
 * Privacy: the rows are compared inside the browser. What is saved is the row counts and the second plan in words.
 * Pure orchestration, like agent.ts: drafting, checking and running come in as functions.
 */
import type { RunException, RunResult, SecondOpinion, Step } from '../types';
import { explainStep } from './explain.ts';
import type { TestOutcome } from './observe.ts';
import { workflowKey } from './review.ts';

type Table = Pick<RunResult, 'columns' | 'rows'>;

const rowKey = (row: Record<string, string>, columns: string[]) => JSON.stringify(columns.map(c => (row[c] ?? '').trim().toLowerCase()));

/**
 * same: the same table. similar: the same rows, with other columns or in another order, which two right plans often give.
 * different: other rows, or no column in common to compare.
 */
export function compareAnswers(a: Table, b: Table): 'same' | 'similar' | 'different' {
  const shared = a.columns.filter(c => b.columns.includes(c));
  if (!shared.length || a.rows.length !== b.rows.length) return 'different';
  const left = a.rows.map(r => rowKey(r, shared));
  const right = b.rows.map(r => rowKey(r, shared));
  if ([...left].sort().join('\n') !== [...right].sort().join('\n')) return 'different';
  const sameColumns = shared.length === a.columns.length && shared.length === b.columns.length;
  return sameColumns && left.every((k, i) => k === right[i]) ? 'same' : 'similar';
}

export interface SecondOpinionTools {
  /** Writes the second plan, or null if the model gave nothing valid. */
  draft: () => Promise<Step[] | null>;
  /** Tests and fixes it the way the first plan was tested and fixed. */
  check: (steps: Step[]) => Promise<Step[]>;
  /** A dry run: nothing saved, no web calls. */
  test: (steps: Step[]) => Promise<TestOutcome | { blocked: string }>;
}

const rowsText = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

/** Never throws: a second opinion that cannot be had must not stop the workflow. */
export async function secondOpinion(first: Step[], tools: SecondOpinionTools): Promise<SecondOpinion> {
  const key = workflowKey(first);
  const notDone = (detail: string): SecondOpinion => ({ workflowKey: key, outcome: 'not_done', detail, secondPlan: [] });
  try {
    const drafted = await tools.draft();
    if (!drafted) return notDone('No second opinion: the second plan was not valid.');
    const second = await tools.check(drafted);
    if (workflowKey(second) === key) {
      return { workflowKey: key, outcome: 'same_plan', detail: 'The second model wrote the same plan, so it adds little evidence.', secondPlan: [] };
    }
    const secondPlan = second.map(explainStep);
    const [one, two] = [await tools.test(first), await tools.test(second)];
    if (!('result' in one) || !('result' in two)) return notDone('No second opinion: the two plans could not both be run here.');

    const rows = { first: one.result.rows.length, second: two.result.rows.length };
    const answer = compareAnswers(one.result, two.result);
    if (answer === 'same') return { workflowKey: key, outcome: 'same_answer', detail: 'A second plan, by another model, gave the same answer.', secondPlan, rows };
    if (answer === 'similar') return { workflowKey: key, outcome: 'similar_answer', detail: 'A second plan, by another model, found the same rows, with other columns or in another order.', secondPlan, rows };
    return {
      workflowKey: key, outcome: 'different', secondPlan, rows,
      detail: `A second plan, by another model, gave a different answer: this workflow found ${rowsText(rows.first)}, the second plan ${rowsText(rows.second)}.`,
    };
  } catch {
    return notDone('No second opinion: the second plan could not be written.');
  }
}

/** The opinion still applies while the workflow is the one it was made for. */
export const opinionFor = (opinion: SecondOpinion | undefined, steps: Step[]) => (opinion && opinion.workflowKey === workflowKey(steps) ? opinion : undefined);

/** Different answers are a critical exception on the result, so the existing review, approval and report handle them. */
export function secondOpinionException(opinion: SecondOpinion | undefined, steps: Step[]): RunException | null {
  const current = opinionFor(opinion, steps);
  if (current?.outcome !== 'different' || !steps.length) return null;
  return {
    id: 'second-opinion', stepId: steps[0].id, stepName: 'Second opinion', kind: 'second_opinion', severity: 'critical', rows: [],
    message: `${current.detail} One of them is wrong. The second plan: ${current.secondPlan.join(' ')}`,
  };
}

const OUTCOMES = new Set<SecondOpinion['outcome']>(['same_plan', 'same_answer', 'similar_answer', 'different', 'not_done']);

/** Reads an opinion saved with a workflow, or undefined if it is missing or damaged. */
export function readSecondOpinion(raw: unknown): SecondOpinion | undefined {
  const o = raw as Partial<SecondOpinion> | null;
  if (!o || typeof o !== 'object' || typeof o.workflowKey !== 'string' || typeof o.detail !== 'string' || !OUTCOMES.has(o.outcome!)) return undefined;
  return {
    workflowKey: o.workflowKey, outcome: o.outcome!, detail: o.detail,
    secondPlan: Array.isArray(o.secondPlan) ? o.secondPlan.filter(s => typeof s === 'string') : [],
    ...(o.rows && typeof o.rows.first === 'number' && typeof o.rows.second === 'number' ? { rows: { first: o.rows.first, second: o.rows.second } } : {}),
  };
}
