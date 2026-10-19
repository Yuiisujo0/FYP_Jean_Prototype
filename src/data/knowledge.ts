import type { KnowledgeEntry } from '../types';

export const BUILT_IN_KNOWLEDGE: KnowledgeEntry[] = [
  {
    id: 'csv',
    title: 'Working with CSV input',
    category: 'Data sources',
    summary: 'Read tabular files and identify the fields your workflow needs.',
    detail: 'A CSV reading step needs a file path, a delimiter, and a header row containing stable column names. Later steps refer to those column names, so keep them consistent.',
  },
  {
    id: 'filters',
    title: 'Filter conditions',
    category: 'Data preparation',
    summary: 'Keep records that meet a clear, testable condition.',
    detail: 'Use explicit comparisons such as score < 50. Conditions should refer to fields that exist in the incoming records, and each filter should test one idea.',
  },
  {
    id: 'records',
    title: 'Saving structured records',
    category: 'Storage patterns',
    summary: 'Map selected fields into a predictable record shape.',
    detail: 'Choose the destination table and name the fields that should be preserved for later review. Saving after filtering keeps the table small and relevant.',
  },
  {
    id: 'linear',
    title: 'Linear workflow patterns',
    category: 'Workflow design',
    summary: 'Arrange each operation so its input comes from the previous step.',
    detail: 'A clear linear workflow begins with an input, performs one or more transformations, and ends with an output. Avoid branching until the linear case is reliable.',
  },
  {
    id: 'llm',
    title: 'Summarising text with an LLM',
    category: 'AI steps',
    summary: 'Turn documents or records into short summaries and labels.',
    detail: 'An LLM step takes text from the previous step and returns structured text. Keep the task specific, such as summarise or classify, so the output is predictable.',
  },
  {
    id: 'http',
    title: 'Fetching data over HTTP',
    category: 'Data sources',
    summary: 'Pull JSON from an endpoint and pass it to the next step.',
    detail: 'An HTTP step needs a method and a URL. Treat the response as a source: follow it with a transform to pick the fields you need before storing or reporting.',
  },
];
