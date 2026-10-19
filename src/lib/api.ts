/**
 * Client for the AI backend: the Python backend (backend/app, for a local model) or the Cloudflare Worker (worker/, for the
 * public site). Both offer the same two endpoints. Datasets are NOT here: they live in the browser (src/lib/library.ts).
 */
import type { Flow, Step, ValidationIssue } from '../types';
import type { DatasetBrief } from './library';

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '');

export interface GenerateResult {
  flow: Flow;
  valid: boolean;
  issues: ValidationIssue[];
  retrieved: { id: string; title: string }[];
  elapsedMs: number;
  model: string;
}

export interface RefineResult {
  /** The whole workflow after the change, as steps with names and descriptions. */
  nodes: Step[];
  valid: boolean;
  issues: ValidationIssue[];
  /** True when the model returned the workflow as it was (nothing to change, or the edit is not possible). */
  unchanged: boolean;
  elapsedMs: number;
  model: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new Error(`Could not reach the AI service at ${API_URL}. Start the backend (npm run dev:all), or set VITE_API_URL to your deployed Worker. The editor and your data still work without it.`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const detail = typeof body?.detail === 'string' ? body.detail : `The AI service answered with status ${res.status}.`;
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const json = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal,
});

/** Turns a plain-English request into a workflow. `datasets` are names and columns only, never rows. */
export const generateFlow = (prompt: string, signal?: AbortSignal, datasets?: DatasetBrief[]) =>
  request<GenerateResult>('/api/generate', json('POST', { prompt, datasets }, signal));

/** Changes an existing workflow as the instruction says. Sends the steps and the instruction, never any data. */
export const refineFlow = (steps: { type: string; config: Record<string, string> }[], instruction: string, signal?: AbortSignal, datasets?: DatasetBrief[]) =>
  request<RefineResult>('/api/refine', json('POST', { steps, instruction, datasets }, signal));

/** The agent's revise step: sends the request, the steps and a run report (counts and column names, never data values). */
export const reviseFlow = (task: string, steps: { type: string; config: Record<string, string> }[], observation: string, signal?: AbortSignal, datasets?: DatasetBrief[]) =>
  request<RefineResult>('/api/revise', json('POST', { request: task, steps, observation: observation.slice(0, 2000), datasets }, signal));
