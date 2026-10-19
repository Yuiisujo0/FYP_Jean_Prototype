/**
 * The agent's tools in the browser: test = a dry run on the Data library (nothing saved, no web calls), revise = the
 * AI service's /api/revise. Kept apart from agent.ts so the loop itself stays testable in Node.
 */
import type { Step } from '../types';
import type { AgentDeps } from './agent';
import { reviseFlow } from './api';
import { findDataset, PreviewStop, runFlow } from './engine';
import type { DatasetBrief } from './library';
import { runContext } from './runContext';

export function browserAgentDeps(request: string, datasets: DatasetBrief[], signal?: AbortSignal): Pick<AgentDeps, 'test' | 'revise' | 'request'> {
  return {
    request,
    async test(steps: Step[]) {
      // With no data at all, only the user can help (upload it); asking the model would waste a call. With data
      // uploaded, a dataset name that matches nothing is the model's mistake, and the run error tells it the names.
      const library = await runContext.listDatasets();
      const missing = steps.find(s => s.type === 'READ_CSV' && !findDataset(library, s.config.file ?? ''));
      if (missing && !library.length) return { blocked: 'your Data library is empty; upload the data first.' };
      try {
        return { result: await runFlow(steps, runContext, () => {}, { dryRun: true }) };
      } catch (e) {
        if (e instanceof PreviewStop) return { blocked: 'it fetches data from the web, which only Run does.' };
        return { error: e instanceof Error ? e.message : 'The run failed.' };
      }
    },
    async revise(steps: Step[], observation: string) {
      const r = await reviseFlow(request, steps.map(s => ({ type: s.type, config: s.config })), observation, signal, datasets);
      return { nodes: r.nodes, valid: r.valid, unchanged: r.unchanged, issues: r.issues };
    },
  };
}
