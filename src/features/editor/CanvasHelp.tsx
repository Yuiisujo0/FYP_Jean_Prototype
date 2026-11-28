import { Hand, SquareDashedMousePointer, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isMac } from '../../components/CommandPalette';
import { reducedMotion } from '../../lib/motion';
import type { Category } from '../../data/nodeKinds';
import './CanvasHelp.css';

/*
 * The canvas help, as pictures. Each gesture is a small drawing of the canvas that acts the gesture out: a pointer drags the
 * background, draws a box, joins two dots. One plays at a time, in turn, so the panel is never a wall of movement; pointing at
 * a drawing plays that one. Standing still (and with reduced motion) each drawing shows the gesture's result, so it still
 * reads as a diagram. The drawings are decoration for a screen reader: the words under them say the same thing.
 */

/** How long one drawing plays before the next takes over. The CSS animations run for the same time (--hx-t). */
const TURN_MS = 2800;

/* ---------- the drawing kit: a step card, the line between steps, the pointer ---------- */

interface StepProps { x: number; y: number; cat: Category; ring?: string | true; className?: string }
/** A step card, 40 by 27. `ring` draws the selection outline (its class decides when it shows). */
function Step({ x, y, cat, ring, className }: StepProps) {
  return (
    <g transform={`translate(${x} ${y})`} data-cat={cat}>
      <g className={className}>
        <rect className="hx-card" width="40" height="27" rx="6" />
        <rect className="hx-ico" x="5" y="5" width="8" height="8" rx="2.5" />
        <rect className="hx-bar" x="16" y="7.5" width="17" height="3" rx="1.5" />
        <rect className="hx-bar hx-bar--soft" x="5" y="18" width="26" height="3" rx="1.5" />
        {ring && <rect className={`hx-sel ${ring === true ? '' : ring}`} x="-2.5" y="-2.5" width="45" height="32" rx="8" />}
      </g>
    </g>
  );
}

const Wire = ({ x1, x2, y, className = '' }: { x1: number; x2: number; y: number; className?: string }) => (
  <path className={`hx-wire ${className}`} d={`M${x1} ${y}H${x2}`} />
);

/** The mouse pointer, with its tip at (x, y). `className` is the animation that moves it there. */
function Pointer({ x, y, className }: { x: number; y: number; className?: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={className}><path className="hx-cursor" d="M0 0v13.2l3.5-3.2 2.5 5.4 2.2-1-2.5-5.4h4.7z" /></g>
    </g>
  );
}

/** The ripple of a click, centred on (x, y). */
const Click = ({ x, y }: { x: number; y: number }) => <circle className="hx-click" cx={x} cy={y} r="7" />;

/* ---------- the eight drawings (each 160 by 96) ---------- */

const Pan = () => (
  <g className="hx-pan">
    <Wire x1={48} x2={60} y={39.5} /><Wire x1={100} x2={112} y={39.5} /><Wire x1={152} x2={164} y={39.5} />
    <Step x={8} y={26} cat="source" /><Step x={60} y={26} cat="transform" /><Step x={112} y={26} cat="storage" /><Step x={164} y={26} cat="output" />
    <g transform="translate(72 62)"><Hand size={17} className="hx-hand" /></g>
  </g>
);

const Zoom = () => (
  <>
    <g className="hx-zoom">
      <Wire x1={66} x2={94} y={38.5} />
      <Step x={26} y={25} cat="source" /><Step x={94} y={25} cat="transform" />
    </g>
    <g transform="translate(73 70)">
      <rect className="hx-mouse" width="14" height="20" rx="7" />
      <rect className="hx-wheel" x="6" y="3.5" width="2" height="5" rx="1" />
    </g>
  </>
);

const Edit = () => (
  <>
    <Wire x1={50} x2={62} y={37.5} />
    <Step x={10} y={24} cat="source" /><Step x={62} y={24} cat="transform" ring="hx-ring-on" />
    <g transform="translate(116 8)" data-cat="transform">
      <g className="hx-panel-in">
        <rect className="hx-panel" width="38" height="80" rx="6" />
        <rect className="hx-ico" x="6" y="7" width="8" height="8" rx="2.5" />
        <rect className="hx-bar" x="17" y="9.5" width="14" height="3" rx="1.5" />
        <rect className="hx-field" x="6" y="24" width="26" height="10" rx="3.5" />
        <rect className="hx-field" x="6" y="40" width="26" height="10" rx="3.5" />
        <rect className="hx-field" x="6" y="56" width="26" height="10" rx="3.5" />
      </g>
    </g>
    <Click x={86} y={40} />
    <Pointer x={86} y={40} className="hx-cursor-edit" />
  </>
);

const Move = () => (
  <>
    <rect className="hx-ghost" x="14" y="14" width="40" height="27" rx="6" />
    <g className="hx-move">
      <Step x={100} y={52} cat="transform" />
      <Pointer x={124} y={68} />
    </g>
  </>
);

const Box = () => (
  <>
    <Wire x1={50} x2={60} y={47.5} /><Wire x1={100} x2={110} y={47.5} />
    <Step x={10} y={34} cat="source" ring="hx-ring-late" /><Step x={60} y={34} cat="transform" ring="hx-ring-late" /><Step x={110} y={34} cat="output" />
    <rect className="hx-box" x="4" y="24" width="101" height="46" rx="4" />
    <Pointer x={105} y={70} className="hx-cursor-box" />
  </>
);

const Delete = () => (
  <>
    <Wire x1={48} x2={58} y={25.5} className="hx-fade" /><Wire x1={98} x2={108} y={25.5} className="hx-fade" />
    <Step x={8} y={12} cat="source" ring className="hx-vanish" /><Step x={58} y={12} cat="transform" ring className="hx-vanish" /><Step x={108} y={12} cat="output" />
    <g transform="translate(55 58)">
      <rect className="hx-keyshadow" y="3" width="50" height="24" rx="6" />
      <g className="hx-press">
        <rect className="hx-key" width="50" height="24" rx="6" />
        <text className="hx-keytext" x="25" y="15.2" textAnchor="middle">Delete</text>
      </g>
    </g>
  </>
);

const Join = () => (
  <>
    <path className="hx-wire hx-wire--on" d="M52 47.5H108" pathLength={1} />
    <Step x={12} y={34} cat="source" /><Step x={108} y={34} cat="transform" />
    <circle className="hx-dot" cx="52" cy="47.5" r="3" /><circle className="hx-dot" cx="108" cy="47.5" r="3" />
    <Pointer x={108} y={48} className="hx-cursor-join" />
  </>
);

const Add = () => (
  <>
    <g transform="translate(8 6)">
      <rect className="hx-panel" width="66" height="38" rx="6" />
      <rect className="hx-rowhi" x="3" y="20" width="60" height="14" rx="4" />
      <g data-cat="ai"><rect className="hx-ico" x="7" y="6" width="8" height="8" rx="2.5" /></g>
      <rect className="hx-bar" x="19" y="8.5" width="26" height="3" rx="1.5" />
      <g data-cat="storage"><rect className="hx-ico" x="7" y="23" width="8" height="8" rx="2.5" /></g>
      <rect className="hx-bar" x="19" y="25.5" width="30" height="3" rx="1.5" />
    </g>
    <Wire x1={46} x2={58} y={71.5} /><Wire x1={98} x2={110} y={71.5} className="hx-pop-wire" />
    <Step x={6} y={58} cat="source" /><Step x={58} y={58} cat="transform" /><Step x={110} y={58} cat="storage" className="hx-pop" />
    <Click x={58} y={33} />
    <Pointer x={58} y={33} className="hx-cursor-add" />
  </>
);

interface Gesture { id: string; title: string; how: ReactNode; art: ReactNode }

const mod = isMac ? '⌘' : 'Ctrl';
const GESTURES: Gesture[] = [
  { id: 'pan', title: 'Slide the view', how: 'Drag the background.', art: <Pan /> },
  { id: 'zoom', title: 'Zoom', how: <>Scroll, or use <b>−</b> and <b>+</b> below.</>, art: <Zoom /> },
  { id: 'edit', title: 'Edit a step', how: <>Click it. Its settings open in <b>Inspect</b>.</>, art: <Edit /> },
  { id: 'move', title: 'Move a step', how: 'Drag it to where you want it.', art: <Move /> },
  { id: 'box', title: 'Select several', how: <>Turn on <SquareDashedMousePointer size={13} aria-label="Select" /> and drag a box, or hold <kbd>Shift</kbd> and drag.</>, art: <Box /> },
  { id: 'delete', title: 'Delete', how: <>Select steps, then press <kbd>Delete</kbd>.</>, art: <Delete /> },
  { id: 'join', title: 'Join steps', how: 'Drag from a step’s dot to the next step.', art: <Join /> },
  { id: 'add', title: 'Add a step', how: <>Pick one in the <b>Add</b> tab.</>, art: <Add /> },
];

export function CanvasHelp({ onClose }: { onClose: () => void }) {
  const still = reducedMotion();
  const [playing, setPlaying] = useState(still ? -1 : 0);
  const held = useRef(false);   // the pointer is on a drawing: that one keeps playing

  useEffect(() => {
    if (still) return;
    const id = window.setInterval(() => { if (!held.current) setPlaying(p => (p + 1) % GESTURES.length); }, TURN_MS);
    return () => window.clearInterval(id);
  }, [still]);

  return (
    <>
      <header>
        <h3>Using the canvas</h3>
        <button type="button" className="dock__close" aria-label="Close help" onClick={onClose}><X size={16} /></button>
      </header>
      <ul className="gests">
        {GESTURES.map((g, i) => (
          <li
            key={g.id}
            className={`gest ${i === playing ? 'is-playing' : ''}`}
            onPointerEnter={() => { if (still) return; held.current = true; setPlaying(i); }}
            onPointerLeave={() => { held.current = false; }}
          >
            <svg className="gest__art" viewBox="0 0 160 96" aria-hidden focusable="false">{g.art}</svg>
            <b>{g.title}</b>
            <span>{g.how}</span>
          </li>
        ))}
      </ul>
      <p className="gests__more">
        <kbd>{mod}</kbd> + click adds one step to a selection. With <SquareDashedMousePointer size={13} aria-label="Select" /> on, hold <kbd>Space</kbd> and drag to slide the view.
      </p>
    </>
  );
}
