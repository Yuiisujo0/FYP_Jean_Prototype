import { useReactFlow } from '@xyflow/react';
import { CircleHelp, Hand, Minus, Plus, Scan, SquareDashedMousePointer, Trash2, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { usePresence } from '../../components/ui/usePresence';
import { plural } from '../../lib/format';
import { reducedMotion } from '../../lib/motion';
import { CanvasHelp } from './CanvasHelp';

/** What dragging on the empty canvas does: slide the view, or draw a box round steps to select them. */
export type CanvasTool = 'move' | 'select';

const FIT = { padding: 0.12, maxZoom: 1 };
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

function DockButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="dock__btn" aria-label={label} title={label} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

interface DockProps {
  tool: CanvasTool;
  onTool: (tool: CanvasTool) => void;
  help: boolean;
  onHelp: (open: boolean) => void;
}

/** Every canvas control in one place: how dragging behaves, the zoom, and the help. */
export function CanvasDock({ tool, onTool, help, onHelp }: DockProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const duration = reducedMotion() ? 0 : 220;
  const ref = useRef<HTMLDivElement>(null);
  const phase = usePresence(help, 140);

  // V and H switch the tool and ? opens the help, as long as the person is not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onHelp(false); return; }
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'v') onTool('select');
      else if (key === 'h') onTool('move');
      else if (e.key === '?') onHelp(!help);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, onHelp, onTool]);

  useEffect(() => {
    if (!help) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onHelp(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [help, onHelp]);

  return (
    <div className="dock" ref={ref}>
      {phase !== 'closed' && (
        <section className={`dock__help ${phase === 'open' ? 'is-open' : ''}`} aria-label="How to use the canvas">
          <CanvasHelp onClose={() => onHelp(false)} />
        </section>
      )}

      <div className="dock__bar" role="toolbar" aria-label="Canvas controls">
        <DockButton label="Move the view by dragging (H)" active={tool === 'move'} onClick={() => onTool('move')}><Hand size={17} /></DockButton>
        <DockButton label="Select steps by dragging a box (V)" active={tool === 'select'} onClick={() => onTool('select')}><SquareDashedMousePointer size={17} /></DockButton>
        <span className="dock__sep" aria-hidden />
        <DockButton label="Zoom out" onClick={() => void zoomOut({ duration })}><Minus size={17} /></DockButton>
        <DockButton label="Zoom in" onClick={() => void zoomIn({ duration })}><Plus size={17} /></DockButton>
        <DockButton label="Show every step" onClick={() => void fitView({ ...FIT, duration: duration && 350 })}><Scan size={17} /></DockButton>
        <span className="dock__sep" aria-hidden />
        <button type="button" className="dock__btn dock__btn--text" aria-expanded={help} onClick={() => onHelp(!help)}>
          <CircleHelp size={17} aria-hidden /> Help
        </button>
      </div>
    </div>
  );
}

/** Shown while more than one step is selected: what is selected, and the one thing a group is for. */
export function SelectionBar({ count, onDelete, onClear }: { count: number; onDelete: () => void; onClear: () => void }) {
  return (
    <div className="selbar" role="status">
      <span>{plural(count, 'step')} selected</span>
      <button type="button" className="selbar__delete" onClick={onDelete}><Trash2 size={15} aria-hidden /> Delete</button>
      <button type="button" className="selbar__clear" aria-label="Clear the selection" title="Clear the selection" onClick={onClear}><X size={15} /></button>
    </div>
  );
}
