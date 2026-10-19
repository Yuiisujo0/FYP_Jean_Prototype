/**
 * Which AI the app generates with. Three choices:
 *  - service: the Cloudflare Worker on the public site (or the Python backend locally). Nothing to set up.
 *  - ollama:  a model running on the user's own computer, called straight from the browser. Nothing leaves the machine.
 *  - custom:  any OpenAI-compatible endpoint with the user's own API key. The key stays in this browser and is sent only to that endpoint.
 */
export type ProviderKind = 'service' | 'ollama' | 'custom';

export interface ProviderConfig {
  kind: ProviderKind;
  ollamaUrl: string;
  ollamaModel: string;
  customUrl: string;
  customModel: string;
  customKey: string;
}

export const DEFAULT_PROVIDER: ProviderConfig = {
  kind: 'service',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  customUrl: 'https://openrouter.ai/api/v1',
  customModel: 'openai/gpt-oss-20b',
  customKey: '',
};

export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  service: 'Free hosted model',
  ollama: 'Ollama on this computer',
  custom: 'My own API key',
};

export const PROVIDER_SHORT: Record<ProviderKind, string> = { service: 'Hosted', ollama: 'Ollama', custom: 'API key' };

/** Well-known OpenAI-compatible providers, so that a user only has to paste a key. `model` is a suggestion, not a promise. */
export const API_PRESETS = [
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-20b', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b', keyUrl: 'https://console.groq.com/keys' },
] as const;

/** Where the Ollama OpenAI-compatible API lives, given the address the user typed (with or without /v1). */
export const ollamaApiBase = (url: string) => `${url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;

/** What the user has to fix, in words, when the browser cannot reach their Ollama. */
export function ollamaHelp(origin: string): string {
  return `Could not reach Ollama. Check that it is running, then allow this site to call it: set the environment variable OLLAMA_ORIGINS to ${origin} (or *) and restart Ollama. Use Chrome or Edge; Safari blocks calls to localhost.`;
}

/** Whether the chosen provider has everything it needs before a request is even tried. */
export function providerProblem(c: ProviderConfig): string | null {
  if (c.kind === 'ollama' && !c.ollamaModel.trim()) return 'Choose an Ollama model in Settings.';
  if (c.kind === 'custom') {
    if (!c.customUrl.trim()) return 'Enter the API address in Settings.';
    if (!c.customModel.trim()) return 'Enter a model name in Settings.';
    if (!c.customKey.trim()) return 'Enter your API key in Settings.';
  }
  return null;
}
