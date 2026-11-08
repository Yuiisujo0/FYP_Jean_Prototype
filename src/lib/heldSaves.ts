/**
 * A workflow acts only after the person approves its result. A run therefore shows what each "save to table" step would
 * write, but writes nothing: the saves wait here until the result is approved. The engine still makes every check it
 * makes before a save, so a save that would be refused (onto uploaded data, or with the wrong columns) is refused at Run.
 */
import type { RunContext, SaveMode, Table } from './engine';
import type { RunResult } from '../types';

export interface HeldSave { stepId: string; name: string; table: Table; mode: SaveMode }

const rowsText = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

/** The run context with its saves kept in `held`, in the order the steps asked for them, instead of written. */
export function holdSaves(ctx: RunContext): { ctx: RunContext; held: Omit<HeldSave, 'stepId'>[] } {
  const held: Omit<HeldSave, 'stepId'>[] = [];
  return { ctx: { ...ctx, saveTable: async (name, table, mode) => { held.push({ name, table, mode }); } }, held };
}

/** What a held save will do, in the words the step shows until then. */
export function heldMessage(s: Pick<HeldSave, 'name' | 'table' | 'mode'>): string {
  const rows = rowsText(s.table.rows.length);
  return s.mode === 'append'
    ? `Will add ${rows} to “${s.name}” when you approve the result (nothing is saved yet)`
    : `Will save ${rows} to “${s.name}” when you approve the result (nothing is saved yet)`;
}

/** Pairs each held save with its step and says so in the result, so the run does not claim a save that has not happened. */
export function markHeld(result: RunResult, held: Omit<HeldSave, 'stepId'>[]): { result: RunResult; saves: HeldSave[] } {
  const saving = result.trace.filter(t => t.type === 'DATABASE');
  const saves = held.map((h, i) => ({ ...h, stepId: saving[i]?.stepId ?? '' })).filter(s => s.stepId);
  const byStep = new Map(saves.map(s => [s.stepId, s]));
  const trace = result.trace.map(t => (byStep.has(t.stepId) ? { ...t, message: heldMessage(byStep.get(t.stepId)!) } : t));
  return { result: { ...result, trace }, saves };
}

/** Writes the approved saves, in order, and says what each one did. */
export async function applySaves(ctx: RunContext, saves: HeldSave[]): Promise<{ stepId: string; message: string }[]> {
  const done: { stepId: string; message: string }[] = [];
  for (const s of saves) {
    const rows = rowsText(s.table.rows.length);
    const saved = await ctx.saveTable(s.name, s.table, s.mode);
    const message = s.mode === 'replace' ? `Saved ${rows} to “${s.name}” in the Data library (replaces earlier contents)`
      : saved && saved.created ? `Created “${s.name}” in the Data library with ${rows}`
      : `Added ${rows} to “${s.name}”${saved ? `, which now has ${rowsText(saved.total)}` : ''}`;
    done.push({ stepId: s.stepId, message });
  }
  return done;
}

/** The result with the steps' messages replaced, e.g. once the held saves are written. */
export function withMessages(result: RunResult, messages: { stepId: string; message: string }[]): RunResult {
  const byStep = new Map(messages.map(m => [m.stepId, m.message]));
  return { ...result, trace: result.trace.map(t => (byStep.has(t.stepId) ? { ...t, message: byStep.get(t.stepId)! } : t)) };
}
