import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './Button';

interface ModalProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}

export function Modal({ title, description, icon, onClose, children, actions }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);

  // Closing by Escape, the backdrop or the close button eases out first; a button in `actions` closes at once (its parent decides).
  const requestClose = useCallback(() => {
    if (leaving) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return; }
    setLeaving(true);
    window.setTimeout(onClose, 150);
  }, [leaving, onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('input, textarea, [data-autofocus]')?.focus();
    return () => { previous?.focus?.(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && requestClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  return (
    <div className={`modal-scrim ${leaving ? 'is-leaving' : ''}`} onMouseDown={e => e.target === e.currentTarget && requestClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <IconButton label="Close" className="modal__close" onClick={requestClose}><X size={18} /></IconButton>
        {icon && <div className="modal__icon">{icon}</div>}
        <h2 id={titleId}>{title}</h2>
        {description && <p className="modal__lead">{description}</p>}
        {children}
        {actions && <div className="modal__actions">{actions}</div>}
      </div>
    </div>
  );
}
