import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelStatus } from '../types';
import { API_URL } from '../lib/api';
import { cleanBaseUrl } from '../pipeline/openaiAi';
import { buildMessages, reviseMessages } from '../pipeline/prompt';
import { ollamaApiBase, ollamaHelp, providerProblem, readProvider, writeProvider, type ProviderConfig } from '../lib/provider';

const RECHECK_MS = 5000;
const RECHECK_TRIES = 36;   // three minutes

/**
 * The state of the AI the app generates with: the hosted service (Cloudflare Worker, or the Python backend locally),
 * Ollama on the user's computer, or the user's own API key. (The name is historical; this is the model connection.)
 */
export function useOllama() {
  const [provider, setProviderState] = useState<ProviderConfig>(readProvider);
  const [status, setStatus] = useState<ModelStatus>('unknown');
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const latest = useRef(provider);
  latest.current = provider;
  const run = useRef(0);   // a later check replaces an earlier one that is still in flight
  const warmed = useRef('');   // the Ollama address and model already asked to load during this visit

  const setProvider = useCallback((patch: Partial<ProviderConfig>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    writeProvider(next);
    setProviderState(next);
  }, []);

  /** `quiet`: a background re-check that leaves the status as it is until the answer is in (no "checking" flicker). */
  const probe = useCallback(async (quiet: boolean) => {
    const mine = ++run.current;
    const current = latest.current;
    if (!quiet) {
      setStatus('checking');
      setError('');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const finish = (ok: boolean, names: string[], message = '') => {
      if (mine !== run.current) return;
      setModels(names);
      setStatus(ok ? 'online' : 'offline');
      setError(message);
    };
    try {
      if (current.kind === 'service') {
        const res = await fetch(`${API_URL}/api/health`, { signal: controller.signal });
        if (!res.ok) throw new Error(`The AI service answered with status ${res.status}.`);
        const body = (await res.json()) as { models?: string[] };
        finish(true, body.models ?? []);
      } else if (current.kind === 'ollama') {
        const res = await fetch(`${ollamaApiBase(current.ollamaUrl).replace(/\/v1$/, '')}/api/tags`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Ollama answered with status ${res.status}.`);
        const body = (await res.json()) as { models?: { name: string }[] };
        const installed = (body.models ?? []).map(m => m.name);
        const wanted = current.ollamaModel.trim();
        const have = installed.some(n => n === wanted || n === `${wanted}:latest`);
        finish(have, installed, have ? '' : `Ollama is running but does not have “${wanted}”. Run: ollama pull ${wanted}${installed.length ? ` — or pick one you have: ${installed.join(', ')}.` : ''}`);
        if (have) warmUp(current.ollamaUrl, wanted, warmed);
      } else {
        const problem = providerProblem(current);
        if (problem) return finish(false, [], problem);
        // Most providers list models at /models; if that is blocked in the browser the first real request will say what is wrong.
        const res = await fetch(`${cleanBaseUrl(current.customUrl)}/models`, { headers: { Authorization: `Bearer ${current.customKey.trim()}` }, signal: controller.signal });
        if (res.status === 401 || res.status === 403) return finish(false, [], 'The provider rejected your API key.');
        finish(true, [current.customModel.trim()]);
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      const message = current.kind === 'ollama'
        ? ollamaHelp(window.location.origin)
        : current.kind === 'custom'
          ? (aborted ? 'The provider did not answer in time.' : 'Could not reach the provider. Check the API address. Some providers do not allow calls from a web page.')
          : aborted
            ? 'The AI service did not answer in time.'
            : `Could not reach the AI service at ${API_URL}. Locally, start it with npm run dev:all, or choose Ollama or your own API key in Settings. You can still edit workflows and use your data without it.`;
      finish(false, [], message);
    } finally {
      clearTimeout(timer);
    }
  }, []);
  const check = useCallback(() => probe(false), [probe]);

  useEffect(() => {
    void check();
  }, [check]);

  // Ollama takes a while to start (over a minute of GPU discovery on some laptops) and answers with errors until then.
  // While it is offline, look again every few seconds, so the page connects by itself once it is ready. Stops after
  // RECHECK_TRIES, when it comes online, or when the user picks another provider.
  useEffect(() => {
    if (status !== 'offline' || provider.kind !== 'ollama') return;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > RECHECK_TRIES) clearInterval(timer);
      else void probe(true);
    }, RECHECK_MS);
    return () => clearInterval(timer);
  }, [status, provider.kind, probe]);

  /** A short name for the model in use, e.g. "gpt-oss-20b", or a neutral label when none is known. */
  const modelName = (provider.kind === 'ollama' ? provider.ollamaModel : provider.kind === 'custom' ? provider.customModel : models[0])?.split('/').pop() || 'AI service';
  return { provider, setProvider, status, models, modelName, error, check };
}

/**
 * Gets Ollama ready while the user is still typing: loads the model (a request with no prompt only loads it), then sends
 * the opening of the generate and the revise prompt once, asking for a single token. Ollama keeps recent prompts and
 * reuses the part a new prompt shares with one of them, so the user's first request and the agent's first revision no
 * longer process the whole prompt. Measured on a 4 GB GPU with qwen2.5:7b: without this, the first generate took 15 s of
 * prompt processing and the first revision 17.5 s; the second ones 4.8 s and 2.5 s. Runs once per address and model per
 * visit; failures are ignored, because the real request reports any problem. The prompts are the real ones, unchanged.
 */
function warmUp(url: string, model: string, warmed: { current: string }) {
  const key = `${url}|${model}`;
  if (warmed.current === key) return;
  warmed.current = key;
  const base = ollamaApiBase(url).replace(/\/v1$/, '');
  const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: '15m', ...body }) });
  const prime = (messages: { role: string; content: string }[]) => post('/api/chat', { messages, stream: false, options: { num_predict: 1, temperature: 0 } });
  void (async () => {
    await post('/api/generate', {});
    await prime(buildMessages('Show the data', []));
    await prime(reviseMessages('Show the data', [], 'The result has 0 rows.'));
  })().catch(() => {});
}
