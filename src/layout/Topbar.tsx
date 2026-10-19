import { ChevronRight, Menu, Moon, Search, Sun } from 'lucide-react';
import { matchPath, useLocation } from 'react-router-dom';
import { shortcutLabel } from '../components/CommandPalette';
import { IconButton } from '../components/ui/Button';
import { useDialogs } from '../state/DialogsContext';
import { useWorkspace } from '../state/WorkspaceContext';
import './Topbar.css';

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/generate': 'Generate',
  '/workflows': 'Workflows',
  '/knowledge': 'Knowledge base',
  '/settings': 'Settings',
  '/profile': 'Profile',
};

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { flows, ollama, toggleTheme } = useWorkspace();
  const { openPalette } = useDialogs();
  const { pathname } = useLocation();

  const editor = matchPath('/editor/:id', pathname);
  const crumbs = editor
    ? ['Workflows', flows.find(f => f.id === editor.params.id)?.name ?? 'Editor']
    : [TITLES[pathname] ?? 'Overview'];

  const statusLabel = { online: 'Model online', checking: 'Checking model…', offline: 'Model offline', unknown: 'Model unknown' }[ollama.status];

  return (
    <header className="topbar">
      <IconButton label="Open navigation" className="topbar__menu" onClick={onOpenMenu}><Menu size={20} /></IconButton>

      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span className="crumbs__item" key={c + i} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
            {i > 0 && <ChevronRight size={14} aria-hidden />}
            {c}
          </span>
        ))}
      </nav>

      <div className="topbar__actions">
        <button type="button" className="topbar__search" onClick={openPalette}>
          <Search size={16} aria-hidden />
          <span>Search or jump to…</span>
          <kbd>{shortcutLabel}</kbd>
        </button>
        <span className={`topbar__status is-${ollama.status}`} title="Local model connection">
          <i aria-hidden />
          <span>{statusLabel}</span>
        </span>
        <IconButton label="Toggle light / dark theme" onClick={toggleTheme}>
          <Sun size={18} className="theme-sun" />
          <Moon size={18} className="theme-moon" />
        </IconButton>
      </div>
    </header>
  );
}
