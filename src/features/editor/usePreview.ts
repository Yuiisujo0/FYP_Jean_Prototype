import { useEffect, useState } from 'react';
import { PreviewStop, runFlow } from '../../lib/engine';
import { runContext } from '../../lib/runContext';
import type { RunResult, Step } from '../../types';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: RunResult }
  | { status: 'blocked'; message: string }   // the workflow reaches outside the app (a web request)
  | { status: 'failed'; message: string };

/**
 * A live preview of what the workflow produces. It is a dry run: nothing is saved and no web address is called,
 * so it is safe to run on every change. `steps` must be in execution order.
 */
export function usePreview(steps: Step[], enabled: boolean): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const key = JSON.stringify(steps.map(s => [s.id, s.type, s.config]));

  useEffect(() => {
    if (!enabled) { setState({ status: 'idle' }); return; }
    let live = true;
    setState(prev => (prev.status === 'ready' ? prev : { status: 'loading' }));
    const timer = setTimeout(async () => {
      try {
        const result = await runFlow(steps, runContext, () => {}, { dryRun: true });
        if (live) setState({ status: 'ready', result });
      } catch (e) {
        if (!live) return;
        if (e instanceof PreviewStop) setState({ status: 'blocked', message: e.message });
        else setState({ status: 'failed', message: e instanceof Error ? e.message : 'The preview failed.' });
      }
    }, 500);
    return () => { live = false; clearTimeout(timer); };
    // `steps` is read when the key changes; moving a node on the canvas does not change the key.
  }, [key, enabled]);

  return state;
}
