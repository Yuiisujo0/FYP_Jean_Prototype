import { ArrowRight, Clock3, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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

/** The four steps. They reveal as the section scrolls into view, then the highlight walks along the path by itself; a click holds it on one step. */
function HowItWorks() {
  const root = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState(false);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || held || reduced) return;
    const timer = setInterval(() => setActive(a => (a + 1) % STEPS.length), 2600);
    return () => clearInterval(timer);
  }, [seen, held, reduced]);

  return (
    <section className={`river ${seen ? 'is-seen' : ''}`} aria-label="How it works" ref={root}>
      <h2>How it works</h2>
      <p>Four easy steps, and you stay in charge of the last one.</p>
      <div className="stops" onMouseLeave={() => setHeld(false)}>
        <svg className="stops__path" viewBox="0 0 1000 72" preserveAspectRatio="none" aria-hidden>
          <path className="stops__dots" d="M22 22 C 150 22, 150 50, 272 50 S 400 22, 522 22 S 650 50, 772 50 S 900 22, 990 22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="2 9" strokeLinecap="round" pathLength={100} />
          <path className="stops__done" d="M22 22 C 150 22, 150 50, 272 50 S 400 22, 522 22 S 650 50, 772 50 S 900 22, 990 22" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" pathLength={100} strokeDasharray="100" strokeDashoffset={100 - (active / (STEPS.length - 1)) * 76} vectorEffect="non-scaling-stroke" />
        </svg>
        {STEPS.map((s, i) => (
          <button
            type="button"
            className={`stop ${i === active ? 'is-active' : i < active ? 'is-past' : ''}`}
            key={s.title}
            style={{ transitionDelay: seen ? `${i * 120}ms` : '0ms' }}
            onMouseEnter={() => { setActive(i); setHeld(true); }}
            onFocus={() => { setActive(i); setHeld(true); }}
            onBlur={() => setHeld(false)}
            onClick={() => setActive(i)}
            aria-current={i === active ? 'step' : undefined}
          >
            <span className="stop__no">{i + 1}</span>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </button>
        ))}
      </div>
    </section>
  );
}

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
          <small>{ollama.modelName}</small>
        </Link>
      </section>

      <HowItWorks />

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
