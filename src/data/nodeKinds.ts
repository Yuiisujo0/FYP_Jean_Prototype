export type Category = 'input' | 'source' | 'ai' | 'transform' | 'storage' | 'network' | 'output';

export interface NodeKind {
  type: string;
  label: string;
  category: Category;
  blurb: string;
  defaultName: string;
  defaultDescription: string;
  defaultConfig: Record<string, string>;
  required: string[];
  /** Can start a workflow without an incoming connection. */
  isSource?: boolean;
}

export const NODE_KINDS: NodeKind[] = [
  {
    type: 'INPUT', label: 'Input', category: 'input', isSource: true,
    blurb: 'Receive data to start a flow',
    defaultName: 'New input', defaultDescription: 'Receive input data.',
    defaultConfig: { source: 'manual' }, required: ['source'],
  },
  {
    type: 'READ_FILE', label: 'Read file', category: 'source', isSource: true,
    blurb: 'Load a file from disk',
    defaultName: 'Read file', defaultDescription: 'Load a file from a source.',
    defaultConfig: { file: 'document.txt' }, required: ['file'],
  },
  {
    type: 'READ_CSV', label: 'Read CSV', category: 'source', isSource: true,
    blurb: 'Read rows from a CSV table',
    defaultName: 'Read CSV', defaultDescription: 'Read rows from a CSV file.',
    defaultConfig: { file: 'data.csv', delimiter: ',' }, required: ['file'],
  },
  {
    type: 'LLM', label: 'LLM', category: 'ai',
    blurb: 'Process text with a local model',
    defaultName: 'Ask the model', defaultDescription: 'Structure text with a local model.',
    defaultConfig: { task: 'summarise' }, required: [],
  },
  {
    type: 'FILTER', label: 'Filter', category: 'transform',
    blurb: 'Keep rows that match a rule',
    defaultName: 'Filter records', defaultDescription: 'Keep records that match a condition.',
    defaultConfig: { condition: 'score < 50' }, required: ['condition'],
  },
  {
    type: 'TRANSFORM', label: 'Transform', category: 'transform',
    blurb: 'Reshape fields for the next step',
    defaultName: 'Transform data', defaultDescription: 'Reshape fields for the next step.',
    defaultConfig: { operation: 'select columns' }, required: ['operation'],
  },
  {
    type: 'DATABASE', label: 'Database', category: 'storage',
    blurb: 'Save records to SQLite',
    defaultName: 'Save to database', defaultDescription: 'Store structured records.',
    defaultConfig: { table: 'records' }, required: ['table'],
  },
  {
    type: 'HTTP_REQUEST', label: 'HTTP request', category: 'network', isSource: true,
    blurb: 'Fetch data from an endpoint',
    defaultName: 'Fetch data', defaultDescription: 'Request data from an endpoint.',
    defaultConfig: { method: 'GET', url: 'https://example.local/data' }, required: ['method', 'url'],
  },
  {
    type: 'OUTPUT', label: 'Output', category: 'output',
    blurb: 'Deliver the final result',
    defaultName: 'Output', defaultDescription: 'Prepare workflow results.',
    defaultConfig: { format: 'table' }, required: ['format'],
  },
];

const byType = new Map(NODE_KINDS.map(k => [k.type, k]));

export const kindOf = (type: string): NodeKind | undefined => byType.get(type);
export const isSupported = (type: string) => byType.has(type);
export const categoryOf = (type: string): Category => byType.get(type)?.category ?? 'output';
export const labelOf = (type: string) => byType.get(type)?.label ?? type.replaceAll('_', ' ').toLowerCase();
