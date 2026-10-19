import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelStatus } from '../types';
import { API_URL } from '../lib/api';
import { KEYS, readJSON, writeJSON } from '../lib/storage';

export interface OllamaConfig {
  url: string;
  model: string;
}

const DEFAULT_CONFIG: OllamaConfig = { url: 'http://localhost:11434', model: 'qwen3' };

/**
 * The state of the AI service the app generates with: the Cloudflare Worker on the public site, or the Python backend
 * when running locally. (The name is historical; `config` is the old Ollama setting and is no longer used.)
 */
export function useOllama() {
  const [config, setConfigState] = useState<OllamaConfig>(() => ({ ...DEFAULT_CONFIG, ...readJSON<Partial<OllamaConfig>>(KEYS.ollama, {}) }));
  const [status, setStatus] = useState<ModelStatus>('unknown');
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const latest = useRef(config);
  latest.current = config;

  const setConfig = useCallback((patch: Partial<OllamaConfig>) => {
    setConfigState(prev => {
      const next = { ...prev, ...patch };
      writeJSON(KEYS.ollama, next);
      return next;
    });
  }, []);

  const check = useCallback(async () => {
    setStatus('checking');
    setError('');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(`${API_URL}/api/health`, { signal: controller.signal });
      if (!res.ok) throw new Error(`The AI service answered with status ${res.status}.`);
      const body = (await res.json()) as { models?: string[] };
      setModels(body.models ?? []);
      setStatus('online');
    } catch (e) {
      setModels([]);
      setStatus('offline');
      setError(
        e instanceof DOMException && e.name === 'AbortError'
          ? 'The AI service did not answer in time.'
          : `Could not reach the AI service at ${API_URL}. Locally, start it with npm run dev:all. You can still edit workflows and use your data without it.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  /** A short name for the model in use, e.g. "gpt-oss-20b", or a neutral label when the service did not say. */
  const modelName = models[0]?.split('/').pop() ?? 'AI service';
  return { config, setConfig, status, models, modelName, error, check };
}
