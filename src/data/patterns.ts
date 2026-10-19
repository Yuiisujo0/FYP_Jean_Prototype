/**
 * The workflow patterns the AI is shown as examples: when a request arrives, the two closest are added to the prompt
 * (see src/pipeline/retrieval.ts). They come from the generated contract, so this list is exactly what the Worker uses.
 */
import { contract } from '../pipeline/contract';
import type { Step } from '../types';

export interface LibraryPattern {
  id: string;
  title: string;
  request: string;
  steps: Step[];
  /** true: its reference answer was compared with a separately computed result. false: uses the web or the model, which cannot be checked offline. */
  verified: boolean;
}

export const LIBRARY_PATTERNS: LibraryPattern[] = contract.patterns.map(p => ({
  id: p.id,
  title: p.title,
  request: p.request,
  verified: p.verified,
  steps: p.steps.map((s, i) => ({ id: `${p.id}-${i}`, type: s.type, name: s.type, description: '', config: s.config })),
}));
