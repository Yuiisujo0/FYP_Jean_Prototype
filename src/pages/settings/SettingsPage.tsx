import { HardDrive, Monitor, Moon, Palette, RotateCcw, Sparkles, Sun } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { PageHeader } from '../../components/ui/PageHeader';
import { Segmented } from '../../components/ui/Segmented';
import { useWorkspace } from '../../state/WorkspaceContext';
import type { Density, ThemePreference } from '../../types';
import './SettingsPage.css';

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'model', label: 'Local model', icon: Sparkles },
  { id: 'data', label: 'Data', icon: HardDrive },
] as const;
type TabId = (typeof TABS)[number]['id'];

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div>
        <b>{title}</b>
        {hint && <p>{hint}</p>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabId = TABS.some(t => t.id === requested) ? (requested as TabId) : 'appearance';

  return (
    <div className="page">
      <PageHeader title="Settings" description="Appearance, the local model connection, and the data stored in this browser." />
      <div className="settings">
        <nav className="settings__nav" aria-label="Settings sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} aria-current={tab === id} onClick={() => setParams(id === 'appearance' ? {} : { tab: id })}>
              <Icon size={17} aria-hidden /> {label}
            </button>
          ))}
        </nav>
        <div className="settings__panel card">
          {tab === 'appearance' && <AppearanceSection />}
          {tab === 'model' && <ModelSection />}
          {tab === 'data' && <DataSection />}
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { theme, setTheme, density, setDensity } = useWorkspace();
  return (
    <>
      <Row title="Theme" hint="System follows your operating system setting.">
        <Segmented<ThemePreference>
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'light', label: 'Light', icon: <Sun size={15} /> },
            { value: 'dark', label: 'Dark', icon: <Moon size={15} /> },
            { value: 'system', label: 'System', icon: <Monitor size={15} /> },
          ]}
        />
      </Row>
      <Row title="Density" hint="Compact tightens the page margins to fit more on screen.">
        <Segmented<Density>
          label="Density"
          value={density}
          onChange={setDensity}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </Row>
    </>
  );
}

function ModelSection() {
  const { ollama } = useWorkspace();
  const { config, setConfig, status, models, error, check } = ollama;
  const badge = {
    online: <Badge tone="ok" dot>Connected</Badge>,
    checking: <Badge dot>Checking…</Badge>,
    offline: <Badge tone="warn" dot>Not connected</Badge>,
    unknown: <Badge dot>Not checked</Badge>,
  }[status];

  return (
    <>
      <Row title="Connection" hint="jwork talks to a local Ollama server. Nothing is sent to a cloud service.">
        {badge}
      </Row>
      <Row title="Server address" hint="The default Ollama address is http://localhost:11434.">
        <div className="inline-field">
          <input className="input" value={config.url} onChange={e => setConfig({ url: e.target.value })} aria-label="Ollama server address" spellCheck={false} />
          <Button loading={status === 'checking'} onClick={check}>Test</Button>
        </div>
      </Row>
      <Row title="Model" hint={models.length ? 'Models found on your server.' : 'Connect to list the models installed locally.'}>
        {models.length ? (
          <select className="select" value={config.model} onChange={e => setConfig({ model: e.target.value })} aria-label="Model">
            {!models.includes(config.model) && <option value={config.model}>{config.model}</option>}
            {models.map(m => <option key={m}>{m}</option>)}
          </select>
        ) : (
          <input className="input" value={config.model} onChange={e => setConfig({ model: e.target.value })} aria-label="Model name" spellCheck={false} />
        )}
      </Row>
      {status === 'offline' && error && <p className="settings__note settings__note--warn">{error}</p>}
      <p className="settings__note">
        This only checks that the browser can reach Ollama. Workflow generation goes through the jwork backend, which talks to Ollama itself, using the model set in the backend's configuration.
      </p>
    </>
  );
}

function DataSection() {
  const { flows, knowledge, resetDemoData } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Row title="Stored in this browser" hint="Workflows and imported knowledge live in local storage. Clearing site data removes them.">
        <span className="settings__stat">{flows.length} workflows · {knowledge.length} entries</span>
      </Row>
      <Row title="Reset demo data" hint="Replace everything with the sample workflows. This cannot be undone.">
        <Button variant="danger" icon={<RotateCcw size={16} />} onClick={() => setConfirming(true)}>Reset…</Button>
      </Row>
      {confirming && (
        <Modal
          title="Reset demo data?"
          description="Your workflows and imported knowledge entries will be replaced by the sample set."
          icon={<RotateCcw size={20} />}
          onClose={() => setConfirming(false)}
          actions={<>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { resetDemoData(); setConfirming(false); }}>Reset everything</Button>
          </>}
        />
      )}
    </>
  );
}
