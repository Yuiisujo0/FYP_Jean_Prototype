import { Background, BackgroundVariant, MiniMap, Panel, ReactFlow, SelectionMode, useReactFlow, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Database, MessageSquare, PanelLeftClose, PanelRightClose, Plus, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { useSlider } from '../../components/ui/useSlider';
import { categoryOf } from '../../data/nodeKinds';
import { reducedMotion } from '../../lib/motion';
import { whyNoAnswer } from '../../lib/whyNoAnswer';
import { errorCount } from '../../lib/validate';
import { KEYS, readString, writeString } from '../../lib/storage';
import { useDatasets } from '../../state/useDatasets';
import { useWorkspace } from '../../state/WorkspaceContext';
import type { Flow } from '../../types';
import { AskPanel } from './AskPanel';
import { CanvasDock, SelectionBar, type CanvasTool } from './CanvasDock';
import { CheckPanel } from './CheckPanel';
import { EditorToolbar } from './EditorToolbar';
import { FlowNode } from './FlowNode';
import { Inspector } from './Inspector';
import { LayoutMenu } from './LayoutMenu';
import { useEditorLayout, type LogsDock } from './layout';
import { LogsPanel } from './LogsPanel';
import { DRAG_TYPE, NodeLibrary } from './NodeLibrary';
import { NoAnswerNotice } from './NoAnswerNotice';
import { ResultView, runsWithoutSideEffects } from './ResultView';
import { useFlowEditor, type StepNode } from './useFlowEditor';
import './Editor.css';

const NODE_TYPES = { step: FlowNode };
type Tab = 'add' | 'inspect' | 'ask' | 'check';
export type View = 'result' | 'steps';

const PANEL_MIN = 280;
const PANEL_DEFAULT = 316;
const clampPanel = (w: number) => Math.round(Math.min(Math.max(w, PANEL_MIN), Math.min(760, window.innerWidth * 0.65)));

/** The width of the right-hand tools panel. The user drags the bar on its left edge (or uses the arrow keys); it is remembered. */
function useSidePanelWidth(side: 'left' | 'right') {
  const [width, setWidth] = useState(() => clampPanel(Number(readString(KEYS.sidePanel, '')) || PANEL_DEFAULT));
  const [dragging, setDragging] = useState(false);
  const commit = useCallback((w: number) => { setWidth(w); writeString(KEYS.sidePanel, String(w)); }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = width;
    setDragging(true);
    const move = (ev: PointerEvent) => { latest = clampPanel(startW + (side === 'right' ? startX - ev.clientX : ev.clientX - startX)); setWidth(latest); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      commit(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 80 : 24;
    const grow = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
    const shrink = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) { e.preventDefault(); commit(clampPanel(width + step)); }
    else if (e.key === shrink) { e.preventDefault(); commit(clampPanel(width - step)); }
    else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); commit(PANEL_DEFAULT); }
  };
  return { width, dragging, onPointerDown, onKeyDown, reset: () => commit(PANEL_DEFAULT) };
}

export function Editor({ flow }: { flow: Flow }) {
  const { updateFlow, exportFlow } = useWorkspace();
  const save = useCallback((patch: Partial<Flow>) => updateFlow(flow.id, patch), [updateFlow, flow.id]);
  const editor = useFlowEditor(flow, save);
  const arrange = useEditorLayout();
  const { shown } = arrange;
  const panel = useSidePanelWidth(shown.tools);
  const { nodes, edges, runs, issues, selected, selectedIds } = editor;
  const { screenToFlowPosition, fitView, getZoom } = useReactFlow();
  const [tool, setTool] = useState<CanvasTool>('move');
  const [help, setHelp] = useState(false);
  // The step added a moment ago: it arrives with a small motion and the view slides over to it.
  const [arrived, setArrived] = useState('');
  // A workflow with steps opens on its result; the canvas ("How it was done") is for building and inspecting the steps.
  const location = useLocation();
  const fresh = !!(location.state as { fresh?: boolean } | null)?.fresh;
  const [view, setView] = useState<View>(() => (fresh || flow.nodes.length ? 'result' : 'steps'));
  const [tab, setTab] = useState<Tab>(() => (fresh ? 'check' : 'add'));
  const { items: datasets, refresh: refreshDatasets } = useDatasets();
  // The tools panel on the right folds away to a slim rail, so the canvas and the logs get the room; it is remembered.
  const [toolsOpen, setToolsOpenState] = useState(() => fresh || readString(KEYS.toolsOpen, 'closed') === 'open');
  const setToolsOpen = (open: boolean) => { setToolsOpenState(open); writeString(KEYS.toolsOpen, open ? 'open' : 'closed'); };
  const openTab = (t: Tab) => { setTab(t); setToolsOpen(true); };

  // When the arrangement changes (the Logs move or fold, the tools open, close or switch side), the canvas changes size:
  // frame the steps again once the panels have finished sliding. Resizing a panel by hand keeps the person's own view.
  const refit = useCallback(() => {
    window.setTimeout(() => void fitView({ padding: 0.12, maxZoom: 1, duration: reducedMotion() ? 0 : 300 }), 260);
  }, [fitView]);
  const firstArrangement = useRef(true);
  useEffect(() => {
    if (firstArrangement.current) { firstArrangement.current = false; return; }
    if (view === 'steps') refit();
  }, [shown.logs, shown.tools, toolsOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Moving the Logs: drag their grip, and the left, right and bottom edges of the work area light up; drop on one to put
  // the Logs there. Escape or dropping anywhere else leaves them where they were.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState<{ zone: LogsDock | null } | null>(null);
  const startMove = (e: React.PointerEvent) => {
    const box = bodyRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const zoneAt = (x: number, y: number): LogsDock | null => {
      const fx = (x - box.left) / box.width, fy = (y - box.top) / box.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
      if (fx < 0.25) return 'left';
      if (fx > 0.75) return 'right';
      return fy > 0.55 ? 'bottom' : null;
    };
    setMoving({ zone: zoneAt(e.clientX, e.clientY) });
    const move = (ev: PointerEvent) => setMoving({ zone: zoneAt(ev.clientX, ev.clientY) });
    const stop = (ev: PointerEvent | KeyboardEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('keydown', key);
      setMoving(null);
      if ('clientX' in ev) { const z = zoneAt(ev.clientX, ev.clientY); if (z) arrange.setLogs(z); }
    };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') stop(ev); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('keydown', key);
  };
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabSlider = useSlider(tabsRef, '[role="tab"][aria-selected="true"]', [tab, toolsOpen]);

  // Leave the Inspect tab when the selection goes away (pane click, Delete key).
  const anySelected = selectedIds.length > 0;
  useEffect(() => {
    if (!anySelected && tab === 'inspect') setTab('add');
  }, [anySelected, tab]);

  // Why this workflow cannot give an answer (no data, a missing table, a step that cannot run), in plain words.
  // Only judged once the library has loaded.
  const noAnswer = useMemo(() => whyNoAnswer(editor.steps, datasets), [datasets, editor.steps]);

  // How many rows go into and come out of each step: from the run on screen, or else from the live preview (a dry run).
  const counted = editor.result && !editor.stale ? editor.result : editor.preview.status === 'ready' ? editor.preview.result : null;
  const flowRows = useMemo(() => {
    if (!counted) return null;
    const most = Math.max(1, ...counted.trace.map(t => Math.max(t.rowsIn, t.rowsOut)));
    return new Map(counted.trace.map(t => [t.stepId, { in: t.rowsIn, out: t.rowsOut, most }]));
  }, [counted]);
  const orderOf = useMemo(() => new Map(editor.ordered.map((s, i) => [s.id, i + 1])), [editor.ordered]);

  const displayNodes = useMemo<StepNode[]>(
    () => nodes.map(n => ({
      ...n,
      className: n.id === arrived ? 'is-new' : undefined,
      data: { ...n.data, run: runs[n.id], order: orderOf.get(n.id), rows: flowRows?.get(n.id) },
    })),
    [nodes, runs, orderOf, flowRows, arrived],
  );
  const displayEdges = useMemo<Edge[]>(
    () => edges.map(e => {
      const from = runs[e.source]?.state;
      const to = runs[e.target]?.state;
      if (from === 'complete' && to === 'running') return { ...e, animated: true };
      if (from === 'complete' && to === 'complete') return { ...e, className: 'is-done' };
      return e;
    }),
    [edges, runs],
  );

  const run = async () => {
    if (view === 'steps') setTab('check');
    await editor.run();
  };

  // The result view shows the answer straight away when that is safe: the steps only read and reshape data here.
  // A failed run leaves runError set, so this does not retry in a loop.
  const canAutoRun = view === 'result' && !editor.result && !editor.running && !editor.runError
    && errorCount(issues) === 0 && runsWithoutSideEffects(editor);
  useEffect(() => {
    if (canAutoRun) void editor.run();
    // `editor.run` changes on every edit; the conditions above are what matter
  }, [canAutoRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusNode = (id: string) => {
    const mounted = view === 'steps';
    setView('steps');
    editor.selectNode(id);
    openTab('inspect');
    // Coming from the result view, the canvas needs a frame to mount before it can be framed.
    const frame = () => void fitView({ nodes: [{ id }], duration: 350, maxZoom: 1, padding: 0.6 });
    if (mounted) frame(); else setTimeout(frame, 80);
  };

  const refine = async (text: string) => {
    const result = await editor.refine(text);
    // Give React a frame to mount any new nodes before framing the whole flow again.
    if (result.ok) setTimeout(() => void fitView({ padding: 0.12, maxZoom: 1, duration: 350 }), 60);
    return result;
  };

  const welcome = (id: string | undefined) => {
    if (!id) return;
    setArrived(id);
    setTimeout(() => setArrived(a => (a === id ? '' : a)), 700);
  };

  // A step added from the list goes to the end of the flow, which may be off screen: the view slides over to it,
  // at the zoom the person already has (unless that is too far out to read the new step).
  const addFromLibrary = (type: string) => {
    const id = editor.addNode(type, { append: true });
    setTab('inspect');
    welcome(id);
    if (!id) return;
    const zoom = Math.min(Math.max(getZoom(), 0.7), 1);
    setTimeout(() => void fitView({ nodes: [{ id }], minZoom: zoom, maxZoom: zoom, duration: reducedMotion() ? 0 : 450 }), 80);
  };

  const onDrop = (e: DragEvent) => {
    const type = e.dataTransfer.getData(DRAG_TYPE);
    if (!type) return;
    e.preventDefault();
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    welcome(editor.addNode(type, { at: { x: p.x - 118, y: p.y - 55 } }));
    setTab('inspect');
  };

  // New data: check the library again, redo the preview, and run again if that is safe, so old "no data" messages go.
  const dataAdded = async () => {
    await refreshDatasets();
    editor.dataChanged();
    if (errorCount(issues) === 0 && runsWithoutSideEffects(editor)) await editor.run();
    else editor.clearRun();
  };

  const notice = (compact = false) => noAnswer && (
    <NoAnswerNotice why={noAnswer} request={flow.description} onFocusNode={focusNode} onDataAdded={dataAdded} compact={compact} />
  );

  const tabs: { id: Tab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'add', label: 'Add', icon: <Plus size={17} aria-hidden /> },
    { id: 'inspect', label: 'Inspect', icon: <SlidersHorizontal size={17} aria-hidden /> },
    { id: 'ask', label: 'Ask', icon: <MessageSquare size={17} aria-hidden /> },
    { id: 'check', label: 'Check', icon: <ShieldCheck size={17} aria-hidden />, count: issues.length },
  ];

  const canvasEl = (
    <div className={`editor__canvas is-${tool}`} onDragOver={e => e.dataTransfer.types.includes(DRAG_TYPE) && e.preventDefault()} onDrop={onDrop}>
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={editor.onNodesChange}
        onEdgesChange={editor.onEdgesChange}
        onConnect={editor.onConnect}
        isValidConnection={editor.isValidConnection}
        // A click on a step is for changing it: its settings open, and the logs follow it too.
        onNodeClick={() => openTab('inspect')}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.3}
        snapToGrid
        snapGrid={[10, 10]}
        deleteKeyCode={['Backspace', 'Delete']}
        // "Move": dragging the background slides the view. "Select": it draws a box, and the middle or right button slides.
        panOnDrag={tool === 'move' ? true : [1, 2]}
        selectionOnDrag={tool === 'select'}
        selectionMode={SelectionMode.Partial}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="var(--grid-dot)" />
        {/* A map only earns its corner once the flow is too long to see at a glance. */}
        {nodes.length > 8 && (
          <MiniMap pannable zoomable position="bottom-right" style={{ width: 150, height: 96 }} nodeColor={n => `var(--c-${categoryOf((n as StepNode).data.step.type)})`} nodeStrokeWidth={0} />
        )}
        {noAnswer && (
          <Panel position="top-left">
            <div className="editor__top">{notice(true)}</div>
          </Panel>
        )}
        {selectedIds.length > 1 && (
          <Panel position="top-center">
            <SelectionBar count={selectedIds.length} onDelete={() => editor.removeNodes(selectedIds)} onClear={() => editor.selectNode(null)} />
          </Panel>
        )}
        <Panel position="bottom-center">
          <CanvasDock tool={tool} onTool={setTool} help={help} onHelp={setHelp} />
        </Panel>
      </ReactFlow>

      {nodes.length === 0 && (
        <div className="editor__empty">
          <h3>Start your workflow</h3>
          <p>Add a source such as a CSV or HTTP request, then connect the steps in order.</p>
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => addFromLibrary('INPUT')}>Add an input</Button>
        </div>
      )}
    </div>
  );

  const logsEl = (
    <LogsPanel
      steps={editor.ordered}
      runs={runs}
      result={counted}
      isPreview={!(editor.result && !editor.stale)}
      running={editor.running}
      runError={editor.runError}
      previewNote={editor.preview.status === 'failed' || editor.preview.status === 'blocked' ? editor.preview.message : undefined}
      selectedId={selected?.id ?? null}
      onSelect={id => editor.selectNode(id)}
      onFold={refit}
      dock={shown.logs}
      onMoveStart={arrange.narrow ? undefined : startMove}
      layoutMenu={<LayoutMenu layout={arrange.layout} narrow={arrange.narrow} onLogs={arrange.setLogs} onTools={arrange.setTools} onReset={arrange.reset} up={shown.logs === 'bottom'} />}
    />
  );

  const resizeEl = (
    <div
      className={`editor__resize ${panel.dragging ? 'is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the tools panel"
      aria-valuenow={panel.width}
      aria-valuemin={PANEL_MIN}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={panel.onPointerDown}
      onKeyDown={panel.onKeyDown}
      onDoubleClick={panel.reset}
    />
  );
  const asideEl = (
    <aside className="editor__side" aria-label="Workflow tools" style={{ width: panel.width }}>
      <div className="tabs" role="tablist" ref={tabsRef}>
        <span
          className={`tabs__bar ${tabSlider.ready ? 'is-ready' : ''}`}
          style={tabSlider.box ? { transform: `translateX(${tabSlider.box.left + 8}px)`, width: tabSlider.box.width - 16, opacity: 1 } : { opacity: 0 }}
          aria-hidden
        />
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {t.count ? <span className={`tabs__count ${errorCount(issues) ? 'is-error' : 'is-warn'}`}>{t.count}</span> : null}
          </button>
        ))}
        <button type="button" className="tabs__close" aria-label="Fold the tools panel away" title="Fold away" onClick={() => setToolsOpen(false)}>
          {shown.tools === 'right' ? <PanelRightClose size={17} aria-hidden /> : <PanelLeftClose size={17} aria-hidden />}
        </button>
      </div>
      <div className="editor__panel">
        {tab === 'add' && <NodeLibrary onAdd={addFromLibrary} />}
        {tab === 'inspect' && (
          <Inspector step={selected} several={selectedIds.length} onPatch={editor.patchStep} onDelete={editor.removeNode} onDeleteSeveral={() => editor.removeNodes(selectedIds)} />
        )}
        {tab === 'ask' && <AskPanel busy={editor.refining} onSubmit={refine} />}
        {tab === 'check' && <CheckPanel editor={editor} onRun={run} onFocusNode={focusNode} notice={notice(true)} />}
      </div>
    </aside>
  );
  const toolsEl = toolsOpen
    ? (shown.tools === 'right' ? <>{resizeEl}{asideEl}</> : <>{asideEl}{resizeEl}</>)
    : (
      <aside className="editor__rail" aria-label="Workflow tools">
        <div role="tablist" aria-orientation="vertical">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={false} aria-label={t.label} title={t.label} onClick={() => openTab(t.id)}>
              {t.icon}
              <small>{t.label}</small>
              {t.count ? <span className={`tabs__count ${errorCount(issues) ? 'is-error' : 'is-warn'}`}>{t.count}</span> : null}
            </button>
          ))}
        </div>
      </aside>
    );

  return (
    <div className="editor">
      <EditorToolbar
        name={editor.name}
        onName={editor.setName}
        updatedAt={flow.updatedAt}
        issues={issues}
        running={editor.running}
        onCheck={() => { setView('steps'); setTab('check'); }}
        onExport={() => exportFlow({ ...flow, name: editor.name, nodes: editor.steps, edges: editor.flowEdges })}
        onRun={run}
        view={view}
        onView={setView}
      />

      {view === 'result' ? (
        <ResultView
          editor={editor}
          request={flow.description}
          onRun={run}
          onShowSteps={() => setView('steps')}
          onFocusNode={focusNode}
          onRefine={editor.refine}
          notice={notice()}
          blocked={!!noAnswer && noAnswer.kind !== 'llm_step'}
        />
      ) : (
        <div className="editor__body" ref={bodyRef} data-tools={shown.tools} data-logs={shown.logs}>
          {shown.tools === 'left' && toolsEl}
          {shown.logs === 'left' && logsEl}
          <div className="editor__main">
            {canvasEl}
            {shown.logs === 'bottom' && logsEl}
          </div>
          {shown.logs === 'right' && logsEl}
          {shown.tools === 'right' && toolsEl}
          {moving && (
            <div className="dockzones" aria-hidden>
              {(['left', 'right', 'bottom'] as LogsDock[]).map(z => (
                <div key={z} className={`dockzones__zone is-${z} ${moving.zone === z ? 'is-hot' : ''}`}><span>{z === 'bottom' ? 'Logs at the bottom' : `Logs on the ${z}`}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
