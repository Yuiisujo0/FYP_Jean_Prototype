/**
 * Runs a linear workflow on real rows, in the browser. Pure logic: everything that touches the outside world
 * (stored datasets, saving a table, HTTP) comes in through RunContext, so this file can be tested on its own.
 *
 * FILTER conditions are parsed by a small hand-written parser. Nothing here uses eval or new Function.
 */
import type { RowRecord, RunException, RunRegister, RunResult, Step, StepTrace } from '../types';

export type Row = Record<string, string>;
export interface Table { columns: string[]; rows: Row[] }
/** `origin` is 'result' for a table a workflow saved; absent or 'upload' means the user's own data. */
export interface DatasetRef { id: number; name: string; filename: string; origin?: 'upload' | 'result' }

/** What a Database step does when the table already exists. A model never sets this; it defaults to replace. */
export type SaveMode = 'replace' | 'append';
/** What was stored. A context that cannot say (a test double) may return nothing. */
export interface SaveResult { total: number; created: boolean }

export interface RunContext {
  listDatasets: () => Promise<DatasetRef[]>;
  loadDataset: (id: number) => Promise<Table>;
  saveTable: (name: string, table: Table, mode: SaveMode) => Promise<SaveResult | void>;
  fetchJson: (url: string) => Promise<unknown>;
}

/** Thrown in a preview when a step would reach outside the app (a web request). Not an error in the workflow itself. */
export class PreviewStop extends Error {}

export interface RunOptions {
  /** Compute the result without saving anything or calling the web. Used for the live preview. */
  dryRun?: boolean;
}

export type NodeReport = (id: string, state: 'running' | 'complete' | 'error', message: string) => void;

const EMPTY: Table = { columns: [], rows: [] };
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const stripExt = (s: string) => s.replace(/\.[a-z0-9]{1,5}$/i, '');
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function saveModeOf(config: Record<string, string | undefined>): SaveMode {
  const raw = (config.mode ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'replace') return 'replace';
  if (raw === 'append') return 'append';
  throw new Error(`Unknown mode “${config.mode}”. Use replace or append.`);
}

/** The rows of `table` laid out in `target`'s columns, or null if the columns differ (header spelling and order are ignored). */
export function alignToColumns(target: string[], table: Table): Row[] | null {
  const byNorm = new Map(table.columns.map(c => [norm(c), c]));
  const same = [...byNorm.keys()].sort().join('\u0000') === target.map(norm).sort().join('\u0000');
  if (!same || byNorm.size !== table.columns.length) return null;
  return table.rows.map(r => Object.fromEntries(target.map(c => [c, r[byNorm.get(norm(c))!] ?? ''])));
}

export const columnMismatch = (name: string, target: string[], table: Table) =>
  `The columns do not match “${name}”. It has: ${target.join(', ')}. This workflow's result has: ${table.columns.join(', ')}.`;

/** Case- and punctuation-tolerant column lookup: "Score", "score" and "SCORE " all find the same column. */
function findColumn(columns: string[], name: string): string | undefined {
  return columns.find(c => c === name) ?? columns.find(c => norm(c) === norm(name));
}

function requireColumn(table: Table, name: string): string {
  const found = findColumn(table.columns, name);
  if (!found) {
    const have = table.columns.length ? table.columns.join(', ') : 'none (no data has been read yet)';
    throw new Error(`There is no column “${name}”. Available columns: ${have}.`);
  }
  return found;
}

/* ---------------- FILTER ---------------- */

type Operand = { col: string } | { lit: string; num?: number };
type Predicate = (row: Row) => boolean;

/** A cell that could not be compared: a blank or a non-number where the condition needs a number. */
export interface Undecided { column: string; value: string }
/**
 * `keep` is what Run does with the row (the long-standing rule: a blank or a non-number never satisfies a numeric
 * comparison, except `!=`). `decided` is false when that outcome hinged on such a value, in three-valued logic
 * (as SQL treats NULL): `score < 50 or status == late` is decided for a late row with a blank score, because the
 * second part settles it; `score < 50` alone is not.
 */
export interface CheckedOutcome { keep: boolean; decided: boolean; undecided: Undecided[] }
type Outcome = { keep: boolean; tri: boolean | null; undecided: Undecided[] };
type Evaluator = (row: Row) => Outcome;
const NONE: Undecided[] = [];
const definite = (v: boolean): Outcome => ({ keep: v, tri: v, undecided: NONE });

const isNumeric = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /\s*(?:(\()|(\))|(,)|(<=|>=|!=|==|=|<|>)|("[^"]*"|'[^']*')|([^\s()<>=!"',]+))/y;
  let pos = 0;
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) {
      if (text.slice(pos).trim() === '') break;
      throw new Error(`Cannot read the condition near “${text.slice(pos).trim().slice(0, 12)}”.`);
    }
    tokens.push(m[0].trim());
    pos = re.lastIndex;
  }
  return tokens;
}

const WORD_OPS = new Set(['contains', 'in', 'between']);
const SYMBOL_OPS = new Set(['<', '<=', '>', '>=', '==', '=', '!=']);
const isKeyword = (t: string, k: string) => t.toLowerCase() === k;

/** True if a condition mixes `and` with `or` at the same bracket level, where `and` is applied first: easy to misread. */
export function mixesAndOr(condition: string): boolean {
  let tokens: string[];
  try { tokens = tokenize(condition); } catch { return false; }
  const seen: { and: boolean; or: boolean }[] = [{ and: false, or: false }];
  let inBetween = false;   // the `and` in `x between 1 and 5` belongs to between, not to the logic
  for (const t of tokens) {
    const level = seen[seen.length - 1];
    if (t === '(') seen.push({ and: false, or: false });
    else if (t === ')') { if (seen.length > 1) seen.pop(); }
    else if (t.toLowerCase() === 'between') inBetween = true;
    else if (t.toLowerCase() === 'and') { if (inBetween) inBetween = false; else level.and = true; }
    else if (t.toLowerCase() === 'or') level.or = true;
    if (level.and && level.or) return true;
  }
  return false;
}

/** A condition in plain words, e.g. `score < 50 and course == CS101` becomes `score is less than 50 and course is CS101`. */
export function describeCondition(condition: string): string {
  let tokens: string[];
  try { tokens = tokenize(condition); } catch { return condition; }
  const words: Record<string, string> = { '==': 'is', '=': 'is', '!=': 'is not', '<': 'is less than', '<=': 'is at most', '>': 'is more than', '>=': 'is at least' };
  return tokens
    .map(t => words[t] ?? (t[0] === '"' || t[0] === "'" ? t.slice(1, -1) : t))
    .join(' ')
    .replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ,/g, ',');
}

/** Compiles e.g. `score < 50 and status contains "late"` into a row predicate. */
export function compileCondition(text: string, columns: string[]): Predicate {
  const evaluate = parseCondition(text, columns);
  return row => evaluate(row).keep;
}

/** Like compileCondition, but also says whether each row's outcome was really decided (see CheckedOutcome). */
export function checkCondition(text: string, columns: string[]): (row: Row) => CheckedOutcome {
  const evaluate = parseCondition(text, columns);
  return row => {
    const o = evaluate(row);
    return { keep: o.keep, decided: o.tri !== null, undecided: o.tri === null ? o.undecided : NONE };
  };
}

/** The columns a condition refers to, as written and as found (e.g. `score` written, `Score` found). */
export function conditionColumns(text: string, columns: string[]): { written: string; column: string }[] {
  let tokens: string[];
  try { tokens = tokenize(text); } catch { return []; }
  const out: { written: string; column: string }[] = [];
  for (const t of tokens) {
    if (t[0] === '"' || t[0] === "'" || SYMBOL_OPS.has(t) || ['(', ')', ','].includes(t)) continue;
    if (['and', 'or', 'not', ...WORD_OPS].includes(t.toLowerCase())) continue;
    const column = findColumn(columns, t);
    if (column && !out.some(o => o.written === t)) out.push({ written: t, column });
  }
  return out;
}

/** A bare word that can be part of a value: not a bracket, comma, operator, quoted text or the words and / or. */
const isBareWord = (t: string | undefined): t is string =>
  t !== undefined && !SYMBOL_OPS.has(t) && !['(', ')', ','].includes(t) && t[0] !== '"' && t[0] !== "'" && !['and', 'or'].includes(t.toLowerCase());

/** One comparison inside a condition: a column against a written value (column-to-column comparisons are not listed). */
export interface Comparison { column: string; op: string; literal: string }

/** The column-against-value comparisons a condition makes, e.g. `region in (South, West)` gives two. Empty if it cannot be read. */
export function conditionComparisons(text: string, columns: string[]): Comparison[] {
  const found: Comparison[] = [];
  try { parseCondition(text, columns, found); } catch { return []; }
  return found;
}

function parseCondition(text: string, columns: string[], collect?: Comparison[]): Evaluator {
  const tokens = tokenize(text);
  if (!tokens.length) throw new Error('The filter condition is empty.');
  let i = 0;
  let lastLeft: Operand | undefined;   // for `salary > 4000 and < 6000`: the second comparison reuses the column

  const operand = (isLeft: boolean): Operand => {
    const t = tokens[i++];
    if (t === undefined || SYMBOL_OPS.has(t) || t === '(' || t === ')') throw new Error(`The condition “${text}” is incomplete.`);
    if (t[0] === '"' || t[0] === "'") return { lit: t.slice(1, -1) };
    const col = findColumn(columns, t);
    if (col) return { col };
    if (isNumeric(t)) return { lit: t, num: Number(t) };
    if (isLeft) {
      throw new Error(`There is no column “${t}”. Available columns: ${columns.join(', ') || 'none (no data has been read yet)'}.`);
    }
    // An unquoted value of several words, such as `supplier == Delta Trading`: the words up to the next and / or / bracket.
    let word = t;
    while (isBareWord(tokens[i]) && !WORD_OPS.has(tokens[i].toLowerCase()) && !findColumn(columns, tokens[i])) word += ` ${tokens[i++]}`;
    return { lit: word };
  };

  const value = (o: Operand, row: Row) => ('col' in o ? row[o.col] ?? '' : o.lit);

  /** One comparison between two operands. */
  const compareOperands = (left: Operand, right: Operand, o: string): Evaluator => {
    if (collect && 'col' in left && 'lit' in right) collect.push({ column: left.col, op: o, literal: right.lit });
    const wantsNumber = ('num' in left && left.num !== undefined) || ('num' in right && right.num !== undefined);
    return row => {
      const a = value(left, row);
      const b = value(right, row);
      if (o === 'contains') return definite(a.toLowerCase().includes(b.toLowerCase()));
      if (isNumeric(a) && isNumeric(b)) return definite(compare(Number(a), Number(b), o));
      if (wantsNumber) {
        // A number is compared with text or a blank cell: never equal, never ordered. Run keeps that rule, but the
        // outcome is not really decided, so the cells involved are reported.
        const undecided = [left, right].flatMap(x => ('col' in x && !isNumeric(row[x.col] ?? '') ? [{ column: x.col, value: row[x.col] ?? '' }] : []));
        return { keep: o === '!=', tri: null, undecided };
      }
      const kept = compare(a.trim().toLowerCase(), b.trim().toLowerCase(), o);
      // Two columns, one holding a number and the other a blank or text: compared as text, which is not a real
      // comparison. The outcome (keep) is unchanged, but the cell is reported.
      if ('col' in left && 'col' in right && isNumeric(a) !== isNumeric(b)) {
        const odd = isNumeric(a) ? right.col : left.col;
        return { keep: kept, tri: null, undecided: [{ column: odd, value: row[odd] ?? '' }] };
      }
      return definite(kept);
    };
  };

  // Every part is evaluated (no short-circuit) so an undecided part is seen; the parts are pure, so `keep` is unchanged.
  const allOf = (parts: Evaluator[]): Evaluator => {
    if (parts.length === 1) return parts[0];
    return row => {
      const outs = parts.map(p => p(row));
      const tri = outs.some(x => x.tri === false) ? false : outs.some(x => x.tri === null) ? null : true;
      return { keep: outs.every(x => x.keep), tri, undecided: outs.flatMap(x => x.undecided) };
    };
  };

  const comparison = (): Evaluator => {
    if (tokens[i] === '(') {
      i++;
      const inner = or();
      if (tokens[i++] !== ')') throw new Error(`Missing a closing bracket in “${text}”.`);
      return inner;
    }
    const left = tokens[i] !== undefined && SYMBOL_OPS.has(tokens[i]) && lastLeft ? lastLeft : operand(true);
    lastLeft = left;
    let op = tokens[i++];
    let negate = false;
    if (op !== undefined && op.toLowerCase() === 'not' && tokens[i]?.toLowerCase() === 'in') { negate = true; op = tokens[i++]; }
    if (op === undefined || !(SYMBOL_OPS.has(op) || WORD_OPS.has(op.toLowerCase()))) {
      throw new Error(`Expected a comparison such as < > == contains or in in “${text}”.`);
    }
    if (op.toLowerCase() === 'between') {
      const low = operand(false);
      if (tokens[i]?.toLowerCase() !== 'and') throw new Error(`“between” needs two values joined by and, such as salary between 4000 and 6000, in “${text}”.`);
      i++;
      const high = operand(false);
      return allOf([compareOperands(left, low, '>='), compareOperands(left, high, '<=')]);   // both ends included
    }
    if (op.toLowerCase() === 'in') {
      if (tokens[i++] !== '(') throw new Error(`“in” needs a list in brackets, such as region in (South, West), in “${text}”.`);
      const options: Operand[] = [];
      while (tokens[i] !== ')') {
        if (tokens[i] === undefined) throw new Error(`Missing a closing bracket in “${text}”.`);
        if (tokens[i] === ',') { i++; continue; }
        options.push(operand(false));
      }
      i++;
      if (!options.length) throw new Error(`The list after “in” is empty in “${text}”.`);
      if (collect && 'col' in left) for (const o of options) if ('lit' in o) collect.push({ column: left.col, op: negate ? 'not in' : 'in', literal: o.lit });
      const cell = (o: Operand, row: Row) => ('col' in o ? row[o.col] ?? '' : o.lit);
      return row => {
        const a = cell(left, row);
        const hit = options.some(o => {
          const b = cell(o, row);
          return isNumeric(a) && isNumeric(b) ? Number(a) === Number(b) : a.trim().toLowerCase() === b.trim().toLowerCase();
        });
        return definite(negate ? !hit : hit);
      };
    }
    const right = operand(false);
    return compareOperands(left, right, op.toLowerCase());
  };

  const and = (): Evaluator => {
    const parts = [comparison()];
    while (tokens[i] !== undefined && isKeyword(tokens[i], 'and')) { i++; parts.push(comparison()); }
    return allOf(parts);
  };

  const or = (): Evaluator => {
    const parts = [and()];
    while (tokens[i] !== undefined && isKeyword(tokens[i], 'or')) { i++; parts.push(and()); }
    if (parts.length === 1) return parts[0];
    return row => {
      const outs = parts.map(p => p(row));
      const tri = outs.some(x => x.tri === true) ? true : outs.some(x => x.tri === null) ? null : false;
      return { keep: outs.some(x => x.keep), tri, undecided: outs.flatMap(x => x.undecided) };
    };
  };

  const predicate = or();
  if (i < tokens.length) throw new Error(`Cannot read “${tokens.slice(i).join(' ')}” in the condition.`);
  return predicate;
}

function compare<T extends number | string>(a: T, b: T, op: string): boolean {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '!=': return a !== b;
    default: return a === b; // '=' and '=='
  }
}

/* ---------------- TRANSFORM ---------------- */

const splitList = (s: string) => s.split(/\s*(?:,|;|\band\b)\s*/i).map(x => x.trim()).filter(Boolean);

export type AggFn = 'count' | 'average' | 'sum' | 'min' | 'max';
export interface Aggregate { fn: AggFn; column?: string }

export type TransformOp =
  | { kind: 'select' | 'drop'; names: string[] }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'sort'; column: string; desc: boolean }
  | { kind: 'limit'; n: number }
  | { kind: 'dedupe'; by: string[] }
  | { kind: 'group'; by: string | null; aggregates: Aggregate[] }
  | { kind: 'join'; dataset: string; left: string; right: string }
  | { kind: 'unknown'; why: string };

const AGG_WORDS: Record<string, AggFn> = { count: 'count', average: 'average', avg: 'average', mean: 'average', sum: 'sum', total: 'sum', min: 'min', minimum: 'min', max: 'max', maximum: 'max' };

function parseAggregates(list: string): Aggregate[] | string {
  const out: Aggregate[] = [];
  for (const part of splitList(list)) {
    const m = /^(count|average|avg|mean|sum|total|min|minimum|max|maximum)\b\s*(?:of\s+)?(.*)$/i.exec(part);
    if (!m) return `“${part}” is not something that can be calculated (use count, average, sum, min or max).`;
    const fn = AGG_WORDS[m[1].toLowerCase()];
    const column = m[2].trim();
    if (fn !== 'count' && !column) return `“${m[1]}” needs a column, for example “${m[1]} score”.`;
    out.push(fn === 'count' ? { fn } : { fn, column });
  }
  return out.length ? out : 'Say what to calculate, for example “count, average score”.';
}

/** Reads a TRANSFORM operation. Used both to run it and to explain it, so the two cannot drift apart. */
export function parseTransform(operation: string): TransformOp {
  const text = operation.trim();
  let m = /^(?:remove|drop|delete)\s+(?:the\s+)?(?:duplicates?|duplicate\s+rows?)\b\s*(?:by|on)?\s*:?\s*(.*)$/i.exec(text)
    ?? /^(?:dedupe|deduplicate|unique)\b\s*(?:by|on)?\s*:?\s*(.*)$/i.exec(text);
  if (m) return { kind: 'dedupe', by: splitList(m[1]) };
  m = /^group(?:ed)?\s+by\s+(.+?)\s*:\s*(.+)$/i.exec(text);
  if (m) {
    const aggregates = parseAggregates(m[2]);
    return typeof aggregates === 'string' ? { kind: 'unknown', why: aggregates } : { kind: 'group', by: m[1].trim(), aggregates };
  }
  m = /^(?:summari[sz]e|aggregate)\s*:?\s*(.+)$/i.exec(text);
  if (m) {
    const aggregates = parseAggregates(m[1]);
    return typeof aggregates === 'string' ? { kind: 'unknown', why: aggregates } : { kind: 'group', by: null, aggregates };
  }
  m = /^join\s+(.+?)\s+on\s+(.+?)(?:\s*=\s*(.+))?$/i.exec(text);
  if (m) return { kind: 'join', dataset: m[1].trim(), left: m[2].trim(), right: (m[3] ?? m[2]).trim() };
  m = /^(select|keep)\b\s*(?:columns?\b)?\s*:?\s*(.*)$/i.exec(text);
  if (m) {
    const names = splitList(m[2]);
    return names.length ? { kind: 'select', names } : { kind: 'unknown', why: '“select columns” needs the column names.' };
  }
  m = /^(drop|remove)\b\s*(?:columns?\b)?\s*:?\s*(.*)$/i.exec(text);
  if (m) {
    const names = splitList(m[2]);
    return names.length ? { kind: 'drop', names } : { kind: 'unknown', why: '“drop columns” needs the column names.' };
  }
  m = /^rename\s+(.+?)\s+(?:to|as)\s+(.+)$/i.exec(text);
  if (m) return { kind: 'rename', from: m[1].trim(), to: m[2].trim() };
  m = /^sort(?:\s+by)?\s+(.+?)(?:\s+(asc|desc|ascending|descending))?$/i.exec(text);
  if (m) return { kind: 'sort', column: m[1].trim(), desc: /^desc/i.test(m[2] ?? '') };
  m = /^(?:limit|top|first)\s+(\d+)$/i.exec(text);
  if (m) return { kind: 'limit', n: Number(m[1]) };
  return { kind: 'unknown', why: `“${text}” is not an operation the engine understands.` };
}

/** A table together with, for each row, the source rows it stands for (one for a plain row, several for a group). */
interface Tracked { table: Table; ids: number[][] }

type Note = Omit<RunException, 'id' | 'stepId' | 'stepName'> & { key: string };

interface TransformOutcome extends Tracked {
  message: string;
  /** Source rows the step removed, and why (limit, duplicates). */
  dropped?: { ids: number[]; reason: string }[];
  /** The step did not run: why. */
  skipped?: string;
  /** Things worth a person's attention (blank values in a sort, cells left out of an average, unmatched joins). */
  notes?: Note[];
  /** Extra dataset the step read, so a later DATABASE step cannot overwrite it. */
  readDataset?: string;
}

/** Whole numbers stay whole; otherwise at most 2 decimals, so Excel and the reference answers agree. */
export function formatNumber(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return String(Math.round(x * 100) / 100);
}

const sameKey = (s: string) => s.trim().toLowerCase();
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function aggregateName(a: Aggregate, column?: string): string {
  return a.fn === 'count' ? 'count' : `${a.fn}_${column}`;
}

function groupRows(table: Table, ids: number[][], op: Extract<TransformOp, { kind: 'group' }>): TransformOutcome {
  const by = op.by === null ? null : requireColumn(table, op.by);
  const aggs = op.aggregates.map(a => ({ a, column: a.column ? requireColumn(table, a.column) : undefined }));
  const names = aggs.map(({ a, column }) => aggregateName(a, column));
  if (new Set(names).size !== names.length) throw new Error('The same calculation is listed twice.');
  if (by !== null && names.includes(by)) throw new Error(`A calculated column would be named “${by}”, the same as the column grouped by.`);

  const groups = new Map<string, { label: string; idx: number[] }>();
  table.rows.forEach((row, i) => {
    const raw = by === null ? '' : (row[by] ?? '');
    const key = sameKey(raw);
    const g = groups.get(key) ?? { label: raw.trim(), idx: [] };
    g.idx.push(i);
    groups.set(key, g);
  });
  if (by === null && !groups.size) groups.set('', { label: '', idx: [] });

  const columns = by === null ? names : [by, ...names];
  const skippedCells = new Map<string, number[]>();   // aggregate column -> source rows whose cell was blank or text
  const rows: Row[] = [];
  const outIds: number[][] = [];
  for (const g of groups.values()) {
    const row: Row = {};
    if (by !== null) row[by] = g.label;
    aggs.forEach(({ a, column }, k) => {
      if (a.fn === 'count') { row[names[k]] = String(g.idx.length); return; }
      const nums: number[] = [];
      for (const i of g.idx) {
        const cell = table.rows[i][column!] ?? '';
        if (isNumeric(cell)) nums.push(Number(cell));
        else skippedCells.set(column!, [...(skippedCells.get(column!) ?? []), ...ids[i]]);
      }
      if (!nums.length) { row[names[k]] = a.fn === 'sum' ? '0' : ''; return; }
      const value = a.fn === 'sum' ? nums.reduce((x, y) => x + y, 0)
        : a.fn === 'average' ? nums.reduce((x, y) => x + y, 0) / nums.length
        : a.fn === 'min' ? Math.min(...nums) : Math.max(...nums);
      row[names[k]] = formatNumber(value);
    });
    rows.push(row);
    outIds.push(g.idx.flatMap(i => ids[i]));
  }

  const notes: Note[] = [];
  for (const [column, source] of skippedCells) {
    const rowsLeft = [...new Set(source)];
    notes.push({
      key: `aggregate:${column}`, kind: 'aggregate_skipped', severity: 'warning', column, rows: rowsLeft,
      message: `${count(rowsLeft.length, 'row')} ${plural(rowsLeft.length, 'has', 'have')} a blank or non-numeric ${column}, so ${plural(rowsLeft.length, 'it is', 'they are')} left out of the average, sum, min and max of ${column}.`,
    });
  }
  if (by !== null) {
    const blankKey = groups.get('');
    if (blankKey) {
      const rowsBlank = blankKey.idx.flatMap(i => ids[i]);
      notes.push({
        key: `groupkey:${by}`, kind: 'aggregate_skipped', severity: 'warning', column: by, rows: rowsBlank,
        message: `${count(rowsBlank.length, 'row')} ${plural(rowsBlank.length, 'has', 'have')} a blank ${by} and ${plural(rowsBlank.length, 'forms', 'form')} a group with an empty name.`,
      });
    }
  }
  return {
    table: { columns, rows }, ids: outIds,
    message: by === null ? `Summarised ${count(table.rows.length, 'row')} into one` : `Grouped ${count(table.rows.length, 'row')} into ${count(rows.length, 'group')} by ${by}`,
    ...(notes.length ? { notes } : {}),
  };
}

function dedupeRows(table: Table, ids: number[][], op: Extract<TransformOp, { kind: 'dedupe' }>): TransformOutcome {
  const cols = op.by.length ? op.by.map(n => requireColumn(table, n)) : table.columns;
  const first = new Map<string, number>();
  const rows: Row[] = [];
  const outIds: number[][] = [];
  const dropped: { ids: number[]; reason: string }[] = [];
  table.rows.forEach((row, i) => {
    const key = cols.map(c => sameKey(row[c] ?? '')).join('\u0000');
    const at = first.get(key);
    if (at === undefined) { first.set(key, ids[i][0]); rows.push(row); outIds.push(ids[i]); }
    else dropped.push({ ids: ids[i], reason: `duplicate of row ${at}` });
  });
  const removed = table.rows.length - rows.length;
  return {
    table: { columns: table.columns, rows }, ids: outIds,
    message: `Removed ${count(removed, 'duplicate row')} (matched on ${op.by.length ? cols.join(', ') : 'all columns'})`,
    ...(dropped.length ? { dropped } : {}),
  };
}

async function joinRows(table: Table, ids: number[][], op: Extract<TransformOp, { kind: 'join' }>, ctx: RunContext): Promise<TransformOutcome> {
  const found = findDataset(await ctx.listDatasets(), op.dataset);
  if (!found) throw new Error(`No dataset matches “${op.dataset}” to join with. Upload it under Knowledge base, Data.`);
  const other = await ctx.loadDataset(found.id);
  const left = requireColumn(table, op.left);
  const right = requireColumn(other, op.right);

  const index = new Map<string, Row[]>();
  for (const r of other.rows) {
    const key = sameKey(r[right] ?? '');
    if (key === '') continue;
    index.set(key, [...(index.get(key) ?? []), r]);
  }
  const added = other.columns.filter(c => !(c === right && right === left));
  const taken = new Set(table.columns);
  const addedNames = added.map(c => {
    let name = c;
    if (taken.has(name)) name = `${c}_${norm(found.name) || 'other'}`;
    while (taken.has(name)) name += '_2';
    taken.add(name);
    return name;
  });

  const unmatched: number[] = [];
  const several: number[] = [];
  const rows = table.rows.map((row, i) => {
    const matches = index.get(sameKey(row[left] ?? '')) ?? [];
    if (!matches.length) unmatched.push(...ids[i]);
    if (matches.length > 1) several.push(...ids[i]);
    const m = matches[0];
    const out: Row = { ...row };
    added.forEach((c, k) => { out[addedNames[k]] = m ? (m[c] ?? '') : ''; });
    return out;
  });

  const notes: Note[] = [];
  if (unmatched.length) notes.push({
    key: `join-unmatched:${left}`, kind: 'join_unmatched', severity: 'warning', column: left, rows: unmatched,
    message: `${count(unmatched.length, 'row')} ${plural(unmatched.length, 'has', 'have')} no match for ${left} in “${found.name}”, so the added columns are blank.`,
  });
  if (several.length) notes.push({
    key: `join-multiple:${left}`, kind: 'join_multiple', severity: 'critical', column: left, rows: several,
    message: `${count(several.length, 'row')} ${plural(several.length, 'matches', 'match')} more than one row in “${found.name}”; only the first match is used, so values may be missing.`,
  });
  return {
    table: { columns: [...table.columns, ...addedNames], rows }, ids,
    message: `Joined “${found.name}” on ${left}: ${rows.length - unmatched.length} of ${count(rows.length, 'row')} matched`,
    readDataset: found.name,
    ...(notes.length ? { notes } : {}),
  };
}

/** A few plain-English operations. Anything else is reported as skipped rather than guessed. */
async function transform({ table, ids }: Tracked, operation: string, ctx: RunContext): Promise<TransformOutcome> {
  const op = parseTransform(operation);
  switch (op.kind) {
    case 'select': {
      const cols = op.names.map(n => requireColumn(table, n));
      return { table: { columns: cols, rows: table.rows.map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? '']))) }, ids, message: `Kept ${count(cols.length, 'column')}` };
    }
    case 'drop': {
      const gone = new Set(op.names.map(n => requireColumn(table, n)));
      const cols = table.columns.filter(c => !gone.has(c));
      return { table: { columns: cols, rows: table.rows.map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? '']))) }, ids, message: `Dropped ${count(gone.size, 'column')}` };
    }
    case 'rename': {
      const from = requireColumn(table, op.from);
      if (op.to !== from && table.columns.includes(op.to)) throw new Error(`A column named “${op.to}” already exists.`);
      const cols = table.columns.map(c => (c === from ? op.to : c));
      return { table: { columns: cols, rows: table.rows.map(r => Object.fromEntries(table.columns.map(c => [c === from ? op.to : c, r[c] ?? '']))) }, ids, message: `Renamed ${from} to ${op.to}` };
    }
    case 'sort': {
      const col = requireColumn(table, op.column);
      const dir = op.desc ? -1 : 1;
      const order = table.rows.map((_, i) => i).sort((i, j) => {
        const x = table.rows[i][col] ?? '';
        const y = table.rows[j][col] ?? '';
        return dir * (isNumeric(x) && isNumeric(y) ? Number(x) - Number(y) : x.localeCompare(y));
      });
      // A mostly numeric column with blanks or text: those rows are not placed by value.
      const odd = table.rows.flatMap((r, i) => (isNumeric(r[col] ?? '') ? [] : ids[i]));
      const numeric = table.rows.length - odd.length;
      return {
        table: { columns: table.columns, rows: order.map(i => table.rows[i]) },
        ids: order.map(i => ids[i]),
        message: `Sorted by ${col} (${dir === 1 ? 'ascending' : 'descending'})`,
        ...(numeric > 0 && odd.length > 0 ? { notes: [{
          key: `sort:${col}`, kind: 'sort_values' as const, severity: 'warning' as const, column: col, rows: odd,
          message: `${count(odd.length, 'row')} ${odd.length === 1 ? 'has' : 'have'} a blank or non-numeric ${col}, so ${odd.length === 1 ? 'its' : 'their'} place in the order is not by value.`,
        }] } : {}),
      };
    }
    case 'limit': {
      const kept = Math.min(op.n, table.rows.length);
      return {
        table: { columns: table.columns, rows: table.rows.slice(0, op.n) },
        ids: ids.slice(0, op.n),
        message: `Kept the first ${count(kept, 'row')}`,
        ...(ids.length > op.n ? { dropped: ids.slice(op.n).map(g => ({ ids: g, reason: `after the first ${count(op.n, 'row')}` })) } : {}),
      };
    }
    case 'dedupe': return dedupeRows(table, ids, op);
    case 'group': return groupRows(table, ids, op);
    case 'join': return joinRows(table, ids, op, ctx);
    default:
      return {
        table, ids,
        message: `Skipped: ${op.why} Rows passed through unchanged. Try “select columns a, b”, “drop columns a”, “rename a to b”, “sort by a desc”, “limit 10”, “remove duplicates by a”, “group by a: count, average b” or “join other on a”.`,
        skipped: op.why,
      };
  }
}

/* ---------------- Sources ---------------- */

export function findDataset(datasets: DatasetRef[], file: string): DatasetRef | undefined {
  const want = [norm(file), norm(stripExt(file))];
  return datasets.find(d => [norm(d.name), norm(d.filename), norm(stripExt(d.filename))].some(k => want.includes(k)));
}

function recordsToTable(data: unknown): Table {
  let list: unknown = data;
  if (!Array.isArray(list) && list && typeof list === 'object') {
    list = Object.values(list).find(Array.isArray);
  }
  if (!Array.isArray(list) || !list.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
    throw new Error('The response is not a list of records (expected JSON like [{"a": 1}, {"a": 2}]).');
  }
  const columns: string[] = [];
  for (const rec of list as Record<string, unknown>[]) for (const k of Object.keys(rec)) if (!columns.includes(k)) columns.push(k);
  const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return { columns, rows: (list as Record<string, unknown>[]).map(rec => Object.fromEntries(columns.map(c => [c, text(rec[c])]))) };
}

/* ---------------- CSV export ---------------- */

export function toCsv(table: Table): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [table.columns.map(cell).join(','), ...table.rows.map(r => table.columns.map(c => cell(r[c] ?? '')).join(','))];
  return lines.join('\r\n') + '\r\n';
}

/* ---------------- Runner ---------------- */

/** "Score is blank" / "Score is “n/a”, not a number", for the rows a condition could not decide. */
function describeUndecided(list: Undecided[]): string {
  const seen = new Map<string, string>();
  for (const u of list) {
    if (!seen.has(u.column)) seen.set(u.column, u.value.trim() === '' ? `${u.column} is blank` : `${u.column} is “${u.value}”, not a number`);
  }
  return [...seen.values()].join(' and ');
}

const themOrIt = (n: number) => (n === 1 ? 'it' : 'them');

export async function runFlow(steps: Step[], ctx: RunContext, report: NodeReport, options: RunOptions = {}): Promise<RunResult> {
  let cur: Tracked = { table: EMPTY, ids: [] };
  const sources = new Set<string>();
  const trace: StepTrace[] = [];
  const exceptions: RunException[] = [];
  // The row register of the current source: one record per source row, all "kept" until a step removes the row.
  const ledger: { source: string; rows: RowRecord[] } = { source: '', rows: [] };
  let input: RunResult['input'];

  const raise = (step: Step, key: string, e: Omit<RunException, 'id' | 'stepId' | 'stepName'>) =>
    exceptions.push({ id: `${step.id}:${key}`, stepId: step.id, stepName: step.name, ...e });

  const mark = (id: number, status: 'excluded' | 'flagged', step: Step, reason: string) => {
    ledger.rows[id - 1] = { row: id, status, stepId: step.id, reason };
  };

  const startSource = (step: Step, label: string, table: Table): Tracked => {
    const unused = ledger.rows.filter(r => r.status === 'kept').length;
    if (ledger.source && unused) {
      raise(step, 'replaced', {
        kind: 'replaced_source', severity: 'warning', rows: [],
        message: `The ${count(unused, 'row')} from ${ledger.source} were not used: “${step.name}” reads ${label} instead.`,
      });
    }
    ledger.source = label;
    ledger.rows = table.rows.map((_, i) => ({ row: i + 1, status: 'kept' }));
    input = { name: label, columns: table.columns, rows: table.rows };
    return { table, ids: table.rows.map((_, i) => [i + 1]) };
  };

  for (const step of steps) {
    report(step.id, 'running', 'Running…');
    const rowsIn = cur.table.rows.length;
    const columnsIn = cur.table.columns;
    let skipped = false;
    try {
      let message = '';
      switch (step.type) {
        case 'INPUT':
          for (const id of cur.ids.flat()) mark(id, 'excluded', step, `“${step.name}” starts again with no data`);
          cur = { table: EMPTY, ids: [] };
          message = 'Started';
          break;

        case 'READ_CSV': {
          const file = step.config.file ?? '';
          const found = findDataset(await ctx.listDatasets(), file);
          if (!found) throw new Error(`No dataset matches “${file}”. Upload it under Knowledge base, Data, or pick one in this step's settings.`);
          cur = startSource(step, `“${found.name}”`, await ctx.loadDataset(found.id));
          sources.add(norm(found.name));
          message = `Read ${count(cur.table.rows.length, 'row')} from ${found.name}`;
          break;
        }

        case 'HTTP_REQUEST': {
          const method = (step.config.method ?? 'GET').toUpperCase();
          const url = step.config.url ?? '';
          if (method !== 'GET') throw new Error('Only GET requests are supported.');
          if (!/^https?:\/\//i.test(url)) throw new Error('The URL must start with http:// or https://.');
          if (options.dryRun) throw new PreviewStop(`This workflow fetches data from ${url}. The preview does not call web addresses; press Run to fetch it.`);
          cur = startSource(step, url, recordsToTable(await ctx.fetchJson(url)));
          message = `Fetched ${count(cur.table.rows.length, 'record')}`;
          break;
        }

        case 'FILTER': {
          const condition = step.config.condition ?? '';
          const check = checkCondition(condition, cur.table.columns);
          const plain = describeCondition(condition);
          const rows: Row[] = [];
          const ids: number[][] = [];
          // Rows whose outcome hinged on a blank or non-number, grouped by what happened, the column and the kind of value.
          const groups = new Map<string, { kept: boolean; column: string; blank: boolean; ids: number[] }>();
          let flagged = 0;
          cur.table.rows.forEach((row, i) => {
            const own = cur.ids[i];
            const o = check(row);
            if (o.keep) { rows.push(row); ids.push(own); }
            if (!o.decided) {
              const seen = new Set<string>();
              for (const u of o.undecided) {
                const blank = u.value.trim() === '';
                const key = `${o.keep ? 'kept' : 'left'}:${u.column}:${blank ? 'blank' : 'text'}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const g = groups.get(key) ?? { kept: o.keep, column: u.column, blank, ids: [] };
                g.ids.push(...own);
                groups.set(key, g);
              }
              if (!o.keep) {
                flagged++;
                for (const id of own) mark(id, 'flagged', step, `${describeUndecided(o.undecided)}, so “${plain}” could not be checked`);
              }
            } else if (!o.keep) {
              for (const id of own) mark(id, 'excluded', step, `does not match “${plain}”`);
            }
          });
          for (const [key, g] of groups) {
            const what = g.blank ? 'blank' : 'not a number';
            raise(step, key.replace(/^left/, 'undecided'), g.kept
              ? { kind: 'kept_undecided', severity: 'warning', column: g.column, rows: g.ids,
                  message: `${count(g.ids.length, 'row')} kept although ${g.column} is ${what}: “${plain}” could not really be checked on ${themOrIt(g.ids.length)}.` }
              : { kind: 'undecided_rows', severity: 'critical', column: g.column, rows: g.ids,
                  message: `${count(g.ids.length, 'row')} left out because ${g.column} is ${what}, so “${plain}” could not be checked on ${themOrIt(g.ids.length)}.` });
          }
          cur = { table: { columns: cur.table.columns, rows }, ids };
          message = `${rows.length} of ${rowsIn} rows matched${flagged ? `; ${count(flagged, 'row')} could not be checked` : ''}`;
          break;
        }

        case 'TRANSFORM': {
          const out = await transform(cur, step.config.operation ?? '', ctx);
          cur = { table: out.table, ids: out.ids };
          message = out.message;
          if (out.readDataset) sources.add(norm(out.readDataset));
          for (const d of out.dropped ?? []) for (const id of d.ids) mark(id, 'excluded', step, d.reason);
          if (out.skipped) {
            skipped = true;
            raise(step, 'skipped', {
              kind: 'skipped_step', severity: 'critical', rows: [],
              message: `“${step.name}” did not run: ${out.skipped} Rows passed through unchanged, so the result may not be what was asked for.`,
            });
          }
          for (const { key, ...note } of out.notes ?? []) raise(step, key, note);
          break;
        }

        case 'LLM':
          skipped = true;
          message = 'Skipped: LLM steps do not run yet. Rows passed through unchanged.';
          raise(step, 'skipped', {
            kind: 'skipped_step', severity: 'critical', rows: [],
            message: `“${step.name}” did not run: AI steps do not run yet. Rows passed through unchanged, so the result may not be what was asked for.`,
          });
          break;

        case 'DATABASE': {
          const name = (step.config.table ?? '').trim();
          if (!name) throw new Error('This step needs a table name.');
          const mode = saveModeOf(step.config);
          if (sources.has(norm(name))) throw new Error(`“${name}” is a dataset this workflow reads. Use a different table name so the source data is not overwritten.`);
          const existing = (await ctx.listDatasets()).find(d => norm(d.name) === norm(name));
          if (mode === 'replace' && existing?.origin === 'upload') {
            throw new Error(`“${name}” is data you uploaded, and replacing it would overwrite it. Use a different table name, or set mode to append to add rows to it.`);
          }
          const table = cur.table;
          const rows = count(table.rows.length, 'row');
          if (mode === 'append' && existing) {
            // Checked in a preview too, so the preview shows the same failure a run would.
            const target = await ctx.loadDataset(existing.id);
            if (!alignToColumns(target.columns, table)) throw new Error(columnMismatch(existing.name, target.columns, table));
            if (options.dryRun) {
              message = `Would add ${rows} to “${existing.name}”, which would then have ${count(target.rows.length + table.rows.length, 'row')} (nothing is saved in a preview)`;
              break;
            }
          } else if (options.dryRun) {
            message = mode === 'append'
              ? `Would create “${name}” with ${rows} (nothing is saved in a preview)`
              : `Would save ${rows} to “${name}” (nothing is saved in a preview)`;
            break;
          }
          const saved = await ctx.saveTable(name, table, mode);
          if (mode === 'replace') message = `Saved ${rows} to “${name}” in the Data library (replaces earlier contents)`;
          else if (saved && saved.created) message = `Created “${name}” in the Data library with ${rows}`;
          else message = `Added ${rows} to “${name}”${saved ? `, which now has ${count(saved.total, 'row')}` : ''}`;
          break;
        }

        case 'OUTPUT':
          message = `${count(cur.table.rows.length, 'row')} delivered`;
          break;

        default:
          throw new Error(`“${step.type}” cannot be run yet.`);
      }
      trace.push({ stepId: step.id, stepName: step.name, type: step.type, rowsIn, rowsOut: cur.table.rows.length, columnsIn, columnsOut: cur.table.columns, message, skipped });
      report(step.id, 'complete', message);
    } catch (e) {
      if (e instanceof PreviewStop) throw e;
      const text = e instanceof Error ? e.message : 'Step failed.';
      report(step.id, 'error', text);
      throw new Error(`“${step.name}” stopped the run. ${text}`);
    }
  }

  let register: RunRegister | null = null;
  if (ledger.source) {
    const tally = (s: RowRecord['status']) => ledger.rows.filter(r => r.status === s).length;
    const kept = tally('kept');
    const keptRows = new Set(ledger.rows.filter(r => r.status === 'kept').map(r => r.row));
    const balanced = kept + tally('excluded') + tally('flagged') === ledger.rows.length
      && (() => { const used = cur.ids.flat(); return used.length === kept && new Set(used).size === kept && used.every(id => keptRows.has(id)); })();
    register = { source: ledger.source, total: ledger.rows.length, kept, excluded: tally('excluded'), flagged: tally('flagged'), rows: ledger.rows, balanced };
    const last = steps[steps.length - 1];
    if (!balanced) {
      raise(last, 'unbalanced', {
        kind: 'unbalanced', severity: 'critical', rows: [],
        message: 'The row count does not add up: some rows cannot be accounted for. Do not rely on this result.',
      });
    }
    const inp = input as RunResult['input'];
    if (inp) {
      // Identical rows that both reach the result are counted twice by anything that counts or adds. A "remove
      // duplicates" step takes the copies out of the result, so only workflows that keep them are warned.
      const used = new Set(cur.ids.flat());
      const firstSeen = new Map<string, number>();
      const copies: number[] = [];
      inp.rows.forEach((row, i) => {
        if (!used.has(i + 1)) return;
        const key = inp.columns.map(c => (row[c] ?? '').trim().toLowerCase()).join('\u0000');
        if (firstSeen.has(key)) copies.push(i + 1); else firstSeen.set(key, i + 1);
      });
      if (copies.length) {
        raise(last, 'duplicates', {
          kind: 'duplicate_rows', severity: 'warning', rows: copies,
          message: `${count(copies.length, 'row')} ${plural(copies.length, 'is', 'are')} an exact copy of an earlier row and ${plural(copies.length, 'is', 'are')} counted again in the result. Add a “remove duplicates” step if the copies should not count.`,
        });
      }
    }
    if (cur.table.rows.length === 0) {
      raise(last, 'no-rows', { kind: 'no_rows', severity: 'warning', rows: [], message: 'The result has no rows.' });
    }
  }

  return {
    columns: cur.table.columns, rows: cur.table.rows,
    message: `Ran ${count(steps.length, 'step')}. The result has ${count(cur.table.rows.length, 'row')}.`,
    lineage: cur.ids, trace, exceptions, register, input,
  };
}
