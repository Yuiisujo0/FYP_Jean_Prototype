import { ArrowRight, Clock3, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FlowPreview } from '../../components/FlowPreview';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { timeAgo } from '../../lib/format';
import { useDialogs } from '../../state/DialogsContext';
import { useWorkspace } from '../../state/WorkspaceContext';
import './DashboardPage.css';

const STEPS = [
  { title: 'Describe', text: 'Type what you want done to your spreadsheet.' },
  { title: 'Test', text: 'jwork tries it on your data first and fixes mistakes.' },
  { title: 'Review', text: 'See what happened to every row, kept or left out.' },
  { title: 'Approve', text: 'Sign it off and download an Excel report.' },
];

export function DashboardPage() {
  const { flows, knowledge, ollama, profile } = useWorkspace();
  const { openCreate } = useDialogs();

  const recent = flows.slice(0, 3);

  const modelValue = { online: 'Model online', checking: 'Checking model…', offline: 'Model offline', unknown: 'Model unknown' }[ollama.status];
  const name = profile.name.trim();

  return (
    <div className="page dash">
      <header className="dash__top">
        <h1 className="welcome">Welcome back{name ? <>, <em>{name}</em></> : ''}</h1>
      </header>

      <section className="counts" aria-label="Workspace summary">
        <Link to="/workflows" className="count">
          <b>{flows.length}</b>
          <span>saved workflows</span>
        </Link>
        <Link to="/knowledge" className="count">
          <b>{knowledge.length}</b>
          <span>knowledge entries</span>
        </Link>
        <Link to="/settings?tab=model" className="count">
          <span className={`count__on is-${ollama.status}`}><i aria-hidden />{modelValue}</span>
          <small>{ollama.config.model} via Ollama</small>
        </Link>
      </section>

      <section className="river" aria-label="How it works">
        <h2>How it works</h2>
        <p>Four easy steps, and you stay in charge of the last one.</p>
        <div className="stops">
          <svg className="stops__path" viewBox="0 0 1000 72" preserveAspectRatio="none" aria-hidden>
            <path d="M22 22 C 150 22, 150 50, 272 50 S 400 22, 522 22 S 650 50, 772 50 S 900 22, 990 22" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="2.5" strokeDasharray="2 9" strokeLinecap="round" />
          </svg>
          {STEPS.map((s, i) => (
            <div className="stop" key={s.title}>
              <span className="stop__no">{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="recent-sec">
        <div className="head">
          <h2>Pick up where you left off</h2>
          <Link to="/workflows" className="link-arrow">See all workflows <ArrowRight size={15} /></Link>
        </div>

        {recent.length ? (
          <div className="pebbles">
            {recent.map(f => (
              <Link key={f.id} to={`/editor/${f.id}`} className="pebble">
                <div>
                  <FlowPreview flow={f} />
                  <h3>{f.name}</h3>
                  <p>{f.description}</p>
                </div>
                <span className="pebble__meta">
                  <span>{f.nodes.length} steps</span>
                  <span><Clock3 size={13} aria-hidden /> {timeAgo(f.updatedAt)}</span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="card">
            <EmptyState
              icon={<WorkflowIcon size={24} />}
              title="No workflows yet"
              description="Describe a task on the Generate page, or start from a blank flow."
              action={<Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>Create workflow</Button>}
            />
          </div>
        )}
      </section>
    </div>
  );
}
