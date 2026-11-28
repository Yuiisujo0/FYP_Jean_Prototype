import { AlertCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleSlash, GripVertical, LoaderCircle, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Segmented } from '../../components/ui/Segmented';
import { NodeIcon } from '../../components/NodeIcon';
import { categoryOf } from '../../data/nodeKinds';
import { plural } from '../../lib/format';
import { KEYS, readString, writeString } from '../../lib/storage';
import type { NodeRun, RunResult, Step, StepTrace } from '../../types';
import type { LogsDock } from './layout';

/**
 * Under the canvas: what each step did on the data. The steps are listed on the left in run order; the one picked (here or on
 * the canvas) shows its output, its input and the rows it left out, on the right. It reads the run on screen or, before any
 * run, the live preview (a dry run in the browser), so it has something to show from the start.
 */

type Pane = 'output' | 'input' | 'left';
const HEAD = 44;
const MIN_H = 180, DEFAULT_H = 300;
const MIN_W = 300, DEFAULT_W = 420;
const clampHeight = (h: number) => Math.round(Math.min(Math.max(h, MIN_H), window.innerHeight * 0.7));
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, MIN_W), window.innerWidth * 0.5));

/**
 * The panel's size: a height under the canvas, a width as a side column; each is remembered, and so is whether it is folded.
 * The edge to drag is the one facing the canvas.
 */
function useLogsSize(dock: LogsDock) {
  const saved = readString(KEYS.logsPanel, '');
  const [open, setOpenState] = useState(saved !== 'closed');
  const [height, setHeight] = useState(() => clampHeight(Number(saved) || DEFAULT_H));
  const [width, setWidth] = useState(() => clampWidth(Number(readString(KEYS.logsWidth, '')) || DEFAULT_W));
  const [dragging, setDragging] = useState(false);
  const side = dock !== 'bottom';
  const remember = useCallback((isOpen: boolean, h: number, w: number) => {
    writeString(KEYS.logsPanel, isOpen ? String(h) : 'closed');
    writeString(KEYS.logsWidth, String(w));
  }, []);
  const setOpen = (isOpen: boolean) => { setOpenState(isOpen); remember(isOpen, height, width); };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = side ? e.clientX : e.clientY;
    const startSize = open ? (side ? width : height) : HEAD;
    let latest = startSize;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      if (side) {
        latest = clampWidth(startSize + (dock === 'left' ? ev.clientX - start : start - ev.clientX));
        setWidth(latest);
      } else {
        latest = clampHeight(startSize + (start - ev.clientY));
        setHeight(latest);
      }
      setOpenState(true);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      remember(true, side ? height : latest, side ? latest : width);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 80 : 24;
    const grow = side ? (dock === 'left' ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp';
    const shrink = side ? (dock === 'left' ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown';
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    const d = e.key === grow ? step : -step;
    if (side) { const w = clampWidth(width + d); setWidth(w); remember(true, height, w); }
    else { const h = clampHeight(height + d); setHeight(h); remember(true, h, width); }
    setOpenState(true);
  };
  return { open, setOpen, height, width, dragging, onPointerDown, onKeyDown };
}

/** The engine's reason as a short sentence: "does not match …" becomes "Does not match …". */
const sentence = (text = '') => text.charAt(0).toUpperCase() + text.slice(1);

/** "14:02:31" */
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

interface Props {
  /** The steps in run order. */
  steps: Step[];
  runs: Record<string, NodeRun>;
  /** The run on screen, or else the preview's result; null when neither has finished. */
  result: RunResult | null;
  /** True when `result` is the preview (a dry run), not a run. */
  isPreview: boolean;
  running: boolean;
  runError: string;
  /** Why there is no preview to show, when the dry run could not run (for example a missing table) or reaches outside the app. */
  previewNote?: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Where the panel sits: under the canvas or as a column on one side. */
  dock: LogsDock;
  /** Starts dragging the panel to another place (pressed on its grip); left out on screens that always stack. */
  onMoveStart?: (e: React.PointerEvent) => void;
  /** The Layout menu, shown in the panel's bar. */
  layoutMenu?: React.ReactNode;
  /** Called after the panel is folded or opened, so the canvas can frame its steps again. */
  onFold?: () => void;
}

function RowsTable({ columns, rows, source, total, empty, why }: {
  columns: string[]; rows: Record<string, string>[]; source?: number[][]; total: number; empty: string;
  /** For left-out rows: why each one is not in the result, and whether it waits for a decision. */
  why?: { text: string; flagged: boolean }[];
}) {
  if (!rows.length) return <p className="logs__empty">{empty}</p>;
  return (
    <>
      <div className="logs__scroll">
        <table className="logs__table">
          <thead><tr><th title="Row number in the source data">Row</th>{why && <th>Why</th>}{columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={why?.[i]?.flagged ? 'is-flagged' : undefined}>
                <td className="logs__rowno">{source?.[i]?.join(', ') ?? i + 1}</td>
                {why && <td className="logs__why">{why[i]?.text}</td>}
                {columns.map(c => <td key={c} className={(r[c] ?? '').trim() === '' ? 'is-blank' : undefined}>{(r[c] ?? '').trim() === '' ? 'blank' : r[c]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length && <p className="logs__more">Showing the first {rows.length} of {plural(total, 'row')}.</p>}
    </>
  );
}

export function LogsPanel({ steps, runs, result, isPreview, running, runError, previewNote, selectedId, onSelect, dock, onMoveStart, layoutMenu, onFold }: Props) {
  const size = useLogsSize(dock);
  const side = dock !== 'bottom';
  const [pane, setPane] = useState<Pane>('output');
  const traced = useMemo(() => new Map((result?.trace ?? []).map((t, i) => [t.stepId, { t, i }])), [result]);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  useEffect(() => { if (result && !isPreview) setFinishedAt(Date.now()); }, [result, isPreview]);

  // The step to show: the one picked on the canvas or here, else the first that went wrong, else the last that ran.
  const errored = steps.find(s => runs[s.id]?.state === 'error');
  const lastTraced = [...steps].reverse().find(s => traced.has(s.id));
  const shown = steps.find(s => s.id === selectedId) ?? errored ?? lastTraced ?? steps[0];
  const entry = shown ? traced.get(shown.id) : undefined;
  const trace: StepTrace | undefined = entry?.t;
  const before: StepTrace | undefined = entry && entry.i > 0 ? result?.trace[entry.i - 1] : undefined;

  // Rows this step took out of the result: excluded by it, or flagged because it could not decide on them.
  const leftOut = useMemo(() => {
    if (!result?.register || !shown) return [];
    // Rows waiting for a decision first, then the rest in source order.
    return result.register.rows.filter(r => r.stepId === shown.id && r.status !== 'kept')
      .sort((a, b) => Number(b.status === 'flagged') - Number(a.status === 'flagged') || a.row - b.row);
  }, [result, shown]);
  const leftRows = leftOut.slice(0, 50).map(r => result?.input?.rows[r.row - 1] ?? {});
  const leftCols = result?.input?.columns ?? [];
  const flaggedHere = leftOut.filter(r => r.status === 'flagged').length;

  useEffect(() => { if (pane === 'left' && !leftOut.length) setPane('output'); }, [leftOut.length, pane]);

  const status = running ? 'Running…'
    : runError ? 'Run failed'
    : result && !isPreview ? `Run complete${finishedAt ? ` · ${clock(finishedAt)}` : ''}`
    : result ? 'Preview · a dry run in your browser, nothing is saved or sent'
    : previewNote ? `No preview: ${previewNote}`
    : 'Not run yet';

  const stepState = (s: Step): 'running' | 'error' | 'done' | 'skipped' | 'waiting' => {
    const r = runs[s.id]?.state;
    if (r === 'running') return 'running';
    if (r === 'error') return 'error';
    const t = traced.get(s.id)?.t;
    if (t?.skipped) return 'skipped';
    return t ? 'done' : 'waiting';
  };

  return (
    <section
      className={`logs is-${dock} ${side ? 'is-side' : ''} ${size.open ? 'is-open' : ''} ${size.dragging ? 'is-dragging' : ''}`}
      style={side ? { width: size.open ? size.width : HEAD } : { height: size.open ? size.height : HEAD }}
      aria-label="Logs"
    >
      <div
        className="logs__resize"
        role="separator"
        aria-orientation={side ? 'vertical' : 'horizontal'}
        aria-label="Resize the logs"
        aria-valuenow={side ? size.width : size.height}
        tabIndex={0}
        title="Drag to resize"
        onPointerDown={size.onPointerDown}
        onKeyDown={size.onKeyDown}
      />
      <header className="logs__head">
        {onMoveStart && size.open && (
          <button type="button" className="logs__grip" aria-label="Move the logs: drag to the left, the right or the bottom" title="Drag to move the logs" onPointerDown={onMoveStart}>
            <GripVertical size={16} aria-hidden />
          </button>
        )}
        <button type="button" className="logs__toggle" aria-expanded={size.open} aria-label={size.open ? 'Fold the logs away' : 'Open the logs'} onClick={() => { size.setOpen(!size.open); onFold?.(); }}>
          <ScrollText size={16} aria-hidden />
          <b>Logs</b>
          {dock === 'bottom' ? (size.open ? <ChevronDown size={16} aria-hidden /> : <ChevronUp size={16} aria-hidden />)
            : (size.open === (dock === 'left') ? <ChevronLeft size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />)}
        </button>
        {(size.open || !side) && (
          <>
            <span className={`logs__status ${runError || (!result && previewNote) ? 'is-error' : result && !isPreview ? 'is-ok' : ''}`} title={runError || previewNote || status}>
              {running && <LoaderCircle size={13} className="spin" aria-hidden />}{status}
            </span>
            {layoutMenu}
          </>
        )}
      </header>

      {size.open && (
        <div className="logs__body">
          <ol className="logs__steps" aria-label="Steps">
            {steps.map((s, i) => {
              const t = traced.get(s.id)?.t;
              const state = stepState(s);
              return (
                <li key={s.id}>
                  <button type="button" className="logs__step" aria-current={shown?.id === s.id} data-cat={categoryOf(s.type)} data-state={state} onClick={() => onSelect(s.id)}>
                    <span className="logs__no">{i + 1}</span>
                    <span className="logs__icon"><NodeIcon type={s.type} size={14} /></span>
                    <span className="logs__name">{s.name}</span>
                    <span className="logs__count">
                      {state === 'running' ? <LoaderCircle size={13} className="spin" aria-label="running" />
                        : state === 'error' ? <AlertCircle size={14} aria-label="stopped here" />
                        : state === 'skipped' ? <CircleSlash size={13} aria-label="did not run" />
                        : t ? (t.rowsIn === t.rowsOut || i === 0 ? t.rowsOut : `${t.rowsIn} → ${t.rowsOut}`) : '–'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="logs__detail">
            {!shown ? (
              <p className="logs__empty">Add a step to see what it does to your data.</p>
            ) : (
              <>
                <div className="logs__title">
                  <b>{shown.name}</b>
                  {runs[shown.id]?.state === 'error'
                    ? <span className="logs__msg is-error">{runs[shown.id].message}</span>
                    : trace ? <span className="logs__msg">{trace.message || `${plural(trace.rowsOut, 'row')} passed on`}</span>
                    : <span className="logs__msg">{running ? 'Waiting for the steps before it.' : 'Not reached yet. Press Run (top right) to see what this step does.'}</span>}
                </div>
                {trace && (
                  <>
                    <Segmented<Pane>
                      label="What to show for this step"
                      value={pane}
                      onChange={setPane}
                      options={[
                        { value: 'output', label: `Output · ${trace.rowsOut}` },
                        { value: 'input', label: `Input · ${trace.rowsIn}` },
                        ...(leftOut.length ? [{ value: 'left' as Pane, label: `Left out here · ${leftOut.length}` }] : []),
                      ]}
                    />
                    {pane === 'output' && (
                      <RowsTable columns={trace.columnsOut} rows={trace.sample?.rows ?? []} source={trace.sample?.source} total={trace.rowsOut} empty="No rows came out of this step." />
                    )}
                    {pane === 'input' && (
                      before
                        ? <RowsTable columns={trace.columnsIn} rows={before.sample?.rows ?? []} source={before.sample?.source} total={trace.rowsIn} empty="No rows went into this step." />
                        : <p className="logs__empty">This is the first step: it reads {result?.register?.source ? `“${result.register.source}”` : 'its data'} rather than taking rows from a step before it.</p>
                    )}
                    {pane === 'left' && (
                      <>
                        {flaggedHere > 0 && (
                          <p className="logs__flag"><AlertCircle size={14} aria-hidden /> {plural(flaggedHere, 'row')} could not be checked here (for example a blank value). You decide about {flaggedHere === 1 ? 'it' : 'them'} on the Result screen.</p>
                        )}
                        <RowsTable
                          columns={leftCols}
                          rows={leftRows}
                          source={leftOut.slice(0, 50).map(r => [r.row])}
                          why={leftOut.slice(0, 50).map(r => ({ text: sentence(r.reason) || (r.status === 'flagged' ? 'Could not be checked' : 'Left out'), flagged: r.status === 'flagged' }))}
                          total={leftOut.length}
                          empty="No rows were left out here."
                        />
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
