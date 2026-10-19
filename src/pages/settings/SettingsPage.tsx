import { HardDrive, Monitor, Moon, Palette, RotateCcw, Sparkles, Sun } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { API_URL } from '../../lib/api';
import { API_PRESETS, type ProviderKind } from '../../lib/providerConfig';
import { PageHeader } from '../../components/ui/PageHeader';
import { Segmented } from '../../components/ui/Segmented';
import { useWorkspace } from '../../state/WorkspaceContext';
import type { Density, ThemePreference } from '../../types';
import './SettingsPage.css';

const TABS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'model', label: 'AI model', icon: Sparkles },
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
      <PageHeader title="Settings" description="Appearance, which AI model to use, and the data stored in this browser." />
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

const PROVIDER_NOTE: Record<ProviderKind, string> = {
  service: 'Your data files and rows stay in this browser. To draft and revise a workflow, the free hosted model (Cloudflare Workers AI) receives your request text, your file and column names, and short run summaries such as row counts. It never receives row values. The free allowance is shared and limited each day.',
  ollama: 'Everything stays on your computer. The page talks to Ollama directly, so your request, file and column names, and run summaries never reach any server of ours or of a cloud provider. Row values are never sent anywhere in any mode.',
  custom: 'Your API key is stored only in this browser and sent only to the address below. Your request text, file and column names, and short run summaries go to that provider, under their terms. Row values are never sent. Anyone who can use this browser profile can read the key, so use a key with a spending limit.',
};

function ModelSection() {
  const { ollama } = useWorkspace();
  const { provider, setProvider, status, models, modelName, error, check } = ollama;
  const preset = API_PRESETS.find(x => x.url === provider.customUrl.trim().replace(/\/+$/, ''));
  const [showKey, setShowKey] = useState(false);
  const badge = {
    online: <Badge tone="ok" dot>Connected</Badge>,
    checking: <Badge dot>Checking…</Badge>,
    offline: <Badge tone="warn" dot>Not connected</Badge>,
    unknown: <Badge dot>Not checked</Badge>,
  }[status];

  // Choosing a provider connects to it straight away; typing in a field waits for the Test button.
  const choose = (kind: ProviderKind) => {
    setProvider({ kind });
    setTimeout(check, 0);
  };

  return (
    <>
      <Row title="Where the AI runs" hint="Pick the free hosted model, a model on your own computer, or your own API key.">
        <Segmented<ProviderKind>
          label="AI provider"
          value={provider.kind}
          onChange={choose}
          options={[
            { value: 'service', label: 'Free hosted' },
            { value: 'ollama', label: 'Ollama' },
            { value: 'custom', label: 'API key' },
          ]}
        />
      </Row>

      {provider.kind === 'service' && (
        <Row title="Service address" hint="Set when the site is built (VITE_API_URL). Locally it is the jwork backend.">
          <code>{API_URL}</code>
        </Row>
      )}

      {provider.kind === 'ollama' && (
        <>
          <Row title="Ollama address" hint="Where Ollama is listening. The default is right for most installs.">
            <input className="input" aria-label="Ollama address" value={provider.ollamaUrl} onChange={e => setProvider({ ollamaUrl: e.target.value })} spellCheck={false} />
          </Row>
          <Row title="Model" hint="A model you have pulled, for example qwen2.5:7b or gpt-oss:20b.">
            <input className="input" aria-label="Ollama model" list="ollama-installed" value={provider.ollamaModel} onChange={e => setProvider({ ollamaModel: e.target.value })} spellCheck={false} />
            <datalist id="ollama-installed">{models.map(m => <option key={m} value={m} />)}</datalist>
          </Row>
          <p className="settings__note">
            One-time setup: install Ollama, run <code>ollama pull {provider.ollamaModel || 'qwen2.5:7b'}</code>, and allow this site to call it by setting <code>OLLAMA_ORIGINS</code> to <code>{window.location.origin}</code> before starting Ollama. Use Chrome or Edge.
          </p>
        </>
      )}

      {provider.kind === 'custom' && (
        <>
          <Row title="Provider" hint="Pick one to fill in the address and a suggested model, or choose Other to type your own.">
            <select className="select" aria-label="Provider" value={preset?.id ?? 'other'} onChange={e => {
              const chosen = API_PRESETS.find(x => x.id === e.target.value);
              if (chosen) setProvider({ customUrl: chosen.url, customModel: chosen.model });
            }}>
              {API_PRESETS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
              <option value="other">Other (OpenAI-compatible)</option>
            </select>
          </Row>
          <Row title="API address" hint="Any OpenAI-compatible address, such as https://openrouter.ai/api/v1 or https://api.openai.com/v1.">
            <input className="input" aria-label="API address" value={provider.customUrl} onChange={e => setProvider({ customUrl: e.target.value })} spellCheck={false} />
          </Row>
          <Row title="Model" hint="The model name the provider uses, for example openai/gpt-oss-20b.">
            <input className="input" aria-label="Model name" value={provider.customModel} onChange={e => setProvider({ customModel: e.target.value })} spellCheck={false} />
          </Row>
          <Row title="API key" hint={preset ? `Create one at ${preset.keyUrl.replace('https://', '')}. It stays in this browser and is never sent to the jwork service.` : 'Stays in this browser. It is never sent to the jwork service.'}>
            <div className="inline-field">
              <input className="input" aria-label="API key" type={showKey ? 'text' : 'password'} value={provider.customKey} autoComplete="off" onChange={e => setProvider({ customKey: e.target.value })} spellCheck={false} />
              <Button variant="ghost" onClick={() => setShowKey(v => !v)}>{showKey ? 'Hide' : 'Show'}</Button>
            </div>
          </Row>
        </>
      )}

      <Row title="Connection" hint="Checks that the model above can be reached.">
        <div className="inline-field">
          {badge}
          <Button loading={status === 'checking'} onClick={check}>Test</Button>
        </div>
      </Row>
      <Row title="Model in use">
        <span>{status === 'online' ? modelName : 'Unknown until connected'}</span>
      </Row>
      {status === 'offline' && error && <p className="settings__note settings__note--warn">{error}</p>}
      <p className="settings__note">{PROVIDER_NOTE[provider.kind]}</p>
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
