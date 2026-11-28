import { ArrowRight, Clock3, Paperclip, Plus, Sparkles, Workflow as WorkflowIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FlowPreview } from '../../components/FlowPreview';
import { EmptyState } from '../../components/ui/EmptyState';
import { timeAgo } from '../../lib/format';
import { useFileDrop } from '../../state/useFileDrop';
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
const LOOP_MS = 7000;   // one pass along the path
const HOLD_MS = 1200;   // rest at the end, then the light goes out
const FADE_MS = 400;    // how long the light takes to go out once nothing holds it

/**
 * The four steps. They reveal as the section scrolls into view, then one smooth light travels the whole path once
 * (a single continuous motion, not step-by-step jumps), lighting each step as it passes, and goes out. After that the
 * section is still: nothing keeps moving beside someone who is working. Pointing at a step brings the light back to it.
 */
function HowItWorks() {
  const root = useRef<HTMLElement>(null);
  const pathEl = useRef<SVGPathElement>(null);
  const doneEl = useRef<SVGPathElement>(null);
  const dotEl = useRef<HTMLSpanElement>(null);
  const progress = useRef(0);        // 0 to 1 along the path
  const held = useRef<number | null>(null);
  const wake = useRef<() => void>(() => {});
  const [seen, setSeen] = useState(false);
  const [rested, setRested] = useState(false);
  const [active, setActive] = useState(0);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The steps play once they can actually be seen: on screen, and not behind the welcome cover (which lies over this page when
  // the site is opened; without this check the one pass was played out, unseen, while the cover was still up).
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const html = document.documentElement;
    let onScreen = false;
    let timer = 0;
    // `wait`: the cover has only just gone, and the page is busy settling for a moment, so the steps start a beat later.
    const check = (wait: number) => {
      if (!onScreen || html.classList.contains('cover-on')) return;
      io.disconnect();
      cover.disconnect();
      timer = window.setTimeout(() => setSeen(true), wait);
    };
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; check(0); }, { threshold: 0.35 });
    const cover = new MutationObserver(() => check(350));
    io.observe(el);
    cover.observe(html, { attributes: true, attributeFilter: ['class'] });
    return () => { io.disconnect(); cover.disconnect(); window.clearTimeout(timer); };
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
    // With reduced motion there is no travelling light: the whole path is simply drawn and every step is plain to read.
    if (reduced) { draw(1, 0); setActive(-1); setRested(true); return; }

    let raf = 0;
    let running = false;
    let last = 0;
    let rest = 0;
    let fade = 1;
    let finished = false;   // the one pass is over
    const settle = () => { running = false; dot.style.opacity = '0'; setActive(-1); setRested(true); };
    const tick = (now: number) => {
      const dt = Math.min(now - last, 64);
      last = now;
      if (held.current !== null) {
        // ease toward the held step so the light glides there instead of jumping
        const target = stopAt[held.current];
        progress.current += (target - progress.current) * Math.min(1, dt / 160);
        rest = 0;
        fade = 1;
        draw(progress.current, 1);
      } else if (finished) {
        // nothing holds the light any more: it goes out where it is, and the loop stops
        fade -= dt / FADE_MS;
        if (fade <= 0) { settle(); return; }
        draw(progress.current, fade);
      } else if (progress.current >= 1) {
        rest += dt;
        draw(1, Math.max(0, 1 - rest / HOLD_MS * 1.6));
        if (rest >= HOLD_MS) { finished = true; settle(); return; }
      } else {
        progress.current = Math.min(1, progress.current + dt / LOOP_MS);
        draw(progress.current, progress.current < 0.03 ? progress.current / 0.03 : 1);
      }
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    wake.current = start;
    start();
    return () => { cancelAnimationFrame(raf); wake.current = () => {}; };
  }, [seen, reduced]);

  const hold = (i: number) => { held.current = i; wake.current(); };

  return (
    <section className={`river ${seen ? 'is-seen' : ''} ${rested ? 'is-rested' : ''}`} aria-label="How it works" ref={root}>
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
            onMouseEnter={() => hold(i)}
            onFocus={() => hold(i)}
            onBlur={() => { held.current = null; }}
            onClick={() => hold(i)}
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

/**
 * The one thing to do here, first: say what is needed. With words in it, it goes to Generate and starts building at once;
 * empty, it just opens Generate, where the examples are.
 */
function AskBox({ onText, files }: { onText: (text: string) => void; files: ReturnType<typeof useFileDrop> }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  useEffect(() => onText(text), [text, onText]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    navigate('/generate', { state: prompt ? { prompt, auto: true } : null });
  };
  return (
    <form className="ask" onSubmit={submit}>
      <Sparkles size={20} aria-hidden />
      <input value={text} onChange={e => setText(e.target.value)} aria-label="Describe the list or total you need" placeholder="Describe the list or total you need" autoComplete="off" maxLength={500} />
      <button type="button" className="attach" onClick={files.pick} aria-label="Add a CSV or Excel file" title="Add a CSV or Excel file"><Paperclip size={19} aria-hidden /></button>
      {files.input}
      <button type="submit" className="btn btn--primary">Generate <ArrowRight size={17} aria-hidden /></button>
    </form>
  );
}

export function DashboardPage() {
  const { flows, knowledge, ollama, profile } = useWorkspace();
  // A CSV or Excel file dropped anywhere on the Overview, or chosen with the paperclip, goes to the Data library with what was typed.
  const typed = useRef('');
  const onText = useCallback((text: string) => { typed.current = text; }, []);
  const files = useFileDrop(() => typed.current);

  const recent = flows.slice(0, 3);

  const modelValue = { online: 'Model online', checking: 'Checking model…', offline: 'Model offline', unknown: 'Model unknown' }[ollama.status];
  const name = profile.name.trim();

  return (
    <div className="page dash" {...files.bind}>
      {files.overlay}
      <header className="dash__top">
        {/* Nobody is greeted by name until they give one on the Profile page. */}
        <h1 className="welcome">{name ? <>Welcome back, <em>{name}</em></> : 'Welcome to jwork'}</h1>
        <p className="dash__lead">Spreadsheet answers you can check before you send them on.</p>
        <AskBox onText={onText} files={files} />
        <section className="counts" aria-label="Workspace summary">
          <Link to="/workflows" className="count"><b>{flows.length}</b> <span>saved {flows.length === 1 ? 'workflow' : 'workflows'}</span></Link>
          <Link to="/knowledge" className="count"><b>{knowledge.length}</b> <span>knowledge {knowledge.length === 1 ? 'entry' : 'entries'}</span></Link>
          <Link to="/settings?tab=model" className="count">
            <span className={`count__on is-${ollama.status}`}><i aria-hidden />{modelValue}</span> <small>{ollama.modelName}</small>
          </Link>
        </section>
      </header>

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

      <HowItWorks />
    </div>
  );
}
