/**
 * Choosing among several candidate workflows by running them.
 *
 * A small model is unreliable but not random: asked several times, the right answer tends to be the one that comes up
 * most often. Each candidate is run on the user's data (the same dry run the agent uses), those that fail, return nothing
 * or trip a signal are set aside, and among the rest the candidates are grouped by what they RETURN (columns and rows).
 * The largest group wins; a tie goes to the earliest candidate (the coolest, least random draft).
 *
 * No reference answer is used and no model is asked: the choice rests only on the runs. If no candidate runs cleanly the
 * first one is kept and the agent loop gets its usual chance to revise it.
 *
 * Privacy: the result rows are compared inside the browser; nothing about them is sent anywhere.
 */
import type { Step } from '../types';
import type { AgentDeps } from './agent.ts';
import { observeRun, REVISE_ON } from './observe.ts';

export interface Judged {
  /** ok: ran cleanly. flagged: ran but a signal fired (empty result, a step skipped, a filter kept all). error: the run stopped. blocked: could not be tested here. */
  verdict: 'ok' | 'flagged' | 'error' | 'blocked';
  /** What the run returned, as one string; candidates with the same signature returned the same table. */
  signature: string | null;
  /** Number of candidates that returned the same table (itself included); 0 when not ok. */
  votes: number;
}

export interface Pick {
  index: number;
  judged: Judged[];
  /** Why this one: 'majority' (clear winner), 'tie' (earliest of equals), 'single' (only one ran cleanly), 'none' (none ran cleanly, first kept), 'untestable'. */
  reason: 'majority' | 'tie' | 'single' | 'none' | 'untestable';
}

export async function pickByAgreement(candidates: Step[][], test: AgentDeps['test'], request?: string): Promise<Pick> {
  const judged: Judged[] = [];
  for (const steps of candidates) {
    const outcome = await test(steps);
    if ('blocked' in outcome) { judged.push({ verdict: 'blocked', signature: null, votes: 0 }); continue; }
    if ('error' in outcome) { judged.push({ verdict: 'error', signature: null, votes: 0 }); continue; }
    const flagged = observeRun(steps, outcome, request).signals.some(s => REVISE_ON.has(s.kind));
    const r = outcome.result;
    judged.push({ verdict: flagged ? 'flagged' : 'ok', signature: flagged ? null : JSON.stringify([r.columns, r.rows]), votes: 0 });
  }
  if (judged.length && judged.every(j => j.verdict === 'blocked')) return { index: 0, judged, reason: 'untestable' };

  const groups = new Map<string, number[]>();
  judged.forEach((j, i) => { if (j.signature !== null) groups.set(j.signature, [...(groups.get(j.signature) ?? []), i]); });
  for (const members of groups.values()) for (const i of members) judged[i].votes = members.length;
  if (!groups.size) return { index: 0, judged, reason: 'none' };

  const best = Math.max(...[...groups.values()].map(m => m.length));
  const winners = [...groups.values()].filter(m => m.length === best);
  const index = Math.min(...winners.map(m => m[0]));   // earliest member of the earliest winning group
  const reason = judged.filter(j => j.signature !== null).length === 1 ? 'single' : best > 1 && winners.length === 1 ? 'majority' : 'tie';
  return { index, judged, reason };
}
