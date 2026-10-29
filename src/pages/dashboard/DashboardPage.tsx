import { ArrowRight, Clock3, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FlowPreview } from '../../components/FlowPreview';
import { EmptyState } from '../../components/ui/EmptyState';
import { timeAgo } from '../../lib/format';
import { useWorkspace } from '../../state/WorkspaceContext';
import './DashboardPage.css';

const STEPS = [
  { title: 'Describe', text: 'Type what you want done to your spreadsheet.' },
  { title: 'Test', text: 'jwork tries it on your data first and fixes mistakes.' },
  { title: 'Review', text: 'See what happened to every row, kept or left out.' },
  { title: 'Approve', text: 'Sign it off and download an Excel report.' },
];

const PATH_D = 'M22 22 C 150 22, 150 50, 272 50 S 400 22, 522 22 S 650 50, 772 50 S 900 22, 990 22';
const STOP_X = [22, 272, 522, 772];
const LOOP_MS = 9000;   // one pass along the path
const HOLD_MS = 1400;   // rest at the end, then start over

/**
 * The four steps. They reveal as the section scrolls into view, then one smooth light travels the whole path
 * without pausing (a single continuous motion, not step-by-step jumps), lighting each step as it passes.
 * Pointing at a step holds the light there; moving away lets it carry on from that spot.
 */
function HowItWorks() {
  const root = useRef<HTMLElement>(null);
  const pathEl = useRef<SVGPathElement>(null);
  const doneEl = useRef<SVGPathElement>(null);
  const dotEl = useRef<HTMLSpanElement>(null);
  const progress = useRef(0);        // 0 to 1 along the path
  const held = useRef<number | null>(null);
  const [seen, setSeen] = useState(false);
  const [active, setActive] = useState(0);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const path = pathEl.current;
    const done = doneEl.current;
    const dot = dotEl.current;
    if (!seen || !path || !done || !dot) return;
    const total = path.getTotalLength();
    // Where along the path each step sits, found once by walking the path until it reaches that step's x.
    const stopAt = STOP_X.map(x => {
      let lo = 0, hi = total;
      for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (path.getPointAtLength(mid).x < x) lo = mid; else hi = mid; }
      return lo / total;
    });
    const draw = (t: number, fade: number) => {
      done.style.strokeDashoffset = String(100 - t * 100);
      const pt = path.getPointAtLength(t * total);
      dot.style.left = `${pt.x / 10}%`;
      dot.style.top = `${pt.y}px`;
      dot.style.opacity = String(fade);
      let idx = 0;
      stopAt.forEach((s, i) => { if (t >= s - 0.012) idx = i; });
      setActive(prev => (prev === idx ? prev : idx));
    };
    if (reduced) { draw(stopAt[0], 0); return; }

    let raf = 0;
    let last = performance.now();
    let rest = 0;
    const tick = (now: number) => {
      const dt = Math.min(now - last, 64);
      last = now;
      if (held.current !== null) {
        // ease toward the held step so the light glides there instead of jumping
        const target = stopAt[held.current];
        progress.current += (target - progress.current) * Math.min(1, dt / 160);
        rest = 0;
        draw(progress.current, 1);
      } else if (progress.current >= 1) {
        rest += dt;
        draw(1, Math.max(0, 1 - rest / HOLD_MS * 1.6));
        if (rest >= HOLD_MS) { progress.current = 0; rest = 0; }
      } else {
        progress.current = Math.min(1, progress.current + dt / LOOP_MS);
        draw(progress.current, progress.current < 0.03 ? progress.current / 0.03 : 1);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, reduced]);

  return (
    <section className={`river ${seen ? 'is-seen' : ''}`} aria-label="How it works" ref={root}>
      <h2>How it works</h2>
      <p>Four easy steps, and you stay in charge of the last one.</p>
      <div className="stops" onMouseLeave={() => { held.current = null; }}>
        <svg className="stops__path" viewBox="0 0 1000 72" preserveAspectRatio="none" aria-hidden>
          <path ref={pathEl} className="stops__dots" d={PATH_D} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="2 9" strokeLinecap="round" />
          <path ref={doneEl} className="stops__done" d={PATH_D} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" pathLength={100} strokeDasharray="100" strokeDashoffset="100" />
        </svg>
        <span ref={dotEl} className="stops__dot" aria-hidden />
        {STEPS.map((s, i) => (
          <button
            type="button"
            className={`stop ${i === active ? 'is-active' : i < active ? 'is-past' : ''}`}
            key={s.title}
            style={{ transitionDelay: seen ? `${i * 120}ms` : '0ms' }}
            onMouseEnter={() => { held.current = i; }}
            onFocus={() => { held.current = i; }}
            onBlur={() => { held.current = null; }}
            onClick={() => { held.current = i; }}
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

  const recent = flows.slice(0, 3);

  const modelValue = { online: 'Model online', checking: 'Checking model…', offline: 'Model offline', unknown: 'Model unknown' }[ollama.status];
  const name = profile.name.trim();

  return (
    <div className="page dash">
      <header className="dash__top">
        {/* Nobody is greeted by name until they give one on the Profile page. */}
        <h1 className="welcome">{name ? <>Welcome back, <em>{name}</em></> : 'Welcome to jwork'}</h1>
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
              description="Describe the list or total you need on the Generate page. There are examples there, with sample data to try them on."
              action={<Link to="/generate" className="btn btn--primary"><Plus size={16} aria-hidden /> Describe a task</Link>}
            />
          </div>
        )}
      </section>
    </div>
  );
}
