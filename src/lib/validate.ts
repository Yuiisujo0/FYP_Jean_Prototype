import { isSupported, kindOf, labelOf } from '../data/nodeKinds.ts';
import type { FlowEdge, Step, ValidationIssue } from '../types';
import { mixesAndOr } from './engine.ts';
import { orderSteps } from './flowGraph.ts';

type Edge = Pick<FlowEdge, 'source' | 'target'>;

/** Structural checks on a linear workflow. The same rules will later run on LLM output. */
export function validateWorkflow(steps: Step[], edges: Edge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (level: ValidationIssue['level'], message: string, nodeId?: string) => issues.push({ level, message, nodeId });

  if (!steps.length) {
    add('ERROR', 'The workflow has no operations yet.');
    return issues;
  }

  const ids = new Set(steps.map(s => s.id));
  const label = (s: Step) => s.name.trim() || labelOf(s.type);
  const ordered = orderSteps(steps, edges);

  if (!steps.some(s => kindOf(s.type)?.isSource)) add('ERROR', 'Add an input or data source to start the workflow.');

  for (const s of steps) {
    if (!isSupported(s.type)) add('ERROR', `Unsupported operation: ${s.type}.`, s.id);
    if (!s.name.trim()) add('ERROR', `A ${labelOf(s.type)} step needs a name.`, s.id);
    if (!s.description.trim()) add('WARNING', `${label(s)} could use a description.`, s.id);
    if (s.type === 'FILTER' && mixesAndOr(s.config?.condition ?? '')) {
      add('WARNING', `${label(s)} mixes “and” with “or” without brackets, and “and” is applied first. Add brackets if you meant otherwise.`, s.id);
    }
    for (const key of kindOf(s.type)?.required ?? []) {
      if (!s.config?.[key]?.trim()) add('ERROR', `${label(s)} needs a value for “${key.replaceAll('_', ' ')}”.`, s.id);
    }
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first && first.type === 'OUTPUT' && steps.length > 1) add('ERROR', 'An output cannot be the first step.', first.id);
  if (last && last.type !== 'OUTPUT') add('ERROR', 'End the workflow with an Output step.', last.id);

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      add('ERROR', 'A connection points to a step that no longer exists.');
      continue;
    }
    if (e.source === e.target) add('ERROR', 'A step cannot connect to itself.', e.source);
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    outgoing.set(e.source, (outgoing.get(e.source) ?? 0) + 1);
  }

  for (const s of steps) {
    const isSource = kindOf(s.type)?.isSource;
    if (!isSource && !incoming.get(s.id)) add('ERROR', `${label(s)} has no input connection.`, s.id);
    if (steps.length > 1 && s.type !== 'OUTPUT' && !outgoing.get(s.id)) add('WARNING', `${label(s)} is not connected to a next step.`, s.id);
    if ((incoming.get(s.id) ?? 0) > 1 || (outgoing.get(s.id) ?? 0) > 1) {
      add('WARNING', `${label(s)} branches. Only linear workflows are supported for now.`, s.id);
    }
  }

  return issues;
}

export const errorCount = (issues: ValidationIssue[]) => issues.filter(i => i.level === 'ERROR').length;
export const warningCount = (issues: ValidationIssue[]) => issues.filter(i => i.level === 'WARNING').length;
