import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Toast } from '../components/ui/Toast';
import { Landing } from '../features/landing/Landing';
import { KEYS, readString, writeString } from '../lib/storage';
import { DialogsProvider } from '../state/DialogsContext';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import './AppShell.css';

const PHONE = '(max-width: 768px)';
const COMPACT = '(max-width: 1000px)';

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  // A remembered choice wins on wide screens; narrow windows always start (and return to) collapsed.
  const [collapsed, setCollapsed] = useState(() => {
    if (window.matchMedia(COMPACT).matches) return true;
    return readString(KEYS.sidebar, '') === 'collapsed';
  });
  const { pathname } = useLocation();

  useEffect(() => setDrawerOpen(false), [pathname]);

  // Shrinking the window (or rotating a phone) collapses the sidebar by itself; it never stays open over the content.
  useEffect(() => {
    const phoneQuery = window.matchMedia(PHONE);
    const compactQuery = window.matchMedia(COMPACT);
    const onPhone = () => {
      setPhone(phoneQuery.matches);
      if (phoneQuery.matches) setDrawerOpen(false);
    };
    const onCompact = () => {
      if (compactQuery.matches) setCollapsed(true);
    };
    phoneQuery.addEventListener('change', onPhone);
    compactQuery.addEventListener('change', onCompact);
    return () => {
      phoneQuery.removeEventListener('change', onPhone);
      compactQuery.removeEventListener('change', onCompact);
    };
  }, []);

  /** On phones the sidebar is a drawer; everywhere else it collapses to an icon rail. */
  const toggleSidebar = useCallback(() => {
    if (window.matchMedia(PHONE).matches) {
      setDrawerOpen(open => !open);
      return;
    }
    setCollapsed(prev => {
      writeString(KEYS.sidebar, prev ? 'expanded' : 'collapsed');
      return !prev;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  return (
    <DialogsProvider>
      <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
        <Sidebar open={drawerOpen} phone={phone} collapsed={collapsed} onClose={() => setDrawerOpen(false)} onToggle={toggleSidebar} />
        {drawerOpen && <button type="button" className="shell__scrim" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />}
        <div className="shell__main">
          <Topbar onOpenMenu={toggleSidebar} />
          <main className="shell__content" id="main">
            <Outlet />
          </main>
        </div>
        <Toast />
        <Landing />
      </div>
    </DialogsProvider>
  );
}
