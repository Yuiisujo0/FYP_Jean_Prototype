import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelStatus } from '../types';
import { KEYS, readJSON, writeJSON } from '../lib/storage';

export interface OllamaConfig {
  url: string;
  model: string;
}

const DEFAULT_CONFIG: OllamaConfig = { url: 'http://localhost:11434', model: 'qwen3' };

/** Talks to a local Ollama server. Only the connection check is real so far; generation is still mocked. */
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
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(`${latest.current.url.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Ollama answered with status ${res.status}.`);
      const body = (await res.json()) as { models?: { name: string }[] };
      setModels((body.models ?? []).map(m => m.name));
      setStatus('online');
    } catch (e) {
      setModels([]);
      setStatus('offline');
      setError(
        e instanceof DOMException && e.name === 'AbortError'
          ? 'No response from the server. Is Ollama running?'
          : 'Could not reach Ollama. Start it, and if the browser blocks the request, set OLLAMA_ORIGINS to allow this site.',
      );
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return { config, setConfig, status, models, error, check };
}
