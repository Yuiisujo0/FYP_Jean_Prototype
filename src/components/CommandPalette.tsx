import { BookOpen, CornerDownLeft, LayoutDashboard, Moon, Plus, Search, Settings, Sparkles, UserRound, Workflow as WorkflowIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../state/WorkspaceContext';

interface Command {
  id: string;
  group: 'Go to' | 'Actions' | 'Workflows';
  label: string;
  icon: LucideIcon;
  run: () => void;
}

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onCreate: () => void;
}

export const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
export const shortcutLabel = isMac ? '⌘ K' : 'Ctrl K';

export function CommandPalette({ open, onOpen, onClose, onCreate }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open ? onClose() : onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpen, onClose]);

  return open ? <PaletteBody onClose={onClose} onCreate={onCreate} /> : null;
}

function PaletteBody({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const { flows, toggleTheme } = useWorkspace();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => navigate(path);
    return [
      { id: 'overview', group: 'Go to', label: 'Overview', icon: LayoutDashboard, run: go('/') },
      { id: 'generate', group: 'Go to', label: 'Generate a workflow', icon: Sparkles, run: go('/generate') },
      { id: 'workflows', group: 'Go to', label: 'All workflows', icon: WorkflowIcon, run: go('/workflows') },
      { id: 'knowledge', group: 'Go to', label: 'Knowledge base', icon: BookOpen, run: go('/knowledge') },
      { id: 'settings', group: 'Go to', label: 'Settings', icon: Settings, run: go('/settings') },
      { id: 'profile', group: 'Go to', label: 'Profile', icon: UserRound, run: go('/profile') },
      { id: 'theme', group: 'Actions', label: 'Toggle light / dark theme', icon: Moon, run: toggleTheme },
      { id: 'new', group: 'Actions', label: 'New workflow', icon: Plus, run: onCreate },
      ...flows.map<Command>(f => ({ id: f.id, group: 'Workflows', label: f.name, icon: WorkflowIcon, run: go(`/editor/${f.id}`) })),
    ];
  }, [flows, navigate, toggleTheme, onCreate]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (command?: Command) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[index]); }
  };

  let lastGroup = '';
  return (
    <div className="modal-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette__input">
          <Search size={18} aria-hidden />
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search pages, actions and workflows…" aria-label="Search" />
          <kbd>Esc</kbd>
        </div>
        <div className="palette__list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette__empty">Nothing matches “{query}”.</div>}
          {results.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            const Icon = c.icon;
            return (
              <div key={c.id}>
                {showGroup && <div className="palette__group">{c.group}</div>}
                <button type="button" role="option" className="palette__item" aria-selected={i === index} onMouseMove={() => setIndex(i)} onClick={() => choose(c)}>
                  <Icon size={17} aria-hidden />
                  <span>{c.label}</span>
                  {i === index && <CornerDownLeft size={14} aria-hidden />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette__foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span></div>
      </div>
    </div>
  );
}
