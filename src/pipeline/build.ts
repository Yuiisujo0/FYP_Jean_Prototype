/** Turns the model's bare steps into a full Flow (names, descriptions, ids, edges, positions). A port of build_flow and naming.py. */
import type { Flow, Step } from '../types';
import { contract } from './contract.ts';

const KIND = new Map(contract.kinds.map(k => [k.type, k]));
const NODE_GAP_X = 264;
const NODE_Y = 150;

const short = (text: string, limit = 38): string => {
  const t = text.split(/\s+/).filter(Boolean).join(' ');
  return t.length <= limit ? t : `${t.slice(0, limit - 1).trimEnd()}…`;
};
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
const hexId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');

function stepName(type: string, config: Record<string, string>): string {
  const c = (key: string, fallback = '') => (config[key] ?? '').trim() || fallback;
  const named: Record<string, () => string> = {
    INPUT: () => 'Start',
    READ_FILE: () => `Read ${c('file', 'file')}`,
    READ_CSV: () => `Read ${c('file', 'CSV')}`,
    LLM: () => `Model: ${c('task', 'process text')}`,
    FILTER: () => `Filter: ${c('condition', 'matching rows')}`,
    TRANSFORM: () => capitalize(c('operation', 'Transform data')),
    DATABASE: () => `Save to ${c('table', 'database')}`,
    HTTP_REQUEST: () => `${c('method', 'GET').toUpperCase()} request`,
    OUTPUT: () => `Output as ${c('format', 'result')}`,
  };
  return short(named[type]());
}

/** A step's parameters tidied the way every workflow is: trimmed, optional ones defaulted, empty ones dropped. */
export function normalizeConfig(type: string, raw: Record<string, string>): Record<string, string> {
  let config: Record<string, string> = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.trim()]));
  const kind = KIND.get(type);
  if (kind) {
    for (const key of kind.optional) if (!config[key]) config[key] = kind.defaultConfig[key] ?? '';
    // Blank *required* values are kept on purpose: the validator reports them and triggers a repair.
    config = Object.fromEntries(Object.entries(config).filter(([k, v]) => v || kind.required.includes(k)));
  }
  return config;
}

export function buildFlow(draft: { steps: Record<string, string>[] }, prompt: string): Flow {
  // No OUTPUT step: one is added at the end, as in build_flow (a repair call would cost time and tends to replace the
  // user's last step, such as a save, with OUTPUT).
  const raws = draft.steps.length && draft.steps.every(r => r.type !== 'OUTPUT') ? [...draft.steps, { type: 'OUTPUT', format: 'table' }] : draft.steps;
  const nodes: Step[] = raws.map((raw, i) => {
    const type = raw.type ?? '';
    const kind = KIND.get(type);
    const config = normalizeConfig(type, Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'type')));
    return {
      id: hexId(), type,
      name: kind ? stepName(type, config) : type || 'Unknown step',
      description: kind?.defaultDescription ?? '',
      config,
      position: { x: 80 + i * NODE_GAP_X, y: NODE_Y },
    };
  });
  const title = prompt.length <= 42 ? prompt : `${prompt.slice(0, 42).trimEnd()}…`;
  return {
    id: hexId(),
    name: title.slice(0, 1).toUpperCase() + title.slice(1),
    description: prompt,
    updatedAt: Date.now(),
    nodes,
    edges: nodes.slice(1).map((s, i) => ({ id: `e-${nodes[i].id}-${s.id}`, source: nodes[i].id, target: s.id })),
  };
}
