/**
 * Client for the AI: the Worker or Python backend ("service"), or the user's own model (Ollama / API key) run from the browser.
 * Datasets are NOT here: they live in the browser (src/lib/library.ts).
 */
import type { Flow, Step, ValidationIssue } from '../types';
import type { DatasetBrief } from './library';
import { GenerationFailed, ProviderUnavailable, type AiLike } from '../pipeline/ai';
import { generateWorkflow } from '../pipeline/generate';
import { openAiCompatible } from '../pipeline/openaiAi';
import { refineWorkflow, reviseWorkflow } from '../pipeline/refine';
import { ollamaApiBase, ollamaHelp, providerProblem, readProvider, type ProviderConfig } from './provider';

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

/** For the user's own model (Ollama or an API key) the pipeline runs here in the browser; only the model call leaves. */
function browserRun(config: ProviderConfig, signal?: AbortSignal): { ai: AiLike; models: string[] } {
  const problem = providerProblem(config);
  if (problem) throw new Error(problem);
  if (config.kind === 'ollama') return { ai: openAiCompatible({ baseUrl: ollamaApiBase(config.ollamaUrl), signal }), models: [config.ollamaModel.trim()] };
  return { ai: openAiCompatible({ baseUrl: config.customUrl, apiKey: config.customKey.trim(), signal }), models: [config.customModel.trim()] };
}

/** Runs the pipeline in the browser and turns the failures into messages a person can act on. */
async function viaBrowser<T>(config: ProviderConfig, signal: AbortSignal | undefined, run: (r: { ai: AiLike; models: string[] }) => Promise<T>): Promise<T> {
  try {
    return await run(browserRun(config, signal));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (e instanceof ProviderUnavailable) {
      if (config.kind === 'ollama') {
        // A refused connection is a network error with no status; a model that is not installed answers with a status.
        if (!/status \d{3}/.test(e.message)) throw new Error(ollamaHelp(window.location.origin));
        if (/status 404/.test(e.message)) throw new Error(`Ollama does not have the model “${config.ollamaModel}”. Run: ollama pull ${config.ollamaModel}`);
      }
      if (/status 401|status 403/.test(e.message)) throw new Error('The provider rejected your API key. Check it in Settings.');
      if (e.quota) throw new Error('The provider says this key is out of quota or rate limited. Wait a moment, or check your plan.');
      throw new Error(`The model could not be reached. ${e.message.replace(/^No model could answer\.\s*/, '')}`);
    }
    if (e instanceof GenerationFailed) throw new Error(e.message);
    throw e;
  }
}

/** Turns a plain-English request into a workflow. `datasets` are names and columns only, never rows. */
export function generateFlow(prompt: string, signal?: AbortSignal, datasets?: DatasetBrief[]): Promise<GenerateResult> {
  const config = readProvider();
  if (config.kind === 'service') return request<GenerateResult>('/api/generate', json('POST', { prompt, datasets }, signal));
  return viaBrowser(config, signal, o => generateWorkflow(prompt, { ...o, datasets }));
}

/** Changes an existing workflow as the instruction says. Sends the steps and the instruction, never any data. */
export function refineFlow(steps: { type: string; config: Record<string, string> }[], instruction: string, signal?: AbortSignal, datasets?: DatasetBrief[]): Promise<RefineResult> {
  const config = readProvider();
  if (config.kind === 'service') return request<RefineResult>('/api/refine', json('POST', { steps, instruction, datasets }, signal));
  return viaBrowser(config, signal, o => refineWorkflow(steps, instruction, { ...o, datasets }));
}

/** The agent's revise step: sends the request, the steps and a run report (counts and column names, never data values). */
export function reviseFlow(task: string, steps: { type: string; config: Record<string, string> }[], observation: string, signal?: AbortSignal, datasets?: DatasetBrief[]): Promise<RefineResult> {
  const config = readProvider();
  const trimmed = observation.slice(0, 2000);
  if (config.kind === 'service') return request<RefineResult>('/api/revise', json('POST', { request: task, steps, observation: trimmed, datasets }, signal));
  return viaBrowser(config, signal, o => reviseWorkflow(task, steps, trimmed, { ...o, datasets }));
}
