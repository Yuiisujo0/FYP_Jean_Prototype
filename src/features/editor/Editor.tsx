import { Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlow, useReactFlow, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Database, Plus } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { useSlider } from '../../components/ui/useSlider';
import { categoryOf } from '../../data/nodeKinds';
import { findDataset } from '../../lib/engine';
import { plural } from '../../lib/format';
import { errorCount } from '../../lib/validate';
import { KEYS, readString, writeString } from '../../lib/storage';
import { useDatasets } from '../../state/useDatasets';
import { useWorkspace } from '../../state/WorkspaceContext';
import type { Flow } from '../../types';
import { AskPanel } from './AskPanel';
import { CheckPanel } from './CheckPanel';
import { EditorToolbar } from './EditorToolbar';
import { FlowNode } from './FlowNode';
import { Inspector } from './Inspector';
import { DRAG_TYPE, NodeLibrary } from './NodeLibrary';
import { useFlowEditor, type StepNode } from './useFlowEditor';
import './Editor.css';

const NODE_TYPES = { step: FlowNode };
type Tab = 'add' | 'inspect' | 'ask' | 'check';

const PANEL_MIN = 280;
const PANEL_DEFAULT = 316;
const clampPanel = (w: number) => Math.round(Math.min(Math.max(w, PANEL_MIN), Math.min(760, window.innerWidth * 0.65)));

/** The width of the right-hand tools panel. The user drags the bar on its left edge (or uses the arrow keys); it is remembered. */
function useSidePanelWidth() {
  const [width, setWidth] = useState(() => clampPanel(Number(readString(KEYS.sidePanel, '')) || PANEL_DEFAULT));
  const [dragging, setDragging] = useState(false);
  const commit = useCallback((w: number) => { setWidth(w); writeString(KEYS.sidePanel, String(w)); }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = width;
    setDragging(true);
    const move = (ev: PointerEvent) => { latest = clampPanel(startW + (startX - ev.clientX)); setWidth(latest); };
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
    if (e.key === 'ArrowLeft') { e.preventDefault(); commit(clampPanel(width + step)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); commit(clampPanel(width - step)); }
    else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); commit(PANEL_DEFAULT); }
  };
  return { width, dragging, onPointerDown, onKeyDown, reset: () => commit(PANEL_DEFAULT) };
}

export function Editor({ flow }: { flow: Flow }) {
  const { updateFlow, exportFlow } = useWorkspace();
  const save = useCallback((patch: Partial<Flow>) => updateFlow(flow.id, patch), [updateFlow, flow.id]);
  const editor = useFlowEditor(flow, save);
  const panel = useSidePanelWidth();
  const { nodes, edges, runs, issues, selected } = editor;
  const { screenToFlowPosition, fitView } = useReactFlow();
  // A freshly generated workflow opens on Check, where the plain-English summary and the preview are.
  const location = useLocation();
  const [tab, setTab] = useState<Tab>(() => ((location.state as { fresh?: boolean } | null)?.fresh ? 'check' : 'add'));
  const { items: datasets } = useDatasets();
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabSlider = useSlider(tabsRef, '[role="tab"][aria-selected="true"]', [tab]);

  // Leave the Inspect tab when the selection goes away (pane click, Delete key).
  useEffect(() => {
    if (!selected && tab === 'inspect') setTab('add');
  }, [selected, tab]);

  // Read CSV steps whose dataset is not in the Data library. Only judged once the library has loaded.
  const needsData = useMemo(
    () => (datasets ? editor.steps.filter(st => st.type === 'READ_CSV' && !findDataset(datasets, st.config.file ?? '')) : []),
    [datasets, editor.steps],
  );

  const displayNodes = useMemo<StepNode[]>(
    () => nodes.map(n => (runs[n.id] ? { ...n, data: { ...n.data, run: runs[n.id] } } : n)),
    [nodes, runs],
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
    setTab('check');
    await editor.run();
  };

  const focusNode = (id: string) => {
    editor.selectNode(id);
    setTab('inspect');
    void fitView({ nodes: [{ id }], duration: 350, maxZoom: 1, padding: 0.6 });
  };

  const refine = async (text: string) => {
    const result = await editor.refine(text);
    // Give React a frame to mount any new nodes before framing the whole flow again.
    if (result.ok) setTimeout(() => void fitView({ padding: 0.12, maxZoom: 1, duration: 350 }), 60);
    return result;
  };

  const addFromLibrary = (type: string) => {
    editor.addNode(type, { append: true });
    setTab('inspect');
  };

  const onDrop = (e: DragEvent) => {
    const type = e.dataTransfer.getData(DRAG_TYPE);
    if (!type) return;
    e.preventDefault();
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    editor.addNode(type, { at: { x: p.x - 118, y: p.y - 55 } });
    setTab('inspect');
  };

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'add', label: 'Add' },
    { id: 'inspect', label: 'Inspect' },
    { id: 'ask', label: 'Ask' },
    { id: 'check', label: 'Check', count: issues.length },
  ];

  return (
    <div className="editor">
      <EditorToolbar
        name={editor.name}
        onName={editor.setName}
        updatedAt={flow.updatedAt}
        issues={issues}
        running={editor.running}
        onCheck={() => setTab('check')}
        onExport={() => exportFlow({ ...flow, name: editor.name, nodes: editor.steps, edges: editor.flowEdges })}
        onRun={run}
      />

      <div className="editor__body">
        <div className="editor__canvas" onDragOver={e => e.dataTransfer.types.includes(DRAG_TYPE) && e.preventDefault()} onDrop={onDrop}>
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={editor.onNodesChange}
            onEdgesChange={editor.onEdgesChange}
            onConnect={editor.onConnect}
            isValidConnection={editor.isValidConnection}
            onNodeClick={() => setTab('inspect')}
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
            minZoom={0.3}
            snapToGrid
            snapGrid={[10, 10]}
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="var(--grid-dot)" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" style={{ width: 150, height: 96 }} nodeColor={n => `var(--c-${categoryOf((n as StepNode).data.step.type)})`} nodeStrokeWidth={0} />
            <Panel position="top-left">
              <div className="editor__top">
                <div className="editor__chips">
                  <span>{plural(nodes.length, 'step')}</span>
                  <span>Linear flow</span>
                  {errorCount(issues) === 0 && nodes.length > 0 && <span className="is-ok">Valid</span>}
                </div>
                {needsData.length > 0 && (
                  <div className="editor__needs" role="status">
                    <Database size={18} aria-hidden />
                    <span>
                      <b>This workflow needs data</b>
                      {needsData.length === 1
                        ? <>“{needsData[0].config.file || 'a dataset'}” is not in your Data library.</>
                        : <>{needsData.length} Read CSV steps have no matching dataset.</>}
                    </span>
                    <div className="editor__needs-actions">
                      <Button size="sm" onClick={() => focusNode(needsData[0].id)}>Choose dataset</Button>
                      <Link className="btn btn--primary btn--sm" to="/knowledge?tab=data">Upload data</Link>
                    </div>
                  </div>
                )}
              </div>
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
          </div>
          <div className="editor__panel">
            {tab === 'add' && <NodeLibrary onAdd={addFromLibrary} />}
            {tab === 'inspect' && <Inspector step={selected} onPatch={editor.patchStep} onDelete={editor.removeNode} />}
            {tab === 'ask' && <AskPanel busy={editor.refining} onSubmit={refine} />}
            {tab === 'check' && <CheckPanel editor={editor} onRun={run} onFocusNode={focusNode} />}
          </div>
        </aside>
      </div>
    </div>
  );
}
