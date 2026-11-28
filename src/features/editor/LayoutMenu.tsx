import { LayoutDashboard, PanelBottom, PanelLeft, PanelRight, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePresence } from '../../components/ui/usePresence';
import type { EditorLayout, LogsDock, ToolsSide } from './layout';

interface Props {
  layout: EditorLayout;
  /** Side screens stack, so the choice is kept but not shown; the menu says so. */
  narrow: boolean;
  onLogs: (dock: LogsDock) => void;
  onTools: (side: ToolsSide) => void;
  onReset: () => void;
  /** Open the panel upwards (the Logs bar at the bottom of the screen) or downwards. */
  up: boolean;
}

/** "Layout": where the Logs and the tools sit in the "How it was done" view. */
export function LayoutMenu({ layout, narrow, onLogs, onTools, onReset, up }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const phase = usePresence(open, 140);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const choice = <T extends string>(name: string, value: T, options: { value: T; label: string; icon: React.ReactNode }[], pick: (v: T) => void) => (
    <div className="lmenu__row">
      <span className="lmenu__label">{name}</span>
      <div className="lmenu__opts" role="radiogroup" aria-label={name}>
        {options.map(o => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => pick(o.value)}>
            {o.icon}{o.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="lmenu" ref={ref}>
      <button type="button" className="logs__iconbtn" aria-label="Layout" title="Layout: where the logs and tools sit" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <LayoutDashboard size={16} aria-hidden />
      </button>
      {phase !== 'closed' && (
        <div className={`lmenu__panel ${up ? 'is-up' : ''} ${phase === 'open' ? 'is-open' : phase === 'exit' ? 'is-closing' : ''}`} role="dialog" aria-label="Layout">
          <b className="lmenu__title">Layout</b>
          {choice<LogsDock>('Logs', layout.logs, [
            { value: 'left', label: 'Left', icon: <PanelLeft size={15} aria-hidden /> },
            { value: 'bottom', label: 'Bottom', icon: <PanelBottom size={15} aria-hidden /> },
            { value: 'right', label: 'Right', icon: <PanelRight size={15} aria-hidden /> },
          ], onLogs)}
          {choice<ToolsSide>('Tools', layout.tools, [
            { value: 'left', label: 'Left', icon: <PanelLeft size={15} aria-hidden /> },
            { value: 'right', label: 'Right', icon: <PanelRight size={15} aria-hidden /> },
          ], onTools)}
          <p className="lmenu__hint">
            {narrow ? 'On a small screen everything stacks; your choice applies on a wider one.' : 'You can also drag the Logs by their grip to the left, the right or the bottom.'}
          </p>
          <button type="button" className="lmenu__reset" onClick={onReset}><RotateCcw size={14} aria-hidden /> Reset layout</button>
        </div>
      )}
    </div>
  );
}
