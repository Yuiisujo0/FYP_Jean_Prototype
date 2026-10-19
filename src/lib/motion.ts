import gsap from 'gsap';

const EASE = 'expo.out';

/**
 * The signature move: marker strokes wipe across the text they highlight.
 * Elements with class `mark` start empty (--wipe: 0%) and are painted left to right.
 * With reduced motion the marks are simply there.
 */
export function wipeMarks(scope: Element | null, { delay = 0.15, stagger = 0.09, duration = 0.7 } = {}) {
  const mm = gsap.matchMedia();
  const marks = scope?.querySelectorAll<HTMLElement>('.mark');
  if (!marks?.length) return mm;
  mm.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.fromTo(marks, { '--wipe': '0%' }, { '--wipe': '100%', duration, delay, stagger, ease: EASE, clearProps: '--wipe' });
  });
  return mm;
}

/** Lines settle in one after another. */
export function settleIn(targets: gsap.TweenTarget, { delay = 0, stagger = 0.05 } = {}) {
  const mm = gsap.matchMedia();
  mm.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.from(targets, { y: 10, opacity: 0, duration: 0.55, delay, stagger, ease: EASE, clearProps: 'transform,opacity' });
  });
  return mm;
}
