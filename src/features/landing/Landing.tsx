import { ArrowRight, Check, Lock, Monitor, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { gsap } from 'gsap';
import { LogoMark } from '../../components/Logo';
import { EXAMPLES, EXAMPLE_LABELS } from '../../data/examples';
import { greeting } from '../../lib/format';
import { useWorkspace } from '../../state/WorkspaceContext';
import { createBackdrop, type Scene } from './backdrop';
import './Landing.css';

/*
 * The hero cover of the Overview, and the first part of ONE scrolling page. The page is made taller by the cover's travel (a
 * spacer at the top, html.cover-pad::before), the cover is pinned over the first screen of it, and how far the page is
 * scrolled decides how far the cover is open: the globe and the neural web are drawn into the cursor, then an iris of light
 * grows from that point and reveals the Overview, which then simply continues to scroll. So the scrollbar on the right is the
 * page's own and runs through both, scrolling works with the wheel, trackpad, keys, touch or dragging the scrollbar, and
 * scrolling back up closes the Overview over again. Like design-previews/S-orbit.html, but with a short travel.
 *
 * It is there when the site is opened or reloaded. Choosing Overview in the sidebar goes straight to the Overview content.
 * "Your workspace" and Escape scroll on to the Overview.
 *
 * `?intro=0` and automated browsers (navigator.webdriver) skip it so the browser tests are untouched; `?intro=1` forces it.
 */

const WORDS = ['Builds.', 'Tests.', 'Runs.'];
const clamp = (x: number) => Math.min(1, Math.max(0, x));
/** How many screens of scrolling the whole opening takes. (The S-orbit preview pins for 1.7; this is meant to be quick.) */
const TRAVEL_SCREENS = 0.8;
const travelPx = () => Math.round(window.innerHeight * TRAVEL_SCREENS);

function introEnabled(search: string) {
  const flag = new URLSearchParams(search).get('intro');
  if (flag === '1') return true;
  if (flag === '0') return false;
  return !navigator.webdriver;
}

export function Landing() {
  const { pathname, search, state } = useLocation();
  const enabled = pathname === '/' && introEnabled(search);
  const toCover = (state as { cover?: boolean } | null)?.cover === true;   // the logo was pressed
  const [open, setOpen] = useState(enabled);
  const [reveal, setReveal] = useState(false);

  // Has the user moved between pages? Opening or reloading the site starts at the cover; arriving at the Overview from another
  // page (the sidebar) goes straight to its content.
  const firstPath = useRef(pathname);
  const navigated = useRef(false);
  useEffect(() => { if (pathname !== firstPath.current) navigated.current = true; }, [pathname]);

  // The page is taller by the cover's travel while the Overview is showing, so one scrollbar runs through cover and Overview.
  useEffect(() => {
    const html = document.documentElement;
    if (!enabled) { setOpen(false); return; }
    const size = () => html.style.setProperty('--cover-travel', `${travelPx()}px`);
    size();
    html.classList.add('cover-pad');
    if (!navigated.current || toCover) { window.scrollTo(0, 0); setReveal(false); setOpen(true); }
    else { window.scrollTo(0, travelPx()); setOpen(false); }
    window.addEventListener('resize', size);
    return () => { window.removeEventListener('resize', size); html.classList.remove('cover-pad'); html.style.removeProperty('--cover-travel'); };
  }, [enabled]);

  // Scrolling back up into the cover's part of the page brings the cover back.
  useEffect(() => {
    if (!enabled || open) return;
    const onScroll = () => {
      if (window.scrollY < travelPx() - 10 && !document.querySelector('.modal-scrim')) { setReveal(true); setOpen(true); }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [enabled, open]);

  if (!open) return null;
  return <LandingView reveal={reveal} onClose={() => setOpen(false)} />;
}

function LandingView({ reveal, onClose }: { reveal: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { profile, ollama } = useWorkspace();
  const [word, setWord] = useState(0);
  const [prompt, setPrompt] = useState('');

  const root = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const canvases = useRef<{ web: HTMLCanvasElement | null; webBloom: HTMLCanvasElement | null; orb: HTMLCanvasElement | null; orbBloom: HTMLCanvasElement | null }>({ web: null, webBloom: null, orb: null, orbBloom: null });
  const finish = useRef<(instant?: boolean) => void>(() => {});
  const go = useRef<() => void>(() => {});
  const typed = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // The words light up in turn.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setWord(2); return; }
    const id = window.setInterval(() => setWord(w => (w + 1) % 3), 2200);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const el = root.current;
    const c = canvases.current;
    if (!el || !c.web || !c.webBloom || !c.orb || !c.orbBloom) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const html = document.documentElement;
    const appRoot = document.getElementById('root');
    const scene: Scene = { boost: 0, pull: 0, warp: calm || reveal ? 0 : 1, hidden: false, core: { x: window.innerWidth * 0.72, y: window.innerHeight * 0.48 } };

    html.classList.add('cover-on');
    appRoot?.setAttribute('inert', '');
    input.current?.focus({ preventScroll: true });

    const backdrop = createBackdrop({ host: el, web: c.web, webBloom: c.webBloom, orb: c.orb, orbBloom: c.orbBloom, scene, calm });

    const exitEls = [...el.querySelectorAll<HTMLElement>('[data-exit]')];
    const wordEls = [...el.querySelectorAll<HTMLElement>('.landing__wi')];
    const prog = { p: 0 };
    let closed = false;
    let through = false;   // the iris is fully open: the cover no longer blocks the app

    // The app arrives with the iris, scrubbed by the scroll (so it is smooth, runs backwards on the way up, and never replays):
    // the sidebar slides in from the left, the top bar settles down, and the Overview's parts rise one after another. The
    // sidebar's own CSS transition on transform is switched off while the timeline drives it, or each frame would start a new one.
    const arriveCtx = gsap.context(() => {});
    let arrive: gsap.core.Timeline | null = null;
    let arriveTries = 0;
    const buildArrive = (): gsap.core.Timeline | null => {
      const wide = window.matchMedia('(min-width: 769px)').matches;
      const sidebar = wide ? document.querySelector<HTMLElement>('.sidebar') : null;
      const topbar = document.querySelector<HTMLElement>('.topbar');
      const parts = [...document.querySelectorAll<HTMLElement>('.dash > *')];
      if (!sidebar && !topbar && !parts.length) return null;
      const tl = gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } });
      if (sidebar) {
        gsap.set(sidebar, { transition: 'none' });
        tl.fromTo(sidebar, { xPercent: -100 }, { xPercent: 0, duration: 0.45 }, 0.5);
      }
      if (topbar) tl.fromTo(topbar, { y: -18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4 }, 0.55);
      if (parts.length) tl.fromTo(parts, { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, stagger: { amount: 0.15 } }, 0.55);
      tl.set({}, {}, 1);   // the timeline is exactly 1 long, so progress(p) is the scroll progress
      return tl;
    };

    const render = (p: number) => {
      scene.boost = clamp(p / 0.6) ** 1.6;
      scene.pull = clamp(p / 0.5) ** 3;
      exitEls.forEach((n, i) => {
        const k = clamp((p - i * 0.015) / 0.22);
        n.style.opacity = String(1 - k);
        n.style.transform = k ? `translateY(${-36 * k}px)` : '';
        n.style.filter = k ? `blur(${6 * k}px)` : '';
        n.style.pointerEvents = k > 0.6 ? 'none' : '';
      });
      wordEls.forEach((n, i) => { const k = clamp((p - i * 0.03) / 0.2); n.style.transform = k ? `translateY(${-125 * k}%) rotate(${-4 * k}deg)` : ''; });
      const k2 = clamp((p - 0.12) / 0.62), eased = k2 < 0.5 ? 2 * k2 * k2 : 1 - (-2 * k2 + 2) ** 2 / 2;
      const w = window.innerWidth, h = window.innerHeight, cx = scene.core.x, cy = scene.core.y;
      const r = eased * Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.06;
      if (r > 0.5) {
        el.classList.add('is-iris');
        el.style.setProperty('--cx', `${cx}px`); el.style.setProperty('--cy', `${cy}px`); el.style.setProperty('--r', `${r}px`);
      } else el.classList.remove('is-iris');
      const rg = ring.current;
      if (rg) { rg.style.left = `${cx}px`; rg.style.top = `${cy}px`; rg.style.width = rg.style.height = `${r * 2}px`; rg.style.opacity = r < 4 ? '0' : String(Math.min(1, (1 - k2) * 5)); }
      const fl = flash.current;
      if (fl) { fl.style.opacity = String(0.5 * Math.sin(clamp((p - 0.2) / 0.2) * Math.PI)); fl.style.background = `radial-gradient(circle at ${cx}px ${cy}px, rgb(235 255 252 / .95), rgb(95 227 214 / .4) 34%, transparent 66%)`; }
      // Once the iris has opened over the whole screen the cover is only a see-through sheet: let the pointer and keyboard
      // through to the app now, not at the very end of the scroll (the app is already pinned in place under it).
      const clear = k2 >= 0.85;
      if (clear !== through) {
        through = clear;
        el.style.visibility = clear ? 'hidden' : '';
        if (clear) { appRoot?.removeAttribute('inert'); if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); }
        else appRoot?.setAttribute('inert', '');
      }
      if (!arrive && arriveTries++ < 30) arriveCtx.add(() => { arrive = buildArrive(); });
      arrive?.progress(clamp(p));
      if (p >= 0.999) close();
    };

    function close() {
      if (closed) return;
      closed = true;
      scene.hidden = true;
      closeRef.current();
    }

    // The cover has no scroll of its own: how far the PAGE is scrolled decides how far the cover is open. The app underneath is
    // pinned to the screen (html.cover-on #root is position: fixed), so nothing moves against the browser's own scrolling. The
    // progress eases after the scroll position, like a scrubbed timeline, so a mouse wheel (which reports in steps) looks smooth.
    const targetNow = () => (window.scrollY >= travelPx() - 6 ? 1 : clamp(window.scrollY / travelPx()));
    prog.p = targetNow();   // coming back by scrolling up starts wherever the page already is
    const follow = (_t: number, ms: number) => {
      if (closed) return;
      const y = window.scrollY, travel = travelPx();
      if (calm) { if (y > 8) { window.scrollTo(0, travel); close(); } return; }
      const to = targetNow();
      const diff = to - prog.p;
      if (Math.abs(diff) < 0.0008) { if (prog.p !== to) { prog.p = to; render(prog.p); } return; }
      prog.p += diff * (1 - Math.exp(-Math.min(ms, 50) / 1000 / 0.09));
      render(prog.p);
    };
    gsap.ticker.add(follow);

    // Skipping (Escape, "Your workspace") scrolls the page on to the Overview.
    go.current = () => {
      if (closed) return;
      if (calm) { window.scrollTo(0, travelPx()); close(); return; }
      window.scrollTo({ top: travelPx(), behavior: 'smooth' });
    };
    finish.current = instant => { if (instant) close(); else go.current(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); go.current(); } };
    window.addEventListener('keydown', onKey);
    render(prog.p);

    // Entrance
    const ctx = gsap.context(() => {
      if (calm || reveal) return;
      gsap.to(scene, { warp: 0, duration: 3.2, ease: 'expo.out', delay: 0.1 });
      gsap.from('.landing__wi', { yPercent: 115, rotate: 3, duration: 1.3, stagger: 0.12, ease: 'expo.out', delay: 0.2 });
      gsap.from('.landing__intro', { y: 18, opacity: 0, duration: 1.1, stagger: 0.1, ease: 'expo.out', delay: 0.5 });
      gsap.from('.landing__scene', { opacity: 0, duration: 0.5 });
    }, el);

    return () => {
      closed = true;
      gsap.ticker.remove(follow);
      ctx.revert();
      window.removeEventListener('keydown', onKey);
      arriveCtx.revert();
      backdrop.destroy();
      html.classList.remove('cover-on');
      appRoot?.removeAttribute('inert');
    };
  }, []);

  // The prompt box types the examples, like a person would.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { if (input.current) input.current.placeholder = EXAMPLES[0]; return; }
    let alive = true, timer = 0;
    const type = (i: number) => {
      let n = 0;
      const step = () => {
        if (!alive || !input.current) return;
        if (!input.current.value) input.current.placeholder = EXAMPLES[i].slice(0, n) || ' ';
        if (n++ < EXAMPLES[i].length) timer = window.setTimeout(step, 26 + Math.random() * 30);
        else timer = window.setTimeout(() => { typed.current = (i + 1) % EXAMPLES.length; type(typed.current); }, 2600);
      };
      step();
    };
    timer = window.setTimeout(() => type(0), 1400);
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate('/generate', { state: { prompt: prompt.trim() } });
    finish.current(true);
  };

  const status = { online: 'connected', checking: 'checking…', offline: 'not connected', unknown: 'not checked' }[ollama.status];
  const name = profile.name.trim();

  return createPortal(
    <>
      <div ref={root} className="landing" role="dialog" aria-modal="true" aria-label="Welcome to jwork" tabIndex={-1}>
        <div className="landing__aurora" aria-hidden><i /><i /><i /></div>
        <div className="landing__grain" aria-hidden />
        <div className="landing__scene" aria-hidden>
          <canvas ref={n => { canvases.current.web = n; }} className="landing__canvas" />
          <canvas ref={n => { canvases.current.webBloom = n; }} className="landing__bloom" />
          <canvas ref={n => { canvases.current.orb = n; }} className="landing__canvas" />
          <canvas ref={n => { canvases.current.orbBloom = n; }} className="landing__bloom landing__bloom--orb" />
        </div>
        <div className="landing__vignette" aria-hidden />

        <header className="landing__bar landing__intro" data-exit>
          <div className="landing__brand"><LogoMark size={34} /><span>jwork</span></div>
          <div className="landing__bar-right">
            <span className="landing__hello hand">{greeting()}{name ? `, ${name}` : ''}</span>
            <span className={`landing__status is-${ollama.status}`}><i aria-hidden />{ollama.modelName} · {status}</span>
          </div>
        </header>

        <div className="landing__mid">
          <div className="landing__copy" data-nodrag>
            <h1 className="landing__headline" aria-label="Builds. Tests. Runs.">
              {WORDS.map((w, i) => (
                <span className="landing__ln" key={w}>
                  <span className="landing__wm"><span className={`landing__wi landing__hw ${i === word ? 'now' : i < word ? 'lit' : ''}`}>{w}</span></span>
                </span>
              ))}
            </h1>
            <p className="landing__lead landing__intro" data-exit>
              <b>A local AI agent for your data workflows.</b>
              <span className="landing__more"> Describe the job in plain words. It drafts the steps, dry-runs them on your data, fixes its own mistakes, then shows what happened to every row before you approve.</span>
            </p>
            <form className="landing__chat landing__intro" data-exit onSubmit={submit}>
              <Sparkles size={20} aria-hidden />
              <input ref={input} value={prompt} onChange={e => setPrompt(e.target.value)} aria-label="Describe the workflow you want" placeholder="Describe the workflow you want" autoComplete="off" />
              <button type="submit" className="landing__send">Generate <ArrowRight size={18} aria-hidden /></button>
            </form>
            <div className="landing__tries landing__intro" data-exit>
              <span>Try</span>
              {EXAMPLE_LABELS.map((label, i) => (
                <button type="button" key={label} onClick={() => { setPrompt(EXAMPLES[i]); input.current?.focus(); }}>{label}</button>
              ))}
            </div>
          </div>
        </div>

        <footer className="landing__bot landing__intro" data-exit>
          <div className="landing__promises">
            <span><Monitor size={18} aria-hidden />Runs on a local model</span>
            <span><Lock size={18} aria-hidden />Your rows stay in the browser</span>
            <span><Check size={18} aria-hidden />You approve before anything counts</span>
          </div>
          <button type="button" className="landing__cue" onClick={() => go.current()} aria-label="Enter your workspace">
            Your workspace <ArrowRight size={16} aria-hidden style={{ rotate: '90deg' }} />
          </button>
        </footer>
      </div>
      <div ref={flash} className="landing__flash" aria-hidden />
      <div ref={ring} className="landing__ring" aria-hidden />
    </>,
    document.body,
  );
}
