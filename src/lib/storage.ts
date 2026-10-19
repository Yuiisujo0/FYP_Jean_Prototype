import { makeStarters } from '../data/starters';
import type { AgentRound, Flow, FlowEdge, KnowledgeEntry, Step } from '../types';
import { chainEdges, withPositions } from './flowGraph';
import { makeId } from './id';
import { readApproval } from './review';

export const KEYS = {
  flows: 'jwork.flows.v1',
  knowledge: 'jwork.knowledge.v1',
  theme: 'jwork.theme',
  density: 'jwork.density',
  ollama: 'jwork.ollama',
  profile: 'jwork.profile',
  sidebar: 'jwork.sidebar',
  sidePanel: 'jwork.sidePanel',
  history: 'jwork.history.v1',
  lastBackup: 'jwork.lastBackup',
} as const;

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be full or blocked; the app keeps working in memory */
  }
}

export const readString = (key: string, fallback: string) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
export const writeString = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
};

/** Accepts flows saved by earlier versions (string "updated", no edges, no positions). */
export function normaliseFlow(raw: Partial<Flow> & { updated?: string }): Flow {
  const nodes = withPositions((raw.nodes ?? []) as Step[]);
  const edges: FlowEdge[] = Array.isArray(raw.edges) && raw.edges.length ? raw.edges : chainEdges(nodes);
  const approval = readApproval(raw.approval);
  const checks = Array.isArray(raw.checks)
    ? raw.checks.filter((c): c is AgentRound => !!c && typeof c === 'object' && typeof c.round === 'number' && typeof c.detail === 'string')
    : [];
  return {
    id: raw.id ?? makeId(),
    name: raw.name?.trim() || 'Untitled workflow',
    description: raw.description ?? '',
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    nodes,
    edges: edges.map(e => ({ id: e.id ?? makeId(), source: e.source, target: e.target })),
    ...(checks.length ? { checks } : {}),
    ...(approval ? { approval } : {}),
  };
}

export function loadFlows(): Flow[] {
  const saved = readJSON<unknown>(KEYS.flows, null);
  if (!Array.isArray(saved)) return makeStarters();
  return saved.map(f => normaliseFlow(f as Flow));
}

export const loadKnowledge = (): KnowledgeEntry[] => {
  const saved = readJSON<unknown>(KEYS.knowledge, []);
  return Array.isArray(saved) ? (saved as KnowledgeEntry[]) : [];
};

/** Validates an uploaded workflow file and turns it into a new Flow. Throws a readable message on failure. */
export async function parseFlowFile(file: File): Promise<Flow> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const obj = raw as { nodes?: unknown; flow?: { nodes?: unknown } };
  const candidate = (Array.isArray(obj?.nodes) ? obj : obj?.flow) as Partial<Flow> | undefined;
  const nodes = candidate?.nodes;
  if (!candidate || !Array.isArray(nodes) || !nodes.every((n: Step) => n && n.id && n.type && n.name)) {
    throw new Error('This file does not look like a jwork workflow.');
  }
  return { ...normaliseFlow(candidate), id: makeId(), name: candidate.name || file.name.replace(/\.jwork\.json$|\.json$/i, ''), updatedAt: Date.now() };
}

export async function parseKnowledgeFile(file: File): Promise<KnowledgeEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((x: Record<string, unknown>) => {
    const title = x?.title ?? x?.name;
    if (!title) throw new Error('Each entry needs a title or name.');
    return {
      id: makeId(),
      title: String(title),
      category: String(x.category ?? 'Imported'),
      summary: String(x.summary ?? x.description ?? 'Imported knowledge entry'),
      detail: String(x.detail ?? x.content ?? x.text ?? x.summary ?? 'No additional detail provided.'),
      imported: true,
    };
  });
}

/** `indent` 0 writes compact JSON, for files that hold whole datasets. */
export function downloadJSON(filename: string, data: unknown, indent = 2) {
  const blob = new Blob([JSON.stringify(data, null, indent)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
