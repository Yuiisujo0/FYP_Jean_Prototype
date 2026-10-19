import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelStatus } from '../types';
import { API_URL } from '../lib/api';
import { cleanBaseUrl } from '../pipeline/openaiAi';
import { ollamaApiBase, ollamaHelp, providerProblem, readProvider, writeProvider, type ProviderConfig } from '../lib/provider';

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

  const setProvider = useCallback((patch: Partial<ProviderConfig>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    writeProvider(next);
    setProviderState(next);
  }, []);

  const check = useCallback(async () => {
    const mine = ++run.current;
    const current = latest.current;
    setStatus('checking');
    setError('');
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

  useEffect(() => {
    void check();
  }, [check]);

  /** A short name for the model in use, e.g. "gpt-oss-20b", or a neutral label when none is known. */
  const modelName = (provider.kind === 'ollama' ? provider.ollamaModel : provider.kind === 'custom' ? provider.customModel : models[0])?.split('/').pop() || 'AI service';
  return { provider, setProvider, status, models, modelName, error, check };
}
