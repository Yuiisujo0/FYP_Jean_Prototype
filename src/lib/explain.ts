/**
 * Plain-English sentences for workflow steps, built from the step's parameters (no model involved). They use the same
 * parsers as the engine, so what the sentence says is what Run will actually do. Their purpose is to let a person
 * spot a wrong workflow, such as "customer is Lim" where "contains Lim" was meant, that still passes validation.
 */
import type { Step } from '../types';
import { describeCondition, mixesAndOr, parseTransform } from './engine.ts';

const q = (s: string | undefined) => `“${s || '?'}”`;

export function explainStep(step: Step): string {
  const c = step.config ?? {};
  switch (step.type) {
    case 'INPUT':
      return `Starts from ${c.source || 'manual'} input.`;
    case 'READ_CSV':
      return `Reads the ${q(c.file)} dataset.`;
    case 'READ_FILE':
      return `Reads the file ${q(c.file)} (Run cannot read documents yet).`;
    case 'HTTP_REQUEST':
      return `Fetches data from ${c.url || '?'} (${(c.method || 'GET').toUpperCase()}).`;
    case 'FILTER': {
      const base = `Keeps only the rows where ${describeCondition(c.condition ?? '')}.`;
      return mixesAndOr(c.condition ?? '') ? `${base} Check the brackets: “and” is applied before “or”.` : base;
    }
    case 'TRANSFORM': {
      const op = parseTransform(c.operation ?? '');
      switch (op.kind) {
        case 'select': return `Keeps only the columns ${op.names.join(', ')}.`;
        case 'drop': return `Removes the columns ${op.names.join(', ')}.`;
        case 'rename': return `Renames the column ${op.from} to ${op.to}.`;
        case 'sort': return `Sorts the rows by ${op.column}, ${op.desc ? 'highest first' : 'lowest first'}.`;
        case 'limit': return `Keeps the first ${op.n} rows.`;
        case 'dedupe': return `Removes repeated rows (same ${op.by.length ? op.by.join(', ') : 'values in every column'}), keeping the first of each.`;
        case 'group': return op.by === null
          ? `Summarises all rows into one: ${op.aggregates.map(a => (a.column ? `${a.fn} of ${a.column}` : a.fn)).join(', ')}.`
          : `Groups the rows by ${op.by} and works out ${op.aggregates.map(a => (a.column ? `${a.fn} of ${a.column}` : a.fn)).join(', ')} for each group.`;
        case 'join': return `Adds the columns of ${q(op.dataset)} to each row, matching ${op.left}${op.right !== op.left ? ` to ${op.right}` : ''}.`;
        default: return `Would apply ${q(c.operation)}, but Run does not understand that, so this step is skipped.`;
      }
    }
    case 'LLM':
      return `Asks the model to ${c.task || 'process the text'} (LLM steps do not run yet: rows pass through unchanged).`;
    case 'DATABASE':
      return (c.mode ?? '').trim().toLowerCase() === 'append'
        ? `Adds the rows to the table ${q(c.table)} in the Data library, keeping what is already there (each run adds them again).`
        : `Saves the rows into the table ${q(c.table)} in the Data library, replacing its contents.`;
    case 'OUTPUT':
      return `Shows the result as ${c.format || 'a table'}.`;
    default:
      return step.type;
  }
}
