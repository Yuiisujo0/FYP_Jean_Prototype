/**
 * Why a workflow cannot give an answer, in plain words, worked out from the steps and the Data library before anything
 * runs. The screens show this first, instead of "Ready to run", so a person sees at once why there is no result.
 * Screen code only: the evaluation does not import this file.
 */
import { findDataset, type DatasetRef } from './engine.ts';
import type { Step } from '../types.ts';

export interface NoAnswer {
  kind: 'no_data' | 'missing_dataset' | 'no_source' | 'llm_step';
  title: string;
  detail: string;
  /** The step to point at, if one is to blame. */
  stepId?: string;
}

/** Steps that bring rows into a workflow. */
const READS = new Set(['READ_CSV', 'HTTP_REQUEST']);

/** `datasets` is the Data library, or null while it is still loading (then nothing is judged). */
export function whyNoAnswer(steps: Step[], datasets: DatasetRef[] | null): NoAnswer | null {
  if (!steps.length || !datasets) return null;

  const missing = steps.find(s => s.type === 'READ_CSV' && !findDataset(datasets, s.config.file ?? ''));
  if (missing) {
    const name = missing.config.file?.trim();
    return datasets.length === 0
      ? {
        kind: 'no_data',
        title: 'No answer yet: you have not added any data',
        detail: `This workflow reads ${name ? `“${name}”` : 'a table'}, but your Data library is empty. Add the sample data or upload your own file, then run it again.`,
        stepId: missing.id,
      }
      : {
        kind: 'missing_dataset',
        title: `No answer yet: “${name || 'the table'}” is not in your data`,
        detail: `Upload a file with that name, or pick one of your tables in the step's settings (${datasets.map(d => d.name).join(', ')}).`,
        stepId: missing.id,
      };
  }

  if (!steps.some(s => READS.has(s.type))) {
    return datasets.length === 0
      ? {
        kind: 'no_data',
        title: 'No answer: you have not added any data',
        detail: 'There is nothing for the workflow to work on, so the AI could not plan real steps. Add the sample data or upload your own file, then build the workflow again.',
      }
      : {
        kind: 'no_source',
        title: 'No answer: this workflow never reads a table',
        detail: `The AI could not match your request to any of your tables (${datasets.map(d => d.name).join(', ')}). Name the table in your request, or upload the one you meant, then build it again.`,
      };
  }

  const llm = steps.find(s => s.type === 'LLM');
  if (llm) {
    return {
      kind: 'llm_step',
      title: 'Part of this workflow cannot run yet',
      detail: `The step “${llm.name}” asks the AI to work on the rows, and jwork does not run those steps yet: rows pass through it unchanged, so the answer may not be what you asked for.`,
      stepId: llm.id,
    };
  }
  return null;
}
