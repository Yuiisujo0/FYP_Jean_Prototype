/**
 * Rule-based repairs: the agent's own tools, tried BEFORE asking the model again.
 *
 * A small model that is asked "this looks wrong, fix it" often changes nothing useful. Most of what the grounding checks
 * find (src/lib/grounding.ts) has a mechanical remedy, because the finding already says what is wrong:
 *
 *   wrong_column    the value is in another column  → compare that column instead;
 *   invented_value  the filter uses a value the request never mentions → take that comparison out;
 *   unused_value    the request names a value no filter uses → add `column == value` (or `!=` after "not", `in (...)` for several);
 *   mixed_logic     or-terms on one column next to and → put brackets round the or-terms;
 *   no_sort         "highest / lowest ..." with no sort → add `sort by <the column the request names>` (before any limit);
 *   wrong_dataset   the request shares words with exactly one other uploaded dataset → read that one instead;
 *   missing_join    the request names a column only another dataset has → join that dataset on the one column both share,
 *                   or read it instead when nothing needs a column only the current dataset has;
 *   lost_not        "not X" in the request, but the filter keeps X → == becomes !=, in becomes not in.
 *
 * A plan that stops on a column its table does not have gets no findings, so repairRunError handles it the same way.
 *
 * unused_number ("under 70" dropped) has no rule: which column and which comparison the number belongs to is the model's call.
 *
 * Anything a rule cannot decide (which column to sort by is not named, an or between different columns) is left to the
 * model. Every repair is reported in plain words, shown to the user in the agent's rounds, and the user still reviews and
 * approves the final workflow. Nothing here reads or sends a cell value: a repair is built from the request, the workflow
 * and the column names (the value written is one the user typed, as it appears in the data).
 */
import type { Step } from '../types';
import { tokenize } from './engine.ts';
import type { DatasetOutline, Finding } from './grounding.ts';
import { makeId } from './id.ts';

export interface Repaired {
  steps: Step[];
  /** One plain sentence per change. */
  notes: string[];
}

const SYMBOL = new Set(['<', '<=', '>', '>=', '==', '=', '!=']);
const isConn = (t: string | undefined): t is string => t !== undefined && ['and', 'or'].includes(t.toLowerCase());
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const unquote = (t: string) => (t[0] === '"' || t[0] === "'" ? t.slice(1, -1) : t);
const quote = (v: string) => (/[\s,()<>=!]/.test(v) ? `"${v}"` : v);
const tidy = (tokens: string[]) => tokens.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ,/g, ',');
const hasOr = (tokens: string[]) => tokens.some(t => t.toLowerCase() === 'or');

/** The tokens of a written value starting at `i`: one quoted token, or bare words up to a connector, bracket or comma. */
function valueAt(tokens: string[], i: number): { text: string; end: number } | null {
  const t = tokens[i];
  if (t === undefined || t === '(' || t === ')' || t === ',' || SYMBOL.has(t)) return null;
  if (t[0] === '"' || t[0] === "'") return { text: unquote(t), end: i + 1 };
  let j = i + 1;
  while (tokens[j] !== undefined && !isConn(tokens[j]) && ![')', '(', ','].includes(tokens[j]) && !SYMBOL.has(tokens[j])) j++;
  return { text: tokens.slice(i, j).join(' '), end: j };
}

/** Removes empty brackets and dangling and / or left after a deletion. */
function cleanUp(tokens: string[]): string[] {
  let t = [...tokens];
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i + 1 < t.length; i++) {
      if (t[i] === '(' && t[i + 1] === ')') { t.splice(i, 2); changed = true; break; }
      if (isConn(t[i]) && (isConn(t[i + 1]) || t[i + 1] === ')')) { t.splice(i, 1); changed = true; break; }
      if (t[i] === '(' && isConn(t[i + 1])) { t.splice(i + 1, 1); changed = true; break; }
    }
    if (t.length && isConn(t[0])) { t = t.slice(1); changed = true; }
    if (t.length && isConn(t[t.length - 1])) { t = t.slice(0, -1); changed = true; }
  }
  return t;
}

/** The condition without the comparison `column == value`; '' when nothing is left; null if that comparison is not found. */
function withoutComparison(condition: string, column: string, value: string): string | null {
  let tokens: string[];
  try { tokens = tokenize(condition); } catch { return null; }
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (squash(tokens[i]) !== squash(column) || !['==', '=', '!='].includes(tokens[i + 1])) continue;
    const v = valueAt(tokens, i + 2);
    if (!v || v.text.toLowerCase() !== value.toLowerCase()) continue;
    const next = [...tokens];
    // take the comparison and one neighbouring connector out
    if (isConn(next[i - 1])) next.splice(i - 1, v.end - (i - 1));
    else if (isConn(next[v.end])) next.splice(i, v.end + 1 - i);
    else next.splice(i, v.end - i);
    return tidy(cleanUp(next));
  }
  return null;
}

/** The condition with `column` swapped for `other` in the comparison against `value`. */
function withColumnSwapped(condition: string, column: string, value: string, other: string): string | null {
  let tokens: string[];
  try { tokens = tokenize(condition); } catch { return null; }
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (squash(tokens[i]) !== squash(column) || !['==', '=', '!='].includes(tokens[i + 1])) continue;
    const v = valueAt(tokens, i + 2);
    if (v && v.text.toLowerCase() === value.toLowerCase()) { const next = [...tokens]; next[i] = other; return tidy(next); }
  }
  return null;
}

/** The condition with the comparison of `column` against `value` negated: == becomes !=, in (...) becomes not in (...). */
function withComparisonNegated(condition: string, column: string, value: string): string | null {
  let tokens: string[];
  try { tokens = tokenize(condition); } catch { return null; }
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (squash(tokens[i]) !== squash(column)) continue;
    if (['==', '='].includes(tokens[i + 1])) {
      const v = valueAt(tokens, i + 2);
      if (v && v.text.toLowerCase() === value.toLowerCase()) { const next = [...tokens]; next[i + 1] = '!='; return tidy(next); }
    }
    if (tokens[i + 1].toLowerCase() === 'in' && tokens[i - 1]?.toLowerCase() !== 'not' && tokens[i + 2] === '(') {
      const close = tokens.indexOf(')', i + 2);
      if (close > 0 && tokens.slice(i + 3, close).some(t => unquote(t).toLowerCase() === value.toLowerCase())) {
        const next = [...tokens]; next[i + 1] = 'not in'; return tidy(next);
      }
    }
  }
  return null;
}

/** Splits at the top-level and / or. `x between 1 and 5` keeps its own `and`. */
function splitTerms(tokens: string[]): { terms: string[][]; conns: string[] } {
  const terms: string[][] = [];
  const conns: string[] = [];
  let cur: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '(') depth++;
    if (t === ')') depth--;
    if (depth === 0 && t.toLowerCase() === 'between') { cur.push(...tokens.slice(i, i + 4)); i += 3; continue; }
    if (depth === 0 && isConn(t)) { terms.push(cur); conns.push(t.toLowerCase()); cur = []; continue; }
    cur.push(t);
  }
  terms.push(cur);
  return { terms, conns };
}

/** `a == 1 or a == 2 and b > 3` → `(a == 1 or a == 2) and b > 3`: brackets round one run of or-terms on the same column. */
function bracketOrRun(condition: string): string | null {
  let tokens: string[];
  try { tokens = tokenize(condition); } catch { return null; }
  const { terms, conns } = splitTerms(tokens);
  if (!conns.includes('and') || !conns.includes('or')) return null;
  const runs: [number, number][] = [];
  for (let k = 0; k < terms.length;) {
    let end = k;
    while (end < conns.length && conns[end] === 'or' && terms[end + 1][0] !== '(' && squash(terms[end + 1][0]) === squash(terms[k][0]) && terms[k][0] !== '(') end++;
    if (end > k) runs.push([k, end]);
    k = end + 1;
  }
  if (runs.length !== 1) return null;
  const [from, to] = runs[0];
  if (from === 0 && to === terms.length - 1) return null;
  const out: string[] = [];
  terms.forEach((term, k) => {
    if (k > 0) out.push(conns[k - 1]);
    if (k === from) out.push('(');
    out.push(...term);
    if (k === to) out.push(')');
  });
  return tidy(out);
}

const DESC = /\b(most|highest|top|best|largest|biggest|longest|greatest)\b/i;
const ASC = /\b(least|lowest|worst|cheapest|smallest|shortest)\b/i;

const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** The one column the request names (by its name, underscores read as spaces), if there is exactly one. */
function namedColumn(request: string, columns: string[]): string | null {
  const asked = words(request);
  const hits = columns.filter(c => asked.includes(words(c)));
  return hits.length === 1 ? hits[0] : null;
}

const mkStep = (type: string, config: Record<string, string>, name: string): Step => ({ id: makeId(), type, name, description: '', config });

/**
 * Whether the request or the plan uses a column that only `own` has, so the other table has to come in beside it, not
 * replace it. One word of a column name is enough ("every trainee" for trainee_id): dropping a table that was needed is
 * the worse mistake, because the run still looks clean.
 */
function needsOwnColumn(request: string, steps: Step[], own: string[], other: string[]): boolean {
  const theirs = new Set(other.map(squash));
  const used = words(`${request} ${steps.filter(s => s.type !== 'READ_CSV').flatMap(s => Object.values(s.config)).join(' ')}`);
  return own.some(c => !theirs.has(squash(c)) && words(c).trim().split(' ').some(w => w.length > 2 && used.includes(words(w))));
}

/** Joins `dataset` right after the data is read, so every later step can use `column`. */
function addJoin(work: Step[], notes: string[], dataset: string, on: string, column: string) {
  const op = `join ${dataset} on ${on}`;
  const at = work.findIndex(s => s.type === 'READ_CSV' || s.type === 'READ_FILE' || s.type === 'INPUT') + 1;
  work.splice(at, 0, mkStep('TRANSFORM', { operation: op }, 'Transform data'));
  notes.push(`Added “${op}”, because your request mentions ${column}, which only ${dataset} has.`);
  // A later "select columns ..." that leaves the joined column out would throw it away again.
  for (const s of work.slice(at + 1)) {
    const m = s.type === 'TRANSFORM' ? /^(\s*select(?:\s+columns)?\s+)(.+)$/i.exec(s.config.operation ?? '') : null;
    if (!m || m[2].split(',').some(c => squash(c) === squash(column))) continue;
    s.config.operation = `${m[1]}${m[2].trim()}, ${column}`;
    notes.push(`Kept ${column} in “${s.config.operation.trim()}”.`);
  }
}

const sameTable = (name: string, file: string) => squash(name) === squash(file.replace(/\.[a-z0-9]+$/i, ''));

/**
 * The run stopped on a column the table does not have. When the request names that column and exactly one uploaded table
 * has it, the plan has the wrong table, or none: read that table, or join it if the current one is needed as well.
 * Anything less sure stays with the model, because a wrong table gives a clean run on the wrong rows.
 */
export function repairRunError(request: string, steps: Step[], error: string, datasets: DatasetOutline[] | undefined): Repaired | null {
  const column = /There is no column “([^”]+)”/.exec(error)?.[1];
  const reads = steps.filter(s => s.type === 'READ_CSV');
  if (!column || !datasets?.length || reads.length > 1 || !words(request).includes(words(column))) return null;
  const holders = datasets.filter(d => d.columns.some(c => squash(c) === squash(column)));
  if (holders.length !== 1) return null;
  const [holder] = holders;
  const work = steps.map(s => ({ ...s, config: { ...s.config } }));
  if (!reads.length) {
    work.unshift(mkStep('READ_CSV', { file: holder.name, delimiter: ',' }, 'Read data'));
    return { steps: work, notes: [`Read “${holder.name}” first, because the workflow read no data and that is the uploaded dataset with ${column}.`] };
  }
  const read = work.find(s => s.type === 'READ_CSV')!;
  const current = datasets.find(d => sameTable(d.name, read.config.file ?? ''));
  if (!current || current === holder) return null;
  const notes: string[] = [];
  if (!needsOwnColumn(request, work, current.columns, holder.columns)) {
    read.config.file = holder.name;
    return { steps: work, notes: [`Read “${holder.name}” instead of “${current.name}”, because that is the uploaded dataset with ${column}.`] };
  }
  const shared = current.columns.filter(c => holder.columns.some(h => squash(h) === squash(c)));
  if (shared.length !== 1) return null;
  addJoin(work, notes, holder.name, shared[0], column);
  return { steps: work, notes };
}

export function repairByRules(request: string, steps: Step[], findings: Finding[], input: { columns: string[] } | undefined, datasets: DatasetOutline[] = []): Repaired | null {
  if (!findings.length || !input) return null;
  let work = steps.map(s => ({ ...s, config: { ...s.config } }));
  const notes: string[] = [];

  const editFilter = (stepId: string | undefined, change: (condition: string) => string | null, note: string) => {
    const targets = stepId ? work.filter(s => s.id === stepId) : work.filter(s => s.type === 'FILTER');
    for (const s of targets) {
      const next = change(s.config.condition ?? '');
      if (next === null) continue;
      if (next === '') { work = work.filter(w => w.id !== s.id); notes.push(`${note} The filter had nothing else in it, so the step was removed.`); }
      else { s.config.condition = next; notes.push(note); }
      return;
    }
  };

  // The request is about other data: read the one uploaded dataset that matches it. The filters were written for the wrong
  // table, so the model gets the next turn to rewrite them (the run now shows what the right table looks like).
  for (const f of findings.filter(x => x.kind === 'wrong_dataset' && x.other)) {
    const read = work.find(s => s.type === 'READ_CSV' && (s.config.file ?? '') === (f.dataset ?? ''));
    if (read) { read.config.file = f.other!; notes.push(`Read “${f.other}” instead of “${f.dataset ?? 'the dataset it was reading'}”, because that is the uploaded dataset your request talks about.`); }
  }
  // A column only another dataset has: bring that dataset in, or read it instead if nothing needs the current one.
  const joins = findings.filter(x => x.kind === 'missing_join' && x.dataset && x.other);
  if (joins.length === 1) {
    const [f] = joins;
    const holder = datasets.find(d => d.name === f.dataset);
    const read = work.find(s => s.type === 'READ_CSV');
    if (holder && read && !needsOwnColumn(request, work, input.columns, holder.columns)) {
      notes.push(`Read “${holder.name}” instead of “${read.config.file}”, because your request mentions ${f.column}, which only ${holder.name} has.`);
      read.config.file = holder.name;
    } else addJoin(work, notes, f.dataset!, f.other!, f.column!);
  }
  const negated = new Set<string>();   // one `in (a, b)` list is negated once, though each of its values was reported
  for (const f of findings.filter(x => x.kind === 'lost_not' && x.column && x.value)) {
    if (negated.has(`${f.stepId}|${f.column}`)) continue;
    negated.add(`${f.stepId}|${f.column}`);
    editFilter(f.stepId, c => withComparisonNegated(c, f.column!, f.value!), `Changed the filter to leave out ${f.column} “${f.value}”, because your request says not “${f.value}”.`);
  }
  for (const f of findings.filter(x => x.kind === 'wrong_column' && x.column && x.value && x.other)) {
    editFilter(f.stepId, c => withColumnSwapped(c, f.column!, f.value!, f.other!), `Compared “${f.value}” with ${f.other} instead of ${f.column}, because that is the column that holds it.`);
  }
  for (const f of findings.filter(x => x.kind === 'invented_value' && x.column && x.value && !x.inRequest)) {
    editFilter(f.stepId, c => withoutComparison(c, f.column!, f.value!), `Removed ${f.column} compared with “${f.value}”: your request never mentions it.`);
  }

  // Values the request names that no filter uses: one added comparison per column.
  const unused = findings.filter(x => x.kind === 'unused_value' && x.column && x.value);
  const byColumn = new Map<string, Finding[]>();
  for (const f of unused) byColumn.set(f.column!, [...(byColumn.get(f.column!) ?? []), f]);
  const additions: { text: string; note: string }[] = [];
  for (const [column, list] of byColumn) {
    const positive = list.filter(f => !f.negated);
    const negative = list.filter(f => f.negated);
    if (positive.length > 1) additions.push({ text: `${column} in (${positive.map(f => quote(f.value!)).join(', ')})`, note: `Added the filter ${column} in (${positive.map(f => f.value).join(', ')}), because your request names those values.` });
    else if (positive.length === 1) additions.push({ text: `${column} == ${quote(positive[0].value!)}`, note: `Added the filter ${column} == ${positive[0].value}, because your request names “${positive[0].value}”.` });
    for (const f of negative) additions.push({ text: `${column} != ${quote(f.value!)}`, note: `Added the filter ${column} != ${f.value}, because your request says not “${f.value}”.` });
  }
  if (additions.length) {
    const add = additions.map(a => a.text).join(' and ');
    const filter = work.find(s => s.type === 'FILTER');
    if (filter) {
      const existing = filter.config.condition ?? '';
      let tokens: string[] = [];
      try { tokens = tokenize(existing); } catch { /* left as text */ }
      filter.config.condition = existing.trim() ? `${hasOr(tokens) ? `(${existing})` : existing} and ${add}` : add;
    } else {
      const at = work.findIndex(s => s.type === 'READ_CSV' || s.type === 'READ_FILE' || s.type === 'INPUT') + 1;
      work.splice(at, 0, mkStep('FILTER', { condition: add }, 'Filter records'));
    }
    notes.push(...additions.map(a => a.note));
  }

  for (const f of findings.filter(x => x.kind === 'mixed_logic')) {
    editFilter(f.stepId, c => bracketOrRun(c), 'Put brackets round the or-terms on one column, so “and” no longer binds to just the last one.');
  }

  if (findings.some(x => x.kind === 'no_sort')) {
    const column = namedColumn(request, input.columns);
    const desc = DESC.test(request), asc = ASC.test(request);
    if (column && desc !== asc) {
      const op = `sort by ${column}${desc ? ' desc' : ''}`;
      const limitAt = work.findIndex(s => s.type === 'TRANSFORM' && /^\s*(limit|top|first)\b/i.test(s.config.operation ?? ''));
      const at = limitAt >= 0 ? limitAt : work.findIndex(s => s.type === 'OUTPUT');
      work.splice(at >= 0 ? at : work.length, 0, mkStep('TRANSFORM', { operation: op }, 'Transform data'));
      notes.push(`Added “${op}”, because your request asks for the ${desc ? 'highest' : 'lowest'} by ${column}.`);
    }
  }

  return notes.length ? { steps: work, notes } : null;
}
