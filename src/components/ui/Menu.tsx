import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './Button';
import { usePresence } from './usePresence';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const phase = usePresence(open, 140);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <IconButton label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <MoreHorizontal size={18} />
      </IconButton>
      {phase !== 'closed' && (
        <div className={`menu__panel ${phase === 'open' ? 'is-open' : phase === 'exit' ? 'is-closing' : ''}`} role="menu" data-origin="top-right">
          {items.map(item => (
            <div key={item.label}>
              {item.separatorBefore && <div className="menu__sep" />}
              <button
                type="button"
                role="menuitem"
                className={`menu__item ${item.danger ? 'menu__item--danger' : ''}`}
                onClick={() => { setOpen(false); item.onSelect(); }}
              >
                {item.icon}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
