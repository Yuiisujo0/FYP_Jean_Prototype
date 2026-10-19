/**
 * Natural language to a validated workflow: retrieve examples, prompt, schema-constrained model call, validate, repair.
 * A TypeScript port of generate_workflow in backend/app/llm.py, for running on Cloudflare Workers (and anywhere else).
 *
 * Models are tried in order for each call: if one cannot be reached or refuses (quota, outage), the next one is used.
 * A model that answers badly is retried at a higher temperature, as in the Python version.
 */
import type { Flow, ValidationIssue } from '../types';
import { validateWorkflow } from '../lib/validate.ts';
import { callModel, GenerationFailed, looksLikeQuota, ModelOutputError, ProviderUnavailable, type AiLike, type AiReply } from './ai.ts';
import { buildFlow } from './build.ts';
import { contract } from './contract.ts';
import { buildMessages, repairMessage } from './prompt.ts';
import { retrievePatterns } from './retrieval.ts';
import type { ChatMessage, DatasetBrief } from './types.ts';

const TEMPERATURES = [0.1, 0.5, 0.8];

export interface Attempt {
  errors: number;
  warnings: number;
  ms: number;
  evalTokens: number;
  neurons: number;
  note: string;
  model: string;
  /** The workflow this attempt produced, when it could be read. Lets the evaluation score the first draft on its own. */
  flow?: Flow;
}

export interface GenerationResult {
  flow: Flow;
  valid: boolean;
  issues: ValidationIssue[];
  retrieved: { id: string; title: string }[];
  attempts: Attempt[];
  elapsedMs: number;
  model: string;
  neurons: number;
}

export interface GenerateOptions {
  ai: AiLike;
  /** Tried in order; later ones are fallbacks. */
  models: string[];
  datasets?: DatasetBrief[];
  maxRepairs?: number;
  hints?: boolean;
  /** Temperature of the first attempt (repairs are hotter, as always). Used to draw several different candidates. */
  firstTemperature?: number;
}

async function ask(ai: AiLike, models: string[], messages: ChatMessage[], temperature: number): Promise<AiReply & { model: string }> {
  const failures: string[] = [];
  for (const model of models) {
    try {
      return { ...(await callModel(ai, model, messages, contract.schema, temperature)), model };
    } catch (e) {
      if (e instanceof ModelOutputError) throw e;                 // the model answered badly: retry hotter, do not switch
      failures.push(`${model}: ${e instanceof Error ? e.message : String(e)}`);   // unreachable or refused: try the next model
    }
  }
  const detail = failures.join(' | ');
  throw new ProviderUnavailable(`No model could answer. ${detail}`.slice(0, 500), looksLikeQuota(detail));
}

/** The model's JSON as steps, or null if it is not the expected shape (every value must be a string). */
function readDraft(content: string): { steps: Record<string, string>[] } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  const steps = (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return null;
  for (const s of steps) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if (!Object.values(s).every(v => typeof v === 'string')) return null;
  }
  return { steps: steps as Record<string, string>[] };
}

export interface Conversation {
  flow: Flow;
  issues: ValidationIssue[];
  attempts: Attempt[];
  model: string;
}

/** Ask for steps, validate them, and send any errors back for repair. Shared by generating and refining. */
export async function converse(messages: ChatMessage[], title: string, options: GenerateOptions): Promise<Conversation> {
  const attempts: Attempt[] = [];
  let best: { flow: Flow; issues: ValidationIssue[]; model: string } | null = null;

  for (let n = 0; n <= (options.maxRepairs ?? 2); n++) {
    const t0 = Date.now();
    let reply: AiReply & { model: string };
    try {
      const temperature = n === 0 && options.firstTemperature !== undefined ? options.firstTemperature : TEMPERATURES[Math.min(n, TEMPERATURES.length - 1)];
      reply = await ask(options.ai, options.models, messages, temperature);
    } catch (e) {
      if (e instanceof ModelOutputError) {
        attempts.push({ errors: 1, warnings: 0, ms: Date.now() - t0, evalTokens: 0, neurons: 0, model: options.models[0], note: `output rejected by provider: ${e.message}`.slice(0, 160) });
        continue;
      }
      throw e;
    }
    const ms = Date.now() - t0;

    const draft = readDraft(reply.content);
    if (!draft) {
      attempts.push({ errors: 1, warnings: 0, ms, evalTokens: reply.completionTokens, neurons: reply.neurons, model: reply.model, note: 'unparseable' });
      messages.push({ role: 'assistant', content: reply.content }, { role: 'user', content: 'That was not valid JSON for the schema. Return the workflow again.' });
      continue;
    }

    const flow = buildFlow(draft, title);
    const issues = validateWorkflow(flow.nodes, flow.edges);
    const errors = issues.filter(i => i.level === 'ERROR').length;
    attempts.push({ errors, warnings: issues.length - errors, ms, evalTokens: reply.completionTokens, neurons: reply.neurons, model: reply.model, note: '', flow });
    best = { flow, issues, model: reply.model };
    if (errors === 0) break;
    messages.push({ role: 'assistant', content: reply.content }, { role: 'user', content: repairMessage(issues) });
  }

  if (!best) throw new GenerationFailed('The model did not return a usable workflow after several attempts.');
  return { flow: best.flow, issues: best.issues, attempts, model: best.model };
}

export async function generateWorkflow(prompt: string, options: GenerateOptions): Promise<GenerationResult> {
  const started = Date.now();
  const retrieved = retrievePatterns(prompt, contract.patterns);
  const messages = buildMessages(prompt, retrieved, options.datasets ?? [], options.hints ?? true);
  const c = await converse(messages, prompt, options);
  return {
    flow: c.flow,
    valid: c.issues.every(i => i.level !== 'ERROR'),
    issues: c.issues,
    retrieved: retrieved.map(e => ({ id: e.id, title: e.title })),
    attempts: c.attempts,
    elapsedMs: Date.now() - started,
    model: c.model,
    neurons: c.attempts.reduce((sum, a) => sum + a.neurons, 0),
  };
}
