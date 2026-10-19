/** Prompt assembly. A port of backend/app/llm.py; the golden test checks the output is byte-for-byte identical. */
import type { ValidationIssue } from '../types';
import { contract } from './contract.ts';
import type { ChatMessage, DatasetBrief, RetrievedEntry } from './types.ts';

export const MAX_DATASETS_IN_PROMPT = 6;
export const MAX_COLUMNS_IN_PROMPT = 12;

/** The user's uploaded datasets: names and columns only, never rows (they would slow every request). */
export function datasetsText(datasets: DatasetBrief[]): string {
  if (!datasets.length) return '';
  const lines = datasets.slice(0, MAX_DATASETS_IN_PROMPT).map(d => {
    const cols = d.columns.slice(0, MAX_COLUMNS_IN_PROMPT);
    return `- ${d.name}: columns ${cols.join(', ')}${d.columns.length > cols.length ? ', ...' : ''}`;
  });
  return `\n\nThe user has uploaded these datasets:\n${lines.join('\n')}\n`
    + "If the request is about this data, set READ_CSV file to the dataset's exact name and use only its column names in conditions.";
}

export function systemPrompt(retrieved: RetrievedEntry[], datasets: DatasetBrief[] = [], hints = true): string {
  const patterns = retrieved.map(e => `- ${e.title}: ${e.detail}`).join('\n') || '- (none)';
  const catalogue = hints ? contract.catalogueWithHints : contract.catalogueWithoutHints;
  return `You convert a user's request into a linear automation workflow.

Use ONLY these operations:
${catalogue}

Answer with JSON: {"steps": [...]}. Each step is one flat object. Its "type" is an operation name and its other
fields are that operation's parameters.

Rules:
- The workflow is linear: each step feeds the next one.
- The first step must be a data source (INPUT, READ_FILE, READ_CSV or HTTP_REQUEST).
- The last step must be OUTPUT.
- Fill every parameter with a concrete value taken from the request, for example a FILTER condition such as "score < 50".
- Use only as many steps as the request needs, between 2 and 6. Do not add steps the user did not ask for.

Relevant reference patterns:
${patterns}${datasetsText(datasets)}`;
}

export function buildMessages(prompt: string, retrieved: RetrievedEntry[], datasets: DatasetBrief[] = [], hints = true): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(retrieved, datasets, hints) },
    { role: 'user', content: contract.exampleRequest },
    { role: 'assistant', content: contract.exampleAnswer },
    { role: 'user', content: prompt },
  ];
}

export function repairMessage(issues: ValidationIssue[]): string {
  const problems = issues.filter(i => i.level === 'ERROR').map(i => `- ${i.message}`).join('\n');
  return `That workflow has problems:\n${problems}\nReturn a corrected, complete workflow.`;
}

export function refineSystemPrompt(datasets: DatasetBrief[] = [], hints = true): string {
  const catalogue = hints ? contract.catalogueWithHints : contract.catalogueWithoutHints;
  return `You edit a linear automation workflow.

Use ONLY these operations:
${catalogue}

You are given the current workflow as JSON and an instruction. Answer with the complete updated workflow as JSON:
{"steps": [...]}. Each step is one flat object. Its "type" is an operation name and its other fields are that
operation's parameters.

Rules:
- Change only what the instruction asks for. Keep every other step exactly as it is, in the same order.
- The workflow stays linear: each step feeds the next one.
- The first step must be a data source (INPUT, READ_FILE, READ_CSV or HTTP_REQUEST).
- The last step must be OUTPUT.
- Use between 2 and 7 steps in total.
- If the instruction cannot be done with these operations, return the current workflow unchanged.${datasetsText(datasets)}`;
}

/** The workflow as the model writes it: one flat object per step, `type` first. */
export const flatStepsJson = (steps: { type: string; config: Record<string, string> }[]): string =>
  JSON.stringify({ steps: steps.map(s => ({ type: s.type, ...s.config })) });

export function refineMessages(steps: { type: string; config: Record<string, string> }[], instruction: string, datasets: DatasetBrief[] = [], hints = true): ChatMessage[] {
  return [
    { role: 'system', content: refineSystemPrompt(datasets, hints) },
    { role: 'user', content: `Current workflow:\n${flatStepsJson(steps)}\n\nInstruction: ${instruction}` },
  ];
}

/** The agent's revise step: the model sees the request, the workflow and a run report (counts and column names only). */
export function reviseSystemPrompt(datasets: DatasetBrief[] = [], hints = true): string {
  const catalogue = hints ? contract.catalogueWithHints : contract.catalogueWithoutHints;
  return `You check a linear automation workflow against what happened when it was run.

Use ONLY these operations:
${catalogue}

You are given the user's request, the current workflow as JSON, and a report of what happened when the workflow ran
on the user's data (counts and column names only). Answer with the complete workflow as JSON: {"steps": [...]}.
Each step is one flat object. Its "type" is an operation name and its other fields are that operation's parameters.

Rules:
- If the report shows the workflow does not do what the request asks (an error, an empty result, a step that did not
  run, a filter that kept every row), correct the workflow.
- Lines that start with "Check:" point at a likely mistake in how the request became steps (a value the request names
  that no filter uses, a value in the wrong column, a value the request never mentions, a ranking with no sort, and/or
  without brackets). Fix each one so the workflow does exactly what the request says.
- If the report is what the request should give, return the workflow unchanged.
- Change as little as possible, and do not add steps the request does not ask for.
- The workflow stays linear: each step feeds the next one.
- The first step must be a data source (INPUT, READ_FILE, READ_CSV or HTTP_REQUEST).
- The last step must be OUTPUT.
- Use between 2 and 7 steps in total.${datasetsText(datasets)}`;
}

export function reviseMessages(request: string, steps: { type: string; config: Record<string, string> }[], observation: string, datasets: DatasetBrief[] = [], hints = true): ChatMessage[] {
  return [
    { role: 'system', content: reviseSystemPrompt(datasets, hints) },
    { role: 'user', content: `Request: ${request}\n\nCurrent workflow:\n${flatStepsJson(steps)}\n\nWhat happened when it ran:\n${observation}` },
  ];
}
