/**
 * BM25 retrieval over the pattern library. A port of backend/app/retrieval.py; the golden test in tests/pipeline.test.ts
 * checks that both choose the same examples for the same request.
 */
import type { PatternContract, RetrievedEntry } from './types.ts';

const STOP = new Set('the a an and or of to in for with from then that this is are it its be on as by at into each me my all just only'.split(' '));
const KEY_PARAM: Record<string, string> = {
  READ_CSV: 'file', FILTER: 'condition', TRANSFORM: 'operation', DATABASE: 'table', HTTP_REQUEST: 'url',
  LLM: 'task', OUTPUT: 'format', READ_FILE: 'file', INPUT: 'source',
};

export const tokens = (text: string): string[] => (text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter(w => !STOP.has(w));

export function describeSteps(steps: PatternContract['steps']): string {
  return steps.map(s => {
    const value = s.config[KEY_PARAM[s.type] ?? ''] ?? '';
    return value ? `${s.type}(${value})` : s.type;
  }).join(' > ');
}

class Bm25 {
  private idf = new Map<string, number>();
  private avg: number;
  private docs: string[][];
  private k1 = 1.5;
  private b = 0.75;
  constructor(docs: string[][]) {
    this.docs = docs;
    this.avg = docs.length ? docs.reduce((n, d) => n + d.length, 0) / docs.length : 0;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    for (const [t, f] of df) this.idf.set(t, Math.log(1 + (docs.length - f + 0.5) / (f + 0.5)));
  }
  score(query: string[], i: number): number {
    const doc = this.docs[i];
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    let total = 0;
    for (const q of new Set(query)) {
      const f = tf.get(q);
      if (f) total += this.idf.get(q)! * f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + this.b * doc.length / (this.avg || 1)));
    }
    return total;
  }
}

const indexes = new WeakMap<PatternContract[], Bm25>();

export function retrievePatterns(prompt: string, patterns: PatternContract[], limit = 2): RetrievedEntry[] {
  if (!patterns.length) return [];
  let index = indexes.get(patterns);
  if (!index) {
    index = new Bm25(patterns.map(p => tokens(`${p.title} ${p.request}`)));
    indexes.set(patterns, index);
  }
  const query = tokens(prompt);
  // Python sorts (score, index) pairs in reverse, so equal scores are ordered by higher index first.
  const ranked = patterns.map((_, i) => ({ score: index!.score(query, i), i })).sort((a, b) => b.score - a.score || b.i - a.i);
  const out: RetrievedEntry[] = [];
  for (const { score, i } of ranked.slice(0, limit)) {
    if (score <= 0) break;
    const p = patterns[i];
    out.push({ id: p.id, title: p.title, detail: `For example "${p.request}" is ${describeSteps(p.steps)}.` });
  }
  return out;
}
