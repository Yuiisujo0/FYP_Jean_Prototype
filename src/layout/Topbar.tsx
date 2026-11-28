import { ArrowLeft, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun } from 'lucide-react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import { PROVIDER_SHORT } from '../lib/providerConfig';
import { isMac, shortcutLabel } from '../components/CommandPalette';
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

export function Topbar({ collapsed, onToggleSidebar }: { collapsed: boolean; onToggleSidebar: () => void }) {
  const { ollama, toggleTheme } = useWorkspace();
  const { openPalette } = useDialogs();
  const { pathname } = useLocation();

  // A workflow shows its own name in the bar under this one, so here it only needs the way back.
  const editor = matchPath('/editor/:id', pathname);

  const statusLabel = { online: 'online', checking: 'checking…', offline: 'offline', unknown: 'unknown' }[ollama.status];

  return (
    <header className="topbar">
      <IconButton label="Open navigation" className="topbar__menu" onClick={onToggleSidebar}><Menu size={20} /></IconButton>
      {/* The sidebar's own switch lives here, at the same height whether the sidebar is open or closed. */}
      <IconButton
        label={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${isMac ? '⌘' : 'Ctrl'} B)`}
        className="topbar__toggle"
        aria-expanded={!collapsed}
        onClick={onToggleSidebar}
      >
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </IconButton>

      <nav className="crumbs" aria-label="Breadcrumb">
        {editor ? (
          <Link to="/workflows" className="crumbs__back"><ArrowLeft size={17} aria-hidden /> Workflows</Link>
        ) : (
          <span className="crumbs__item" aria-current="page">{TITLES[pathname] ?? 'Overview'}</span>
        )}
      </nav>

      <div className="topbar__actions">
        <button type="button" className="topbar__search" onClick={openPalette}>
          <Search size={16} aria-hidden />
          <span>Search or jump to…</span>
          <kbd>{shortcutLabel}</kbd>
        </button>
        <Link to="/settings?tab=model" className={`topbar__status is-${ollama.status}`} title="Change the AI model in Settings">
          <i aria-hidden />
          <span>{PROVIDER_SHORT[ollama.provider.kind]} · {statusLabel}</span>
        </Link>
        <IconButton label="Toggle light / dark theme" onClick={toggleTheme}>
          <Sun size={18} className="theme-sun" />
          <Moon size={18} className="theme-moon" />
        </IconButton>
      </div>
    </header>
  );
}
