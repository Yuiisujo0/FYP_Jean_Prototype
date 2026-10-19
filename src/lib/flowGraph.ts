import type { FlowEdge, Position, Step } from '../types';
import { makeId } from './id.ts';

export const NODE_GAP_X = 264;
export const NODE_Y = 150;

/**
 * Returns steps in execution order by following edges from the nodes that
 * have no incoming connection. Anything unreachable (cycles, strays) is
 * appended so no step ever disappears from view.
 */
export function orderSteps(steps: Step[], edges: Pick<FlowEdge, 'source' | 'target'>[]): Step[] {
  const byId = new Map(steps.map(s => [s.id, s]));
  const next = new Map<string, string>();
  const hasIncoming = new Set<string>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (!next.has(e.source)) next.set(e.source, e.target);
    hasIncoming.add(e.target);
  }

  const seen = new Set<string>();
  const out: Step[] = [];
  const walk = (start: Step) => {
    let cur: Step | undefined = start;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      const nextId = next.get(cur.id);
      cur = nextId ? byId.get(nextId) : undefined;
    }
  };

  steps.filter(s => !hasIncoming.has(s.id)).forEach(walk);
  steps.forEach(walk);
  return out;
}

export const chainEdges = (steps: Pick<Step, 'id'>[]): FlowEdge[] =>
  steps.slice(1).map((s, i) => ({ id: `e-${steps[i].id}-${s.id}`, source: steps[i].id, target: s.id }));

export const defaultPosition = (index: number): Position => ({ x: 80 + index * NODE_GAP_X, y: NODE_Y });

export const withPositions = (steps: Step[]): Step[] =>
  steps.map((s, i) => (s.position ? s : { ...s, position: defaultPosition(i) }));

export const newEdge = (source: string, target: string): FlowEdge => ({ id: `e-${source}-${target}-${makeId()}`, source, target });
