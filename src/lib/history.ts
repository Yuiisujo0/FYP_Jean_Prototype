/** The requests the user has built workflows from, newest first, kept in this browser so they can be reused. */
import { KEYS, readJSON, writeJSON } from './storage';

export interface HistoryItem {
  id: string;
  text: string;
  at: number;
  /** The workflow that came out of it; the link is hidden once that workflow is deleted. */
  flowId: string;
}

const LIMIT = 12;

export function loadHistory(): HistoryItem[] {
  const saved = readJSON<unknown>(KEYS.history, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter((h): h is HistoryItem => !!h && typeof h.text === 'string' && typeof h.flowId === 'string' && typeof h.at === 'number' && typeof h.id === 'string').slice(0, LIMIT);
}

/** Adds a request at the top. The same text is kept once, with its latest workflow. */
export function addHistory(text: string, flowId: string): HistoryItem[] {
  const next = [{ id: `${Date.now()}-${flowId}`, text, at: Date.now(), flowId }, ...loadHistory().filter(h => h.text !== text)].slice(0, LIMIT);
  writeJSON(KEYS.history, next);
  return next;
}

export function clearHistory(): HistoryItem[] {
  writeJSON(KEYS.history, []);
  return [];
}
