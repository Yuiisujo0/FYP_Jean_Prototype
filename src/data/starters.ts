import type { Flow, Step } from '../types';
import { chainEdges, withPositions } from '../lib/flowGraph';

const HOUR = 3_600_000;

function flow(id: string, name: string, description: string, ageMs: number, steps: Step[]): Flow {
  return { id, name, description, updatedAt: Date.now() - ageMs, nodes: withPositions(steps), edges: chainEdges(steps) };
}

/** Sample workflows shown on first launch, and restored by "Reset demo data". */
export const makeStarters = (): Flow[] => [
  flow('stock-review', 'Low stock review', 'Find items running low from a CSV and prepare a reorder list.', 4 * 60_000, [
    { id: 's1', type: 'READ_CSV', name: 'Read stock list', description: 'Load a CSV file of stock counts.', config: { file: 'stock_list.csv', delimiter: ',' } },
    { id: 's2', type: 'FILTER', name: 'Find stock below 5', description: 'Keep items that need reordering.', config: { condition: 'stock < 5' } },
    { id: 's3', type: 'DATABASE', name: 'Save reorder records', description: 'Store items and counts for follow-up.', config: { table: 'reorder_list' } },
    { id: 's4', type: 'OUTPUT', name: 'Reorder list', description: 'Make the resulting records available.', config: { format: 'table' } },
  ]),
  flow('weekly-report', 'Weekly report digest', 'Shape weekly data into a tidy report.', 26 * HOUR, [
    { id: 'r1', type: 'INPUT', name: 'Weekly source', description: 'Receive the report data.', config: { source: 'weekly_export.csv' } },
    { id: 'r2', type: 'TRANSFORM', name: 'Prepare summary', description: 'Normalise fields and summarise totals.', config: { operation: 'group by category' } },
    { id: 'r3', type: 'OUTPUT', name: 'Report output', description: 'Prepare a readable summary.', config: { format: 'csv' } },
  ]),
  flow('ticket-triage', 'Support ticket triage', 'Fetch tickets and let the local model label each one.', 52 * HOUR, [
    { id: 'w1', type: 'HTTP_REQUEST', name: 'Fetch tickets', description: 'Request open tickets from a source endpoint.', config: { method: 'GET', url: 'https://example.local/tickets' } },
    { id: 'w2', type: 'LLM', name: 'Classify request', description: 'Label each ticket with a category.', config: { task: 'classify' } },
    { id: 'w3', type: 'OUTPUT', name: 'Triage result', description: 'Return the structured result.', config: { format: 'json' } },
  ]),
];
