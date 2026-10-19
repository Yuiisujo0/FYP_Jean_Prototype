/**
 * An `AiLike` for any server that speaks the OpenAI chat-completions format: Ollama (`/v1`), OpenAI, OpenRouter, LM Studio,
 * Groq and others. It lets the browser run the same generate/refine pipeline the Worker runs, against a model the user chose.
 */
import type { AiLike } from './ai.ts';

export interface OpenAiCompatibleOptions {
  /** Ends in `/v1` (or the provider's equivalent), without a trailing slash. */
  baseUrl: string;
  /** Sent as a Bearer token. Ollama does not need one. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** The same address with whitespace and trailing slashes removed. */
export const cleanBaseUrl = (url: string) => url.trim().replace(/\/+$/, '');

export function openAiCompatible(options: OpenAiCompatibleOptions): AiLike {
  const base = cleanBaseUrl(options.baseUrl);
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const isOpenAi = /^https:\/\/api\.openai\.com\//i.test(base);

  return {
    async run(model, inputs) {
      const { messages, response_format, temperature, max_tokens } = inputs as {
        messages: unknown;
        response_format?: { type: string; json_schema?: unknown };
        temperature?: number;
        max_tokens?: number;
      };
      const body: Record<string, unknown> = { model, messages, stream: false };
      if (temperature !== undefined) body.temperature = temperature;
      // The real OpenAI API wants `max_completion_tokens`; everything else still takes `max_tokens`.
      if (max_tokens !== undefined) body[isOpenAi ? 'max_completion_tokens' : 'max_tokens'] = max_tokens;
      if (response_format?.type === 'json_schema') {
        // Workers AI takes the bare schema; the OpenAI format wants it wrapped with a name.
        body.response_format = { type: 'json_schema', json_schema: { name: 'workflow', schema: response_format.json_schema } };
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

      const res = await doFetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text.slice(0, 200);
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } | string };
          detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? detail;
        } catch { /* not JSON: keep the raw text */ }
        throw new Error(`status ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      return res.json();   // parseAiResult reads choices[0].message.content and usage
    },
  };
}
