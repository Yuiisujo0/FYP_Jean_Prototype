import { BookOpen, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Settings, Sparkles, Workflow as WorkflowIcon, type LucideIcon } from 'lucide-react';
import { useRef } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { isMac } from '../components/CommandPalette';
import { LogoMark } from '../components/Logo';
import { IconButton } from '../components/ui/Button';
import { useSlider } from '../components/ui/useSlider';
import { Avatar } from '../components/Avatar';
import { useWorkspace } from '../state/WorkspaceContext';
import './Sidebar.css';

interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const WORKSPACE_NAV: NavEntry[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/generate', label: 'Generate', icon: Sparkles },
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon },
  { to: '/knowledge', label: 'Knowledge base', icon: BookOpen },
];

interface SidebarProps {
  open: boolean;
  phone: boolean;
  collapsed: boolean;
  onClose: () => void;
  onToggle: () => void;
}

export function Sidebar({ open, phone, collapsed, onClose, onToggle }: SidebarProps) {
  const { flows, ollama, profile } = useWorkspace();
  const { pathname } = useLocation();

  const navRef = useRef<HTMLElement>(null);
  const slider = useSlider(navRef, '.side-link.is-active', [pathname, collapsed, flows.length]);

  const modelLabel = { online: 'Connected', checking: 'Checking…', offline: 'Not connected', unknown: 'Not checked' }[ollama.status];

  const renderLink = ({ to, label, icon: Icon, end }: NavEntry) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      onClick={onClose}
      title={label}
      className={({ isActive }) => `side-link ${isActive || (to === '/workflows' && pathname.startsWith('/editor')) ? 'is-active' : ''}`}
    >
      <Icon size={18} aria-hidden />
      <span>{label}</span>
      {to === '/workflows' && <span className="side-link__count">{flows.length}</span>}
    </NavLink>
  );

  return (
    <aside className={`sidebar ${open ? 'is-open' : ''} ${collapsed ? 'is-collapsed' : ''}`} aria-label="Main navigation" inert={phone && !open}>
      <div className="sidebar__brand">
        <Link
          to="/"
          state={{ cover: true }}
          className="sidebar__home"
          aria-label="jwork: back to the welcome page"
          title="Back to the welcome page"
          onClick={e => {
            onClose();
            // Already on the Overview with the welcome cover available: scroll up into it (it is the top of the same page).
            if (pathname === '/' && document.documentElement.classList.contains('cover-pad')) {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          }}
        >
          <LogoMark size={30} />
          <span className="sidebar__wordmark">jwork</span>
        </Link>
        <IconButton label={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${isMac ? '⌘' : 'Ctrl'} B)`} className="sidebar__toggle" onClick={onToggle}>
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </IconButton>
      </div>

      <nav className="sidebar__nav" ref={navRef}>
        <div className="sidebar__label">Workspace</div>
        {WORKSPACE_NAV.map(renderLink)}
        <div className="sidebar__label">Preferences</div>
        {renderLink({ to: '/settings', label: 'Settings', icon: Settings })}
        <span className={`side-indicator ${slider.ready ? 'is-ready' : ''}`} style={slider.style} aria-hidden />
      </nav>

      <div className="sidebar__footer">
        <NavLink to="/settings?tab=model" className="model-card" onClick={onClose} title={`Local model: ${ollama.config.model} · ${modelLabel}`}>
          <span className={`model-card__dot is-${ollama.status}`} aria-hidden />
          <span className="model-card__text">
            <b>Local model</b>
            <small>{ollama.config.model} · {modelLabel}</small>
          </span>
        </NavLink>
        <NavLink to="/profile" className={({ isActive }) => `sidebar__user ${isActive ? 'is-active' : ''}`} onClick={onClose} title="Your profile">
          <Avatar name={profile.name} color={profile.color} size={34} />
          <span className="model-card__text">
            <b>{profile.name.trim() || 'Your profile'}</b>
            <small>{profile.role.trim() || 'View profile'}</small>
          </span>
        </NavLink>
      </div>
    </aside>
  );
}
