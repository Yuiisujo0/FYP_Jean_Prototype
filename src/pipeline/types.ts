export interface KindContract {
  type: string;
  label: string;
  defaultName: string;
  defaultDescription: string;
  required: string[];
  optional: string[];
  isSource: boolean;
  defaultConfig: Record<string, string>;
  /** How to fill the parameters, shown to the model (the exact syntax the engine can run). */
  hint: string;
}

export interface PatternContract {
  id: string;
  title: string;
  request: string;
  steps: { type: string; config: Record<string, string> }[];
  verified: boolean;
}

/** Everything the pipeline takes from the Python reference implementation (generated, see backend/scripts/export_contract.py). */
export interface Contract {
  kinds: KindContract[];
  schema: Record<string, unknown>;
  catalogueWithHints: string;
  catalogueWithoutHints: string;
  exampleRequest: string;
  exampleAnswer: string;
  patterns: PatternContract[];
}

/** An uploaded dataset as the model sees it: a name and column names, never rows. */
export interface DatasetBrief {
  name: string;
  columns: string[];
}

export interface RetrievedEntry {
  id: string;
  title: string;
  detail: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
