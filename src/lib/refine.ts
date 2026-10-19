/**
 * Applying a refined workflow to the one on the canvas.
 *
 * The model returns the whole workflow again. `reconcile` keeps every step it left alone (same id, position and any
 * renaming), pairs the rest as edits, and reports what really changed. `describeChanges` then says so in plain English
 * built from the steps themselves, so the user is told what changed rather than what the model claims it did.
 */
import type { Step } from '../types';
import { explainStep } from './explain.ts';

export interface Change {
  kind: 'added' | 'removed' | 'changed';
  before?: Step;
  after?: Step;
}

export interface Reconciled {
  /** The workflow after the change, in the model's order. */
  steps: Step[];
  changes: Change[];
  /** The same steps in a different order. */
  reordered: boolean;
}

const key = (s: Step) => JSON.stringify([s.type, Object.entries(s.config).sort(([a], [b]) => (a < b ? -1 : 1))]);

export function reconcile(current: Step[], proposed: Step[]): Reconciled {
  const usedOld = new Set<number>();
  const result: (Step | null)[] = proposed.map(() => null);
  const matchedOldIndex: number[] = [];

  // Pass 1: a step the model returned exactly as it was keeps its identity, position and name.
  proposed.forEach((p, i) => {
    const at = current.findIndex((c, j) => !usedOld.has(j) && key(c) === key(p));
    if (at >= 0) { usedOld.add(at); result[i] = current[at]; matchedOldIndex.push(at); }
  });

  // Pass 2: the leftovers of the same type, in order, are edits of each other.
  const changes: Change[] = [];
  proposed.forEach((p, i) => {
    if (result[i]) return;
    const at = current.findIndex((c, j) => !usedOld.has(j) && c.type === p.type);
    if (at >= 0) {
      usedOld.add(at);
      result[i] = { ...p, id: current[at].id, position: current[at].position };
      changes.push({ kind: 'changed', before: current[at], after: result[i]! });
    } else {
      result[i] = p;
      changes.push({ kind: 'added', after: p });
    }
  });

  current.forEach((c, j) => { if (!usedOld.has(j)) changes.push({ kind: 'removed', before: c }); });

  const reordered = matchedOldIndex.some((v, i) => i > 0 && v < matchedOldIndex[i - 1]);
  return { steps: result as Step[], changes, reordered };
}

/** What changed, in plain English, from the steps themselves. */
export function describeChanges({ changes, reordered }: Pick<Reconciled, 'changes' | 'reordered'>): string {
  const parts = changes.map(c =>
    c.kind === 'added' ? `Added a step. ${explainStep(c.after!)}`
      : c.kind === 'removed' ? `Removed a step. It used to say: ${explainStep(c.before!)}`
        : `Changed a step. It now says: ${explainStep(c.after!)}`);
  if (reordered) parts.push('Changed the order of the steps.');
  return parts.join(' ');
}

export const NO_CHANGE = 'I did not change anything. The workflow may already do that, or it cannot be done with the available steps. Try describing the change differently.';
