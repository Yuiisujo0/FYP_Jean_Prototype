import gsap from 'gsap';
import { useEffect, useMemo, useState } from 'react';

/** The one easing used for things that arrive: fast at first, then it settles. Matches `--ease` in tokens.css. */
export const EASE = 'expo.out';

/** True when the person asked their system for less motion. Movement is then skipped; colour and state changes stay. */
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A number that counts up to `value` when `play` is true, and is simply `value` otherwise (or with reduced motion).
 * Used for the row counts, so the totals are seen to be worked out and not just printed.
 */
export function useCountUp(value: number, play: boolean, duration = 0.8) {
  const animate = play && !reducedMotion();
  const [shown, setShown] = useState(animate ? 0 : value);
  useEffect(() => {
    if (!animate) { setShown(value); return; }
    const counter = { n: 0 };
    const tween = gsap.to(counter, { n: value, duration, ease: EASE, onUpdate: () => setShown(Math.round(counter.n)) });
    return () => { tween.kill(); };
  }, [value, animate, duration]);
  return shown;
}

/**
 * Things that have already been shown once, so coming back to a screen does not replay its entrance. Keyed by the object
 * itself (a run result, a flow), so it never grows: an entry goes when its object does.
 */
const shown = new WeakSet<object>();
export const wasShown = (thing: object | null | undefined) => !thing || shown.has(thing);
/** Call from an effect, not while rendering: React may render twice before anything is on screen. */
export const markShown = (thing: object | null | undefined) => { if (thing) shown.add(thing); };

/** `true` for the first screen that shows `thing`, and stays so while that screen is up; `false` on any later visit. */
export function useFirstShow(thing: object | null | undefined) {
  const first = useMemo(() => !wasShown(thing), [thing]);
  useEffect(() => { markShown(thing); }, [thing]);
  return first;
}
