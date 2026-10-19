import { applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { kindOf } from '../../data/nodeKinds';
import { NODE_GAP_X, NODE_Y, chainEdges, defaultPosition, newEdge, orderSteps } from '../../lib/flowGraph';
import { makeId } from '../../lib/id';
import { runFlow } from '../../lib/engine';
import { refineFlow } from '../../lib/api';
import { datasetBriefs } from '../../lib/library';
import { describeChanges, NO_CHANGE, reconcile } from '../../lib/refine';
import { approve, assumptionsFor, emptyDecisions, reviewGate, tableHash, workflowHash, workflowKey, type ReviewDecisions } from '../../lib/review';
import { runContext } from '../../lib/runContext';
import { errorCount, validateWorkflow } from '../../lib/validate';
import { buildReport } from '../../lib/xlsx';
import { usePreview } from './usePreview';
import type { Flow, FlowEdge, NodeRun, Position, RunResult, Step } from '../../types';

export interface StepData extends Record<string, unknown> {
  step: Step;
  run?: NodeRun;
}
export type StepNode = Node<StepData, 'step'>;

const toNode = (step: Step, index: number): StepNode => ({
  id: step.id,
  type: 'step',
  position: step.position ?? defaultPosition(index),
  data: { step },
});
const toEdge = (e: FlowEdge): Edge => ({ id: e.id, source: e.source, target: e.target, type: 'smoothstep' });

/** What we compare to decide whether anything worth saving has changed (selection and measurements are ignored). */
const signature = (name: string, steps: Step[], edges: Pick<FlowEdge, 'source' | 'target'>[]) =>
  JSON.stringify([
    name,
    steps.map(s => [s.id, s.type, s.name, s.description, s.config, Math.round(s.position?.x ?? 0), Math.round(s.position?.y ?? 0)]),
    edges.map(e => [e.source, e.target]),
  ]);

export function useFlowEditor(flow: Flow, save: (patch: Partial<Flow>) => void) {
  const [nodes, setNodes] = useState<StepNode[]>(() => flow.nodes.map(toNode));
  const [edges, setEdges] = useState<Edge[]>(() => flow.edges.map(toEdge));
  const [name, setName] = useState(flow.name);

  const [runs, setRuns] = useState<Record<string, NodeRun>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runError, setRunError] = useState('');
  const [refining, setRefining] = useState(false);
  // The steps as they were when the result on screen was produced, and the reviewer's decisions about that result.
  const [ran, setRan] = useState<{ steps: Step[]; key: string } | null>(null);
  const [decisions, setDecisions] = useState<ReviewDecisions>(emptyDecisions);

  const steps = useMemo<Step[]>(
    () => nodes.map(n => ({ ...n.data.step, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
    [nodes],
  );
  const flowEdges = useMemo<FlowEdge[]>(() => edges.map(e => ({ id: e.id, source: e.source, target: e.target })), [edges]);
  const issues = useMemo(() => validateWorkflow(steps, flowEdges), [steps, flowEdges]);
  const ordered = useMemo(() => orderSteps(steps, flowEdges), [steps, flowEdges]);
  const preview = usePreview(ordered, errorCount(issues) === 0);
  const selected = nodes.find(n => n.selected)?.data.step ?? null;

  /* ---------- Persist changes (debounced, flushed on leave) ---------- */
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const pending = useRef<Partial<Flow> | null>(null);

  useEffect(() => {
    const current = flowRef.current;
    if (signature(name, steps, flowEdges) === signature(current.name, current.nodes, current.edges)) {
      pending.current = null;
      return;
    }
    const patch = { name: name.trim() || 'Untitled workflow', nodes: steps, edges: flowEdges };
    pending.current = patch;
    const timer = setTimeout(() => {
      save(patch);
      pending.current = null;
    }, 350);
    return () => clearTimeout(timer);
  }, [name, steps, flowEdges, save]);

  useEffect(() => () => {
    if (pending.current) save(pending.current);
  }, [save]);

  /* ---------- Canvas handlers ---------- */
  const onNodesChange = useCallback((changes: NodeChange<StepNode>[]) => setNodes(ns => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges(es => applyEdgeChanges(changes, es)), []);

  const isValidConnection = useCallback(
    (c: Connection | Edge) => c.source !== c.target && !edges.some(e => e.source === c.source && e.target === c.target),
    [edges],
  );
  const onConnect = useCallback((c: Connection) => {
    if (c.source && c.target) setEdges(es => [...es, toEdge(newEdge(c.source!, c.target!))]);
  }, []);

  /* ---------- Editing ---------- */
  const addNode = useCallback((type: string, options: { at?: Position; append?: boolean } = {}) => {
    const kind = kindOf(type);
    if (!kind) return;
    const step: Step = { id: makeId(), type, name: kind.defaultName, description: kind.defaultDescription, config: { ...kind.defaultConfig } };

    setNodes(ns => {
      const rightmost = ns.reduce((m, n) => Math.max(m, n.position.x), Number.NEGATIVE_INFINITY);
      const position = options.at ?? { x: ns.length ? rightmost + NODE_GAP_X : 80, y: NODE_Y };
      return [...ns.map(n => (n.selected ? { ...n, selected: false } : n)), { ...toNode(step, 0), position, selected: true }];
    });

    if (options.append) {
      const hasOutgoing = new Set(flowEdges.map(e => e.source));
      const tail = orderSteps(steps, flowEdges).filter(s => !hasOutgoing.has(s.id) && s.type !== 'OUTPUT').pop();
      if (tail) setEdges(es => [...es, toEdge(newEdge(tail.id, step.id))]);
    }
    return step.id;
  }, [steps, flowEdges]);

  const patchStep = useCallback((id: string, patch: Partial<Step>) => {
    setNodes(ns => ns.map(n => (n.id === id ? { ...n, data: { ...n.data, step: { ...n.data.step, ...patch } } } : n)));
  }, []);

  const removeNode = useCallback((id: string) => {
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.source !== id && e.target !== id));
  }, []);

  const selectNode = useCallback((id: string | null) => {
    setNodes(ns => ns.map(n => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
  }, []);

  /* ---------- Run ---------- */
  const run = useCallback(async (): Promise<'blocked' | 'done' | 'failed'> => {
    if (running) return 'blocked';
    if (errorCount(issues)) return 'blocked';

    const ordered = orderSteps(steps, flowEdges);
    setRunning(true);
    setResult(null);
    setRunError('');
    setRuns(Object.fromEntries(ordered.map(s => [s.id, { state: 'waiting', message: 'Waiting' } as NodeRun])));
    setRan(null);
    setDecisions(emptyDecisions());
    try {
      const out = await runFlow(ordered, runContext, (id, state, message) => setRuns(r => ({ ...r, [id]: { state, message } })));
      setResult(out);
      setRan({ steps: ordered, key: workflowKey(ordered) });
      return 'done';
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'The run failed.');
      return 'failed';
    } finally {
      setRunning(false);
    }
  }, [running, issues, steps, flowEdges]);

  const clearRun = useCallback(() => {
    setRuns({});
    setResult(null);
    setRunError('');
    setRan(null);
    setDecisions(emptyDecisions());
  }, []);

  /* ---------- Review and approval of the result on screen ---------- */
  const currentKey = useMemo(() => workflowKey(ordered), [ordered]);
  const stale = !!ran && ran.key !== currentKey;
  const assumptions = useMemo(() => (result && ran ? assumptionsFor(ran.steps, result) : []), [result, ran]);
  const gate = useMemo(() => (result ? reviewGate(result, assumptions, decisions, stale) : null), [result, assumptions, decisions, stale]);

  const acceptException = useCallback((id: string, note: string) => setDecisions(d => ({ ...d, accepted: { ...d.accepted, [id]: note } })), []);
  const reopenException = useCallback((id: string) => setDecisions(d => {
    const { [id]: _gone, ...accepted } = d.accepted;
    return { ...d, accepted };
  }), []);
  const confirmAssumption = useCallback((id: string, value: boolean) => setDecisions(d => ({ ...d, confirmed: { ...d.confirmed, [id]: value } })), []);

  // Whether the saved approval still describes this workflow, and whether it belongs to the result on screen.
  const approval = flow.approval ?? null;
  const [approvalCurrent, setApprovalCurrent] = useState<boolean | null>(null);
  useEffect(() => {
    if (!approval) { setApprovalCurrent(null); return; }
    let live = true;
    void workflowHash(ordered).then(h => { if (live) setApprovalCurrent(h === approval.workflowHash); });
    return () => { live = false; };
    // `ordered` is read when its key changes
  }, [approval, currentKey]);
  const [resultHash, setResultHash] = useState('');
  useEffect(() => {
    if (!result) { setResultHash(''); return; }
    let live = true;
    void tableHash(result).then(h => { if (live) setResultHash(h); });
    return () => { live = false; };
  }, [result]);
  const approvalForResult = approval && approvalCurrent && resultHash && approval.outputHash === resultHash ? approval : null;

  const approveResult = useCallback(async (approver: string) => {
    if (!result || !ran || stale) throw new Error('Run the workflow again first.');
    const record = await approve(ran.steps, result, assumptions, decisions, approver);
    save({ approval: record });
    return record;
  }, [result, ran, stale, assumptions, decisions, save]);

  /** The Excel report of the result on screen: result, review and method. Marked as a draft unless approved. */
  const reportBytes = useCallback(() => {
    if (!result || !ran) return null;
    return buildReport({
      flowName: name, request: flow.description, steps: ran.steps, result, assumptions, decisions,
      approval: approvalForResult, checks: flow.checks ?? [], madeAt: new Date(),
    });
  }, [result, ran, name, flow.description, flow.checks, assumptions, decisions, approvalForResult]);

  /* ---------- Natural-language edit ---------- */
  const refine = useCallback(async (text: string): Promise<{ text: string; ok: boolean }> => {
    setRefining(true);
    try {
      const current = orderSteps(steps, flowEdges);
      const out = await refineFlow(current.map(s => ({ type: s.type, config: s.config })), text, undefined, await datasetBriefs());
      if (out.unchanged) return { text: NO_CHANGE, ok: false };
      if (!out.valid) {
        const why = out.issues.find(i => i.level === 'ERROR')?.message ?? 'it has errors';
        return { text: `I could not turn that into a valid workflow (${why}), so I changed nothing. Try describing the change differently.`, ok: false };
      }
      const next = reconcile(current, out.nodes);
      if (!next.changes.length && !next.reordered) return { text: NO_CHANGE, ok: false };

      const known = new Map(nodes.map(n => [n.id, n]));
      setNodes(next.steps.map((s, i) => ({ ...(known.get(s.id) ?? toNode(s, i)), position: defaultPosition(i), selected: false, data: { step: s } })));
      setEdges(chainEdges(next.steps).map(toEdge));
      clearRun();
      return { text: describeChanges(next), ok: true };
    } finally {
      setRefining(false);
    }
  }, [steps, flowEdges, nodes, clearRun]);

  return {
    nodes, edges, name, setName, steps, ordered, flowEdges, issues, selected, preview,
    onNodesChange, onEdgesChange, onConnect, isValidConnection,
    addNode, patchStep, removeNode, selectNode,
    runs, running, result, runError, run, clearRun,
    refine, refining,
    stale, assumptions, decisions, gate, acceptException, reopenException, confirmAssumption,
    approval, approvalCurrent, approvalForResult, approveResult, reportBytes, checks: flow.checks ?? [],
  };
}

export type FlowEditor = ReturnType<typeof useFlowEditor>;
