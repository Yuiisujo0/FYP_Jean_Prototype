/**
 * The bounded agent: after a workflow is generated, it is run on the user's data (a dry run: nothing saved, no web
 * calls), the run is observed, and if something looks wrong the model is asked to revise it. Then it is run again.
 *
 *   plan (the model) → act (the engine runs it) → observe (signals and counts) → decide (stop, or fix and repeat)
 *
 * To fix, the agent has two tools and uses the cheaper one first: rules (src/lib/repair.ts: mechanical remedies for what the
 * request-versus-workflow checks found, applied in the browser in no time) and, for whatever is left, the model.
 *
 * Bounded on purpose: a fixed number of revisions, the same fixed operations, nothing saved or sent anywhere except the
 * observation text (counts and column names, never data values; see observe.ts), and a person reviews the result
 * before it counts. Every round is recorded so the user can see exactly what was sent and what changed.
 *
 * Pure orchestration: running and revising come in as functions, so tests/agent.test.ts drives it with fakes.
 */
import type { AgentRound, Step } from '../types';
import { observeRun, REVISE_ON, type TestOutcome } from './observe.ts';
import { describeChanges, reconcile } from './refine.ts';
import { repairByRules } from './repair.ts';

export interface RevisionReply {
  nodes: Step[];
  valid: boolean;
  unchanged: boolean;
  issues: { level: string; message: string }[];
}

export interface AgentDeps {
  /** Runs the steps as a dry run. `blocked` = the workflow cannot be tested without leaving the app (a web request). */
  test: (steps: Step[]) => Promise<TestOutcome | { blocked: string }>;
  /** Asks the model to revise the steps in the light of the observation. */
  revise: (steps: Step[], observation: string) => Promise<RevisionReply>;
  onRound?: (round: AgentRound) => void;
  /** The user's own request. With it the run is also checked against what the request says (src/lib/grounding.ts). */
  request?: string;
  /** Use the rule-based repairs before asking the model. On unless false (the evaluation turns it off to measure its effect). */
  rules?: boolean;
}

export interface AgentResult {
  steps: Step[];
  rounds: AgentRound[];
  /** clean: the last run showed nothing wrong. open: something still looks wrong. untestable: could not be run here. */
  status: 'clean' | 'open' | 'untestable';
}

export const MAX_REVISIONS = 2;

export async function checkByRunning(initial: Step[], deps: AgentDeps, maxRevisions = MAX_REVISIONS): Promise<AgentResult> {
  let steps = initial;
  const rounds: AgentRound[] = [];
  const record = (r: Omit<AgentRound, 'round'>) => {
    const round = { round: rounds.length + 1, ...r };
    rounds.push(round);
    deps.onRound?.(round);
  };

  for (let revisions = 0; ; revisions++) {
    const outcome = await deps.test(steps);
    if ('blocked' in outcome) {
      record({ signals: [], sent: '', outcome: 'untestable', detail: `Not tested here: ${outcome.blocked}` });
      return { steps, rounds, status: 'untestable' };
    }
    const obs = observeRun(steps, outcome, deps.request);
    const all = [...new Set(obs.signals.map(s => s.kind))];
    const signals = all.filter(k => REVISE_ON.has(k));
    if (!signals.length) {
      const note = all.includes('undecided_rows') ? ' Some rows could not be checked (blank or not a number); you decide about them when you review the result.' : '';
      record({ signals: all, sent: '', outcome: 'clean', detail: `Ran it on your data: nothing looked wrong with the plan.${note}` });
      return { steps, rounds, status: 'clean' };
    }
    if (revisions >= maxRevisions) {
      record({ signals, sent: '', outcome: 'limit', detail: `Ran it on your data: ${describeSignals(signals)} Stopped after ${maxRevisions} revisions; review it yourself.` });
      return { steps, rounds, status: 'open' };
    }

    const fix = deps.rules !== false && deps.request && 'result' in outcome ? repairByRules(deps.request, steps, obs.findings, outcome.result.input) : null;
    if (fix) {
      record({ signals, sent: '', outcome: 'repaired', detail: `Ran it on your data: ${describeSignals(signals)} Fixed without asking the AI: ${fix.notes.join(' ')}` });
      steps = fix.steps;
      continue;
    }

    let reply: RevisionReply;
    try {
      reply = await deps.revise(steps, obs.text);
    } catch (e) {
      record({ signals, sent: obs.text, outcome: 'failed', detail: `Ran it on your data: ${describeSignals(signals)} The AI could not be asked to revise it (${e instanceof Error ? e.message : 'error'}).` });
      return { steps, rounds, status: 'open' };
    }
    if (reply.unchanged) {
      record({ signals, sent: obs.text, outcome: 'unchanged', detail: `Ran it on your data: ${describeSignals(signals)} The AI kept the workflow as it was.` });
      return { steps, rounds, status: 'open' };
    }
    if (!reply.valid) {
      const why = reply.issues.find(i => i.level === 'ERROR')?.message ?? 'it has errors';
      record({ signals, sent: obs.text, outcome: 'invalid', detail: `Ran it on your data: ${describeSignals(signals)} The AI's revision was not valid (${why}), so it was not used.` });
      return { steps, rounds, status: 'open' };
    }
    const next = reconcile(steps, reply.nodes);
    if (!next.changes.length && !next.reordered) {
      record({ signals, sent: obs.text, outcome: 'unchanged', detail: `Ran it on your data: ${describeSignals(signals)} The AI kept the workflow as it was.` });
      return { steps, rounds, status: 'open' };
    }
    record({ signals, sent: obs.text, outcome: 'revised', detail: `Ran it on your data: ${describeSignals(signals)} Revised: ${describeChanges(next)}` });
    steps = next.steps;
  }
}

const SIGNAL_TEXT: Record<string, string> = {
  unused_value: 'the request names a value that no filter uses.',
  wrong_column: 'a value from the request is compared with the wrong column.',
  invented_value: 'a filter uses a value the request does not mention.',
  no_sort: 'the request asks for a ranking but nothing sorts the rows.',
  mixed_logic: 'and / or are mixed without brackets.',
  run_error: 'the run stopped with an error.',
  no_rows: 'the result was empty.',
  skipped_step: 'a step did not run.',
  undecided_rows: 'some rows could not be checked (blank or not a number).',
  filter_kept_all: 'a filter kept every row, so it may not be doing anything.',
};

export const describeSignals = (signals: string[]) => signals.map(s => SIGNAL_TEXT[s] ?? s).join(' ').replace(/^./, c => c.toUpperCase());
