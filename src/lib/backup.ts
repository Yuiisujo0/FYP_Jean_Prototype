/**
 * The workspace backup file: profile, workflows, imported knowledge and (since version 2) the data library.
 * Version 1 files have no `datasets`; restoring one leaves the user's datasets alone.
 * Pure functions, tested in Node (tests/backup.test.ts).
 */
import type { Dataset, Flow, KnowledgeEntry } from '../types';

export const BACKUP_FORMAT = 'jwork.workspace';
export const BACKUP_VERSION = 2;

export interface BackupDataset {
  name: string;
  filename: string;
  columns: string[];
  rows: Record<string, string>[];
  /** 'result' for a table a workflow saved; anything else is read as an upload */
  origin?: 'upload' | 'result';
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  profile: unknown;
  flows: Flow[];
  knowledge: KnowledgeEntry[];
  datasets: BackupDataset[];
}

export function buildBackup(parts: { profile: unknown; flows: Flow[]; knowledge: KnowledgeEntry[]; datasets: Dataset[] }, now = new Date()): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    profile: parts.profile,
    flows: parts.flows,
    knowledge: parts.knowledge,
    // ids and timestamps belong to this browser's database, so they are not part of the file
    datasets: parts.datasets.map(({ name, filename, columns, rows, origin }) => ({ name, filename, columns, rows, ...(origin ? { origin } : {}) })),
  };
}

export interface ParsedBackup {
  profile: unknown;
  flows: unknown[];
  knowledge: KnowledgeEntry[];
  /** null for a version 1 file (no datasets recorded), which must not touch the library */
  datasets: BackupDataset[] | null;
  /** datasets in the file that were damaged and cannot be restored */
  skippedDatasets: number;
}

/** Checks a dataset from a file; returns null if it cannot be used. Every cell becomes text, as in the library. */
function cleanDataset(x: unknown): BackupDataset | null {
  const d = x as Partial<BackupDataset> | null;
  if (!d || typeof d.name !== 'string' || !d.name.trim()) return null;
  if (!Array.isArray(d.columns) || !d.columns.every(c => typeof c === 'string') || !Array.isArray(d.rows)) return null;
  const columns = d.columns as string[];
  const rows = d.rows.map(r => {
    const row = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return Object.fromEntries(columns.map(c => [c, row[c] == null ? '' : String(row[c])]));
  });
  return { name: d.name.trim(), filename: typeof d.filename === 'string' && d.filename ? d.filename : `${d.name.trim()}.csv`, columns, rows, ...(d.origin === 'result' ? { origin: 'result' as const } : {}) };
}

/** Reads a parsed JSON value as a backup. Throws a readable message if it is not one. */
export function parseBackup(raw: unknown): ParsedBackup {
  const b = raw as { format?: unknown; profile?: unknown; flows?: unknown; knowledge?: unknown; datasets?: unknown } | null;
  if (b?.format !== BACKUP_FORMAT || !Array.isArray(b.flows)) throw new Error('This is not a jwork backup file.');
  let datasets: BackupDataset[] | null = null;
  let skippedDatasets = 0;
  if (Array.isArray(b.datasets)) {
    datasets = [];
    for (const x of b.datasets) {
      const clean = cleanDataset(x);
      if (clean) datasets.push(clean); else skippedDatasets++;
    }
  }
  return {
    profile: b.profile,
    flows: b.flows,
    knowledge: Array.isArray(b.knowledge) ? (b.knowledge as KnowledgeEntry[]) : [],
    datasets,
    skippedDatasets,
  };
}

/** One sentence saying what a restore did, including what it did not touch. */
export function restoreMessage(workflows: number, parsed: Pick<ParsedBackup, 'datasets' | 'skippedDatasets'>, restoredDatasets: number): string {
  const wf = `${workflows} ${workflows === 1 ? 'workflow' : 'workflows'}`;
  if (parsed.datasets === null) return `Restored ${wf}. This backup was made before datasets were included, so your datasets were not changed.`;
  const ds = `${restoredDatasets} ${restoredDatasets === 1 ? 'dataset' : 'datasets'}`;
  const skipped = parsed.skippedDatasets ? ` ${parsed.skippedDatasets} damaged ${parsed.skippedDatasets === 1 ? 'dataset was' : 'datasets were'} skipped.` : '';
  return `Restored ${wf} and ${ds}.${skipped}`;
}
