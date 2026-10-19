/**
 * Cloudflare Worker: POST /api/generate turns a request into a validated workflow using Workers AI.
 *
 * It runs on Cloudflare, so the AI is reached through the `AI` binding: there is no API token anywhere in the app or in
 * a browser. The response has the same shape as the Python backend's /api/generate, so the frontend works with either.
 * Datasets are not stored here: the browser sends their names and column names (never rows) with the request.
 */
import { GenerationFailed, ProviderUnavailable, type AiLike } from '../../src/pipeline/ai.ts';
import { generateWorkflow } from '../../src/pipeline/generate.ts';
import { refineWorkflow, reviseWorkflow, type StepInput } from '../../src/pipeline/refine.ts';
import type { DatasetBrief } from '../../src/pipeline/types.ts';

export interface Env {
  AI: AiLike;
  /** Comma-separated list of browser origins that may call this Worker, or "*". */
  ALLOWED_ORIGINS?: string;
  /** Comma-separated model ids, strongest first; later ones are fallbacks. */
  MODELS?: string;
  /** Set to "false" to switch generation off (a kill switch). */
  AI_ENABLED?: string;
  MAX_REQUESTS_PER_MINUTE?: string;
}

const DEFAULT_MODELS = ['@cf/openai/gpt-oss-20b', '@cf/meta/llama-3.1-8b-instruct'];
const MAX_BODY_CHARS = 20_000;
const MAX_PROMPT = 500;
const MAX_INSTRUCTION = 300;
const MAX_OBSERVATION = 2000;

/* ---------------- helpers ---------------- */

function allowedOrigin(request: Request, env: Env): string | null {
  const list = (env.ALLOWED_ORIGINS ?? '*').split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes('*')) return '*';
  const origin = request.headers.get('Origin');
  return origin && list.includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : { Vary: 'Origin' };
}

function reply(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) } });
}

// Per-isolate and therefore approximate: Cloudflare may run several isolates. It stops one browser tab hammering the
// endpoint, nothing more. The real ceiling is the free daily allowance, which fails closed (the free plan never bills).
const recent = new Map<string, number[]>();
export const resetRateLimit = () => recent.clear();

function rateLimited(key: string, max: number, now: number): boolean {
  const hits = (recent.get(key) ?? []).filter(t => now - t < 60_000);
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) recent.clear();   // bound memory
  return hits.length > max;
}

type Failure = { error: string };

function readJsonObject(text: string): Record<string, unknown> | Failure {
  if (text.length > MAX_BODY_CHARS) return { error: 'The request is too large.' };
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { error: 'The request body must be JSON.' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'The request body must be a JSON object.' };
  return body as Record<string, unknown>;
}

function readDatasets(datasets: unknown): DatasetBrief[] | Failure {
  if (datasets === undefined) return [];
  if (!Array.isArray(datasets) || datasets.length > 50) return { error: '“datasets” must be a list of at most 50 items.' };
  const out: DatasetBrief[] = [];
  for (const d of datasets) {
    const name = (d as { name?: unknown })?.name;
    const columns = (d as { columns?: unknown })?.columns;
    const okName = typeof name === 'string' && name.length > 0 && name.length <= 80;
    const okColumns = Array.isArray(columns) && columns.length <= 100 && columns.every(c => typeof c === 'string' && c.length > 0 && c.length <= 80);
    if (!okName || !okColumns) return { error: 'Each dataset needs a name and a list of column names.' };
    out.push({ name, columns } as DatasetBrief);
  }
  return out;
}

export function parseBody(text: string): { prompt: string; datasets: DatasetBrief[] } | Failure {
  const body = readJsonObject(text);
  if ('error' in body) return body as Failure;
  if (typeof body.prompt !== 'string') return { error: '“prompt” must be text.' };
  const prompt = body.prompt.trim();
  if (prompt.length < 3) return { error: 'Describe the task in a few words.' };
  if (prompt.length > MAX_PROMPT) return { error: `Keep the description under ${MAX_PROMPT} characters.` };
  const datasets = readDatasets(body.datasets);
  if ('error' in datasets) return datasets;
  return { prompt, datasets };
}

export function parseRefineBody(text: string): { steps: StepInput[]; instruction: string; datasets: DatasetBrief[] } | Failure {
  const body = readJsonObject(text);
  if ('error' in body) return body as Failure;
  if (typeof body.instruction !== 'string') return { error: '“instruction” must be text.' };
  const instruction = body.instruction.trim();
  if (instruction.length < 3) return { error: 'Describe the change in a few words.' };
  if (instruction.length > MAX_INSTRUCTION) return { error: `Keep the instruction under ${MAX_INSTRUCTION} characters.` };
  const rest = readStepsAndDatasets(body);
  return 'error' in rest ? rest : { ...rest, instruction };
}

/** The agent's revise step: the request, the steps, and what a test run in the browser showed (counts, never values). */
export function parseReviseBody(text: string): { request: string; steps: StepInput[]; observation: string; datasets: DatasetBrief[] } | Failure {
  const body = readJsonObject(text);
  if ('error' in body) return body as Failure;
  if (typeof body.request !== 'string' || typeof body.observation !== 'string') return { error: '“request” and “observation” must be text.' };
  const request = body.request.trim();
  const observation = body.observation.trim();
  if (request.length < 3 || request.length > MAX_PROMPT) return { error: `The request must be 3 to ${MAX_PROMPT} characters.` };
  if (!observation || observation.length > MAX_OBSERVATION) return { error: `The observation must be 1 to ${MAX_OBSERVATION} characters.` };
  const rest = readStepsAndDatasets(body);
  return 'error' in rest ? rest : { ...rest, request, observation };
}

function readStepsAndDatasets(body: Record<string, unknown>): { steps: StepInput[]; datasets: DatasetBrief[] } | Failure {
  const raw = body.steps;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) return { error: '“steps” must be a list of 1 to 10 steps.' };
  const steps: StepInput[] = [];
  for (const st of raw) {
    const type = (st as { type?: unknown })?.type;
    const config = (st as { config?: unknown })?.config ?? {};
    const entries = config && typeof config === 'object' && !Array.isArray(config) ? Object.entries(config) : null;
    const ok = typeof type === 'string' && type.length > 0 && type.length <= 40 && entries !== null && entries.length <= 10
      && entries.every(([k, v]) => k.length <= 40 && typeof v === 'string' && v.length <= 300);
    if (!ok) return { error: 'Each step needs a type and parameters that are short text.' };
    steps.push({ type, config: config as Record<string, string> });
  }
  const datasets = readDatasets(body.datasets);
  if ('error' in datasets) return datasets;
  return { steps, datasets };
}

/* ---------------- the handler ---------------- */

/** Whatever goes wrong, the caller gets a short safe message and the details stay in the Worker's own log. */
export async function handle(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  try {
    return await route(request, env, now);
  } catch (e) {
    console.error('unexpected failure', e);
    return reply({ detail: 'Something went wrong. Please try again.' }, 500, null);
  }
}

/** The answer for a failure of the AI itself, or null if it is not one we expect (then it becomes a generic 500). */
function aiFailure(e: unknown, origin: string | null): Response | null {
  if (e instanceof ProviderUnavailable) {
    return reply({
      detail: e.quota
        ? "Today's free AI allowance is used up. The editor still works. Try again after 08:00 Malaysia time (00:00 UTC), or use a local model."
        : 'The AI service is unavailable right now. The editor still works.',
      code: e.quota ? 'quota' : 'unavailable',
    }, 503, origin);
  }
  if (e instanceof GenerationFailed) return reply({ detail: e.message }, 502, origin);
  return null;
}

const attemptsView = (attempts: { errors: number; warnings: number; ms: number; evalTokens: number; note: string }[]) =>
  attempts.map(a => ({ errors: a.errors, warnings: a.warnings, ms: a.ms, evalTokens: a.evalTokens, note: a.note }));

async function route(request: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(request.url);
  const origin = allowedOrigin(request, env);
  const models = (env.MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const modelList = models.length ? models : DEFAULT_MODELS;

  if (request.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: corsHeaders(origin) });
  if (request.headers.get('Origin') && !origin) return reply({ detail: 'This origin is not allowed to use the service.' }, 403, null);

  if (request.method === 'GET' && url.pathname === '/api/health') return reply({ status: 'ok', provider: 'workers-ai', models: modelList }, 200, origin);

  const isGenerate = request.method === 'POST' && url.pathname === '/api/generate';
  const isRefine = request.method === 'POST' && url.pathname === '/api/refine';
  const isRevise = request.method === 'POST' && url.pathname === '/api/revise';
  if (isGenerate || isRefine || isRevise) {
    if (env.AI_ENABLED === 'false') return reply({ detail: 'AI generation is switched off at the moment. The editor still works.', code: 'disabled' }, 503, origin);

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (rateLimited(ip, Number(env.MAX_REQUESTS_PER_MINUTE) || 10, now)) {
      return reply({ detail: 'Too many requests. Wait a minute and try again.', code: 'rate_limited' }, 429, origin);
    }

    const text = await request.text();
    try {
      if (isGenerate) {
        const parsed = parseBody(text);
        if ('error' in parsed) return reply({ detail: parsed.error }, 400, origin);
        const r = await generateWorkflow(parsed.prompt, { ai: env.AI, models: modelList, datasets: parsed.datasets });
        return reply({
          flow: r.flow, valid: r.valid, issues: r.issues, retrieved: r.retrieved,
          attempts: attemptsView(r.attempts), elapsedMs: r.elapsedMs, model: r.model, neurons: r.neurons,
        }, 200, origin);
      }
      let r;
      if (isRevise) {
        const parsed = parseReviseBody(text);
        if ('error' in parsed) return reply({ detail: parsed.error }, 400, origin);
        r = await reviseWorkflow(parsed.request, parsed.steps, parsed.observation, { ai: env.AI, models: modelList, datasets: parsed.datasets });
      } else {
        const parsed = parseRefineBody(text);
        if ('error' in parsed) return reply({ detail: parsed.error }, 400, origin);
        r = await refineWorkflow(parsed.steps, parsed.instruction, { ai: env.AI, models: modelList, datasets: parsed.datasets });
      }
      return reply({
        nodes: r.nodes, valid: r.valid, issues: r.issues, unchanged: r.unchanged,
        attempts: attemptsView(r.attempts), elapsedMs: r.elapsedMs, model: r.model, neurons: r.neurons,
      }, 200, origin);
    } catch (e) {
      const known = aiFailure(e, origin);
      if (known) return known;
      throw e;   // an unexpected failure: handle() logs it and answers with a generic 500
    }
  }

  return reply({ detail: 'Not found.' }, 404, origin);
}

export default { fetch: handle };
