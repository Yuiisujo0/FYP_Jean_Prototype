import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWorkspace } from '../../state/WorkspaceContext';

export function Toast() {
  const { toast, dismissToast } = useWorkspace();
  // The last toast stays on screen for a moment after it is dismissed, so it can ease out.
  const [shown, setShown] = useState(toast);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (toast) { setShown(toast); setLeaving(false); return; }
    if (!shown) return;
    setLeaving(true);
    const timer = window.setTimeout(() => { setShown(null); setLeaving(false); }, 200);
    return () => window.clearTimeout(timer);
  }, [toast]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown) return null;
  const Icon = shown.tone === 'error' ? AlertCircle : CheckCircle2;
  return (
    <div className={`toast ${shown.tone === 'error' ? 'toast--error' : ''} ${leaving ? 'is-leaving' : ''}`} role="status" key={shown.id}>
      <Icon size={17} aria-hidden />
      <span>{shown.message}</span>
      {shown.action && (
        <button type="button" className="toast__action" onClick={() => { shown.action!.run(); dismissToast(); }}>
          {shown.action.label}
        </button>
      )}
    </div>
  );
}
