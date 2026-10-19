import { useEffect, useState } from 'react';

/**
 * 'closed': not in the page. 'enter': in the page at its resting (pre-open) style for a moment, so the open transition has
 * something to run from. 'open'. 'exit': still in the page while it plays its closing transition, then 'closed'.
 */
export type Phase = 'closed' | 'enter' | 'open' | 'exit';

/** Keeps something mounted long enough to animate out (transitions.dev: open slower than close, both interruptible). */
export function usePresence(open: boolean, exitMs: number): Phase {
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed');

  useEffect(() => {
    if (open) {
      if (phase === 'open') return;
      setPhase('enter');
      let second = 0;
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setPhase('open')); });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }
    if (phase === 'closed') return;
    setPhase('exit');
    const timer = window.setTimeout(() => setPhase('closed'), exitMs);
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);   // eslint-disable-line react-hooks/exhaustive-deps

  return phase;
}
