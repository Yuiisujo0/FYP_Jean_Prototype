/** The chosen provider, saved in this browser. The types and pure helpers are in providerConfig.ts (so tests can load them). */
import { DEFAULT_PROVIDER, type ProviderConfig } from './providerConfig';
import { KEYS, readJSON, writeJSON } from './storage';

export * from './providerConfig';

export function readProvider(): ProviderConfig {
  const saved = readJSON<Partial<ProviderConfig>>(KEYS.provider, {});
  const kind = saved.kind === 'ollama' || saved.kind === 'custom' ? saved.kind : 'service';
  return { ...DEFAULT_PROVIDER, ...saved, kind };
}

export const writeProvider = (config: ProviderConfig) => writeJSON(KEYS.provider, config);

