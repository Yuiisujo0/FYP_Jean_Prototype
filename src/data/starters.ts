import type { Flow, Step } from '../types';
import { chainEdges, withPositions } from '../lib/flowGraph';

const HOUR = 3_600_000;

function flow(id: string, name: string, description: string, ageMs: number, steps: Step[]): Flow {
  return { id, name, description, updatedAt: Date.now() - ageMs, nodes: withPositions(steps), edges: chainEdges(steps) };
}

/** Sample workflows shown on first launch, and restored by "Reset demo data". */
export const makeStarters = (): Flow[] => [
  flow('student-scores', 'Student score review', 'Find at-risk students from a CSV and prepare a review list.', 4 * 60_000, [
    { id: 's1', type: 'READ_CSV', name: 'Read student scores', description: 'Load a CSV file of student marks.', config: { file: 'student_scores.csv', delimiter: ',' } },
    { id: 's2', type: 'FILTER', name: 'Find scores below 50', description: 'Keep students who need a closer look.', config: { condition: 'score < 50' } },
    { id: 's3', type: 'DATABASE', name: 'Save review records', description: 'Store names and marks for follow-up.', config: { table: 'student_review' } },
    { id: 's4', type: 'OUTPUT', name: 'Review list', description: 'Make the resulting records available.', config: { format: 'table' } },
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
