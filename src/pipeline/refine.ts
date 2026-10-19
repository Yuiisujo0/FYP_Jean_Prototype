/**
 * Changing an existing workflow: from a plain-English instruction (refine), or from what a test run showed (revise,
 * the agent's observe-and-revise step). Ports of refine_workflow and revise_workflow in backend/app/llm.py.
 * The model sees the workflow and the instruction or run report, never any data values.
 */
import type { Step, ValidationIssue } from '../types';
import { normalizeConfig } from './build.ts';
import { converse, type Attempt, type GenerateOptions } from './generate.ts';
import { refineMessages, reviseMessages } from './prompt.ts';
import type { ChatMessage } from './types.ts';

export interface StepInput {
  type: string;
  config: Record<string, string>;
}

export interface RefineResult {
  /** The whole workflow after the change, with names and descriptions. */
  nodes: Step[];
  valid: boolean;
  issues: ValidationIssue[];
  attempts: Attempt[];
  elapsedMs: number;
  model: string;
  neurons: number;
  /** The model returned the workflow as it was. */
  unchanged: boolean;
}

const sameConfig = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => k in b && a[k] === b[k]);
};

/** Asks for a whole new version of `steps` and reports whether it differs. Shared by refining and revising. */
async function editWorkflow(steps: StepInput[], messages: ChatMessage[], title: string, options: GenerateOptions): Promise<RefineResult> {
  const started = Date.now();
  const c = await converse(messages, title, options);
  const before = steps.map(s => ({ type: s.type, config: normalizeConfig(s.type, s.config) }));
  const after = c.flow.nodes;
  const unchanged = before.length === after.length && before.every((b, i) => b.type === after[i].type && sameConfig(b.config, after[i].config));
  return {
    nodes: c.flow.nodes,
    valid: c.issues.every(i => i.level !== 'ERROR'),
    issues: c.issues,
    attempts: c.attempts,
    elapsedMs: Date.now() - started,
    model: c.model,
    neurons: c.attempts.reduce((sum, a) => sum + a.neurons, 0),
    unchanged,
  };
}

export function refineWorkflow(steps: StepInput[], instruction: string, options: GenerateOptions): Promise<RefineResult> {
  return editWorkflow(steps, refineMessages(steps, instruction, options.datasets ?? [], options.hints ?? true), instruction, options);
}

/** Revises `steps` given what a test run showed (counts and column names; see src/lib/observe.ts). */
export function reviseWorkflow(request: string, steps: StepInput[], observation: string, options: GenerateOptions): Promise<RefineResult> {
  return editWorkflow(steps, reviseMessages(request, steps, observation, options.datasets ?? [], options.hints ?? true), request, options);
}
