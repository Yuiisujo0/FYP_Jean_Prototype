/**
 * Does the workflow do what the request SAYS? Checks that need no model and no reference answer, only the user's own
 * words, the workflow and the table it ran on. They exist because the failure analysis of the saved runs showed that
 * a small model's mistakes are consistent (three samples agree on the wrong answer) and usually of a few kinds:
 *
 *   unused_value    the request names a value in the data ("Monitor") that no filter uses: half the request was dropped;
 *   wrong_column    a value the request names is compared with the wrong column ("category == Delta Trading");
 *   invented_value  a filter compares with a value the request never mentions ("city == London");
 *   no_sort         the request asks for the highest, lowest, best... but nothing sorts the rows;
 *   mixed_logic     and / or are mixed without brackets (and is applied first, which is often not what was meant).
 *
 * Privacy: a finding quotes only words the user typed themselves, plus column names and the engine's own words. It never
 * contains a cell value the user did not already write in the request. Whether a word occurs in a column is stated
 * ("not found in that column"); what the column holds is not.
 *
 * These are hints that something may be wrong, not proof: the user's request is the only authority on what they meant.
 */
import type { Step } from '../types';
import { conditionComparisons, mixesAndOr } from './engine.ts';

export type GroundingKind = 'unused_value' | 'wrong_column' | 'invented_value' | 'no_sort' | 'mixed_logic';

export interface Finding {
  kind: GroundingKind;
  stepId?: string;
  /** Written for the model and for the person reading the agent's rounds. */
  text: string;
  /** The same finding as data, so a rule (src/lib/repair.ts) can act on it. */
  column?: string;
  /** unused_value: the value as written in the data. wrong_column / invented_value: the value the filter uses. */
  value?: string;
  /** wrong_column: the column that really holds the value. */
  other?: string;
  /** unused_value: the request says "not", "except", ... right before the value. */
  negated?: boolean;
  /** invented_value: the word does appear in the request, but is not a value of any column. */
  inRequest?: boolean;
}

const MAX_DISTINCT = 500;      // a column with more distinct text values is free text or an id, not a list of choices
const SMALL_COLUMN = 2;        // yes / no style columns: a value the request does not mention is normal there
const RANKING = /\b(most|least|highest|lowest|top|best|worst|cheapest|dearest|largest|smallest|biggest|longest|shortest|oldest|newest|youngest)\b/i;

const isNumeric = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));
const NEGATION = /(not|except|excluding|exclude|outside|without|never|other than)/;
/** True if "not", "except", ... comes within the three words before `value` in the (normalised) request. */
const negatedBefore = (asked: string, value: string): boolean => {
  const at = asked.indexOf(` ${value} `);
  return at > 0 && NEGATION.test(asked.slice(0, at).trim().split(' ').slice(-3).join(' '));
};
/** Lower case, punctuation turned to single spaces: "Delta-Trading," and "delta trading" compare equal. */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

interface Index {
  /** column → normalised text values (numbers are left out) */
  values: Map<string, Set<string>>;
  /** normalised value → how it is written in the data, for naming it in a message */
  written: Map<string, string>;
  distinct: Map<string, number>;
}

function indexTable(columns: string[], rows: Record<string, string>[]): Index {
  const values = new Map<string, Set<string>>();
  const written = new Map<string, string>();
  const distinct = new Map<string, number>();
  for (const c of columns) {
    const seen = new Set<string>();
    const all = new Set<string>();
    for (const r of rows) {
      const raw = (r[c] ?? '').trim();
      if (!raw) continue;
      all.add(raw.toLowerCase());
      if (all.size > MAX_DISTINCT) break;
      if (isNumeric(raw)) continue;
      const n = norm(raw);
      if (n) { seen.add(n); if (!written.has(n)) written.set(n, raw); }
    }
    distinct.set(c, all.size);
    if (all.size <= MAX_DISTINCT) values.set(c, seen);
  }
  return { values, written, distinct };
}

export function groundingFindings(request: string, steps: Step[], input: { columns: string[]; rows: Record<string, string>[] } | undefined): Finding[] {
  const out: Finding[] = [];
  const asked = ` ${norm(request)} `;
  const mentions = (n: string) => n !== '' && asked.includes(` ${n} `);
  const filters = steps.filter(s => s.type === 'FILTER');

  for (const f of filters) {
    if (mixesAndOr(f.config.condition ?? '')) {
      out.push({ kind: 'mixed_logic', stepId: f.id, value: f.config.condition, text: `The condition “${f.config.condition}” mixes and with or without brackets, and and is applied before or. Add brackets, or write several values of one column as in (a, b), so it means what the request says.` });
    }
  }

  if (!input) return out;   // nothing was read, so there is no data to compare the words with
  const index = indexTable(input.columns, input.rows);
  const comparisons = filters.flatMap(f => conditionComparisons(f.config.condition ?? '', input.columns).map(c => ({ ...c, stepId: f.id })));
  const used = comparisons.map(c => norm(c.literal)).filter(Boolean);

  // 1. A value of the data that the request names, but that no filter uses.
  const reported = new Set<string>();
  for (const [column, vals] of index.values) {
    for (const v of vals) {
      if (v.length < 3 || reported.has(v) || !mentions(v)) continue;   // very short values ("no") match too many words
      if (used.some(u => u === v || (u.length >= 3 && (u.includes(v) || v.includes(u))))) continue;
      reported.add(v);
      out.push({ kind: 'unused_value', column, value: index.written.get(v) ?? v, negated: negatedBefore(asked, v), text: `Your request mentions “${index.written.get(v) ?? v}”, which is a value in the column ${column}, but no filter uses it.` });
    }
  }

  // 2 and 3. A filter value in the wrong column, or one the request never mentions.
  const checked = new Set<string>();
  for (const c of comparisons) {
    if (!['==', '=', '!=', 'in', 'not in'].includes(c.op) || isNumeric(c.literal)) continue;
    const n = norm(c.literal);
    const key = `${c.column}|${n}`;
    if (!n || checked.has(key)) continue;
    checked.add(key);
    const inColumn = index.values.get(c.column)?.has(n) ?? false;
    if (mentions(n)) {
      if (inColumn) continue;
      const other = [...index.values].find(([col, vals]) => col !== c.column && vals.has(n))?.[0];
      if (other) out.push({ kind: 'wrong_column', stepId: c.stepId, column: c.column, value: c.literal, other, text: `The filter compares ${c.column} with “${c.literal}”, but “${c.literal}” is a value in the column ${other}, not in ${c.column}.` });
      // The word is in the request but is no value of any column (a noun such as "staff" taken for a department). Reported, not
      // repaired by rule: the user may really be asking for a value that is not there.
      else out.push({ kind: 'invented_value', stepId: c.stepId, column: c.column, value: c.literal, inRequest: true, text: `The filter compares ${c.column} with “${c.literal}”, which is not a value found in that column (or in any other).` });
    } else if (!inColumn) {
      out.push({ kind: 'invented_value', stepId: c.stepId, column: c.column, value: c.literal, text: `The filter compares ${c.column} with “${c.literal}”, which your request does not mention and which is not found in that column.` });
    } else if ((index.distinct.get(c.column) ?? 0) > SMALL_COLUMN) {
      out.push({ kind: 'invented_value', stepId: c.stepId, column: c.column, value: c.literal, text: `The filter compares ${c.column} with “${c.literal}”, which your request does not mention.` });
    }
  }

  // 4. Highest / lowest / best asked for, but nothing sorts.
  // "at least" and "at most" are limits, not rankings; a group or summarise step answers "the lowest / largest per group".
  const ranking = RANKING.exec(request.replace(/\bat (least|most)\b/gi, ' '));
  const sorts = steps.some(s => s.type === 'TRANSFORM' && /^\s*(sort|group|summari[sz]e|aggregate)\b/i.test(s.config.operation ?? ''));
  if (ranking && !sorts) {
    out.push({ kind: 'no_sort', text: `Your request says “${ranking[0]}”, but no step sorts the rows. A limit alone keeps the first rows in file order. Sort by the column the request is about, then limit.` });
  }
  return out;
}
