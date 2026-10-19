/** Talking to Workers AI (the `env.AI` binding, or anything with the same `run`), and reading what it returns. */

export interface AiLike {
  run(model: string, inputs: unknown): Promise<unknown>;
}

/** The provider answered but could not produce output matching the schema. Worth retrying at a higher temperature. */
export class ModelOutputError extends Error {}

/** No model could be reached or every one refused. `quota` is true when the free daily allowance looks used up. */
export class ProviderUnavailable extends Error {
  quota: boolean;
  constructor(message: string, quota: boolean) {
    super(message);
    this.quota = quota;
  }
}

/** The model answered with something that is not a usable workflow after every attempt. */
export class GenerationFailed extends Error {}

export interface AiReply {
  content: string;
  promptTokens: number;
  completionTokens: number;
  neurons: number;
}

const QUOTA = /daily free allocation|neurons|quota|rate limit|too many requests|\b429\b|4006/i;
export const looksLikeQuota = (message: string) => QUOTA.test(message);

/** Reads an AI result: older models answer in `response`, newer ones in the OpenAI chat shape `choices[0].message.content`. */
export function parseAiResult(result: unknown): AiReply {
  const r = (result ?? {}) as Record<string, any>;
  let response: unknown = r.response;
  if (response === undefined || response === null) response = r.choices?.[0]?.message?.content;
  if (response === undefined || response === null) throw new ModelOutputError('The model returned no content.');
  const usage = (r.usage ?? {}) as Record<string, number>;
  return {
    content: typeof response === 'string' ? response : JSON.stringify(response),
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    neurons: Number(usage.neurons ?? 0),
  };
}

/** Runs one model. A "JSON Mode couldn't be met" failure becomes a ModelOutputError; anything else is passed on. */
export async function callModel(ai: AiLike, model: string, messages: unknown, schema: unknown, temperature: number): Promise<AiReply> {
  let result: unknown;
  try {
    result = await ai.run(model, {
      messages,
      response_format: { type: 'json_schema', json_schema: schema },
      temperature,
      max_tokens: 400,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/json mode/i.test(message)) throw new ModelOutputError(message);
    throw e;
  }
  return parseAiResult(result);
}
