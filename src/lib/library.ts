/**
 * The user's data library, kept in this browser (IndexedDB). Nothing is uploaded anywhere: files are read here, stored
 * here, and only dataset names and column names (never rows) are ever sent to the AI.
 *
 * `createLibrary` holds the logic (matching an upload to existing data, replace / add rows / new) over a small storage
 * interface, so it is tested in Node with an in-memory store; `idbStore` is the real browser store. The logic is a port
 * of backend/app/routes/datasets.py and the tests in tests/library.test.ts mirror the backend's.
 */
import type { Dataset, DatasetInfo } from '../types';
import type { BackupDataset } from './backup.ts';
import { requestPersistence } from './persist.ts';
import { alignToColumns, columnMismatch, type SaveMode, type SaveResult } from './engine.ts';
import { norm, parseUpload, stripExt, type Parsed, type Row, type Table } from './tables.ts';

export type UploadMode = 'replace' | 'append' | 'new';

/** A file read in the browser, ready to be inspected or saved. */
export interface ParsedFile extends Parsed { filename: string }

export interface DatasetMatch {
  id: number;
  name: string;
  rowCount: number;
  sameName: boolean;
  sameColumns: boolean;
}

export interface UploadInfo {
  suggestedName: string;
  columns: string[];
  rowCount: number;
  sheet: string | null;
  preview: Row[];
  matches: DatasetMatch[];
}

/** A dataset as the model sees it: a name and column names, never rows. */
export interface DatasetBrief { name: string; columns: string[] }

/** Where datasets are kept. Info and rows are separate so listing never has to load every row. */
export interface DatasetStore {
  list(): Promise<DatasetInfo[]>;
  get(id: number): Promise<Dataset | undefined>;
  /** Insert (no id) or update (id). Returns the id. */
  put(info: Omit<DatasetInfo, 'id'> & { id?: number }, rows: Row[]): Promise<number>;
  remove(id: number): Promise<boolean>;
}

/* ---------------- the logic ---------------- */

export function createLibrary(store: DatasetStore, now: () => number = Date.now) {
  const list = async () => (await store.list()).sort((a, b) => b.updatedAt - a.updatedAt);

  async function save(name: string, filename: string, columns: string[], rows: Row[], origin: 'upload' | 'result' = 'upload'): Promise<Dataset> {
    const existing = (await store.list()).find(d => d.name === name);   // same name replaces the data and keeps the id
    const t = now();
    const id = await store.put({ id: existing?.id, name, filename, columns, rowCount: rows.length, createdAt: existing?.createdAt ?? t, updatedAt: t, origin }, rows);
    return (await store.get(id))!;
  }

  /** Adds rows to a stored dataset, which keeps its own column names, origin and id. */
  async function addRows(target: Dataset, added: Row[]): Promise<Dataset> {
    await store.put({ id: target.id, name: target.name, filename: target.filename, columns: target.columns, rowCount: target.rows.length + added.length, createdAt: target.createdAt, updatedAt: now(), origin: target.origin }, [...target.rows, ...added]);
    return (await store.get(target.id))!;
  }

  async function findMatches(suggested: string, filename: string, columns: string[]): Promise<DatasetMatch[]> {
    const wantNames = new Set([norm(suggested), norm(stripExt(filename))].filter(Boolean));
    const wantCols = columns.map(norm).sort().join('\u0000');
    const out: DatasetMatch[] = [];
    for (const d of await list()) {
      if (d.origin === 'result') continue;   // a file is never offered as an update to a table a workflow saved
      const sameName = wantNames.has(norm(d.name)) || wantNames.has(norm(stripExt(d.filename)));
      const sameColumns = d.columns.map(norm).sort().join('\u0000') === wantCols;
      if (sameName || sameColumns) out.push({ id: d.id, name: d.name, rowCount: d.rowCount, sameName, sameColumns });
    }
    return out;
  }

  /** Reports which existing datasets a file might update, without saving anything. */
  async function inspect(file: ParsedFile): Promise<UploadInfo> {
    const suggestedName = stripExt(file.filename) || 'dataset';
    return {
      suggestedName, columns: file.columns, rowCount: file.rows.length, sheet: file.sheet, preview: file.rows.slice(0, 5),
      matches: await findMatches(suggestedName, file.filename, file.columns),
    };
  }

  async function upload(file: ParsedFile, options: { name?: string; mode?: UploadMode; targetId?: number } = {}): Promise<Dataset> {
    const mode = options.mode ?? 'replace';
    if (mode === 'append') {
      const target = options.targetId === undefined ? undefined : await store.get(options.targetId);
      if (!target) throw new Error('The dataset to add rows to was not found.');
      const added = alignToColumns(target.columns, file);
      if (!added) throw new Error(`The columns do not match “${target.name}”. It has: ${target.columns.join(', ')}. The file has: ${file.columns.join(', ')}.`);
      return addRows(target, added);
    }
    const name = (options.name ?? '').trim();
    if (!name) throw new Error('Give the dataset a name.');
    if (mode === 'new' && (await store.list()).some(d => norm(d.name) === norm(name))) {
      throw new Error(`A dataset named “${name}” already exists. Choose another name, or replace it.`);
    }
    return save(name, file.filename, file.columns, file.rows);
  }

  return {
    list,
    get: (id: number) => store.get(id),
    remove: (id: number) => store.remove(id),
    inspect, upload,
    /** Every dataset with its rows, for a backup. */
    async exportAll(): Promise<Dataset[]> {
      const out: Dataset[] = [];
      for (const info of await store.list()) {
        const d = await store.get(info.id);
        if (d) out.push(d);
      }
      return out;
    },
    /** Puts datasets from a backup back: a dataset with the same name is replaced, any other dataset is left alone. */
    async importAll(items: BackupDataset[]): Promise<number> {
      for (const d of items) await save(d.name, d.filename, d.columns, d.rows, d.origin ?? 'upload');
      return items.length;
    },
    /** Saves a workflow's result table (a Database step). Replaces earlier contents of the same name. */
    saveTable(name: string, table: Table): Promise<Dataset> {
      if (!table.columns.length) throw new Error('The result has no columns, so there is nothing to save.');
      return save(name.trim(), `${name.trim()}.csv`, table.columns, table.rows, 'result');
    },
    /**
     * A Database step: replace the table, or add the rows to it (creating it the first time). Adding needs the same
     * columns as the table, with the spelling of the headers ignored; otherwise nothing is changed.
     */
    async saveResult(name: string, table: Table, mode: SaveMode): Promise<SaveResult> {
      if (!table.columns.length) throw new Error('The result has no columns, so there is nothing to save.');
      const clean = name.trim();
      if (mode === 'replace') return { total: (await save(clean, `${clean}.csv`, table.columns, table.rows, 'result')).rowCount, created: false };
      const all = await store.list();
      const found = all.find(d => d.name === clean) ?? all.find(d => norm(d.name) === norm(clean));
      if (!found) return { total: (await save(clean, `${clean}.csv`, table.columns, table.rows, 'result')).rowCount, created: true };
      const target = (await store.get(found.id))!;
      const added = alignToColumns(target.columns, table);
      if (!added) throw new Error(columnMismatch(target.name, target.columns, table));
      return { total: (await addRows(target, added)).rowCount, created: false };
    },
  };
}

/* ---------------- stores ---------------- */

export function memoryStore(): DatasetStore {
  const items = new Map<number, Dataset>();
  let next = 1;
  const info = ({ rows: _rows, ...rest }: Dataset): DatasetInfo => rest;
  return {
    async list() { return [...items.values()].map(info); },
    async get(id) { const d = items.get(id); return d && structuredClone(d); },
    async put(i, rows) {
      const id = i.id ?? next++;
      items.set(id, structuredClone({ ...i, id, rows }));
      return id;
    },
    async remove(id) { return items.delete(id); },
  };
}

/** The real store: IndexedDB. Two object stores, so listing does not load every row. */
export function idbStore(dbName = 'jwork-data'): DatasetStore {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser does not allow storing data for this site.')); return; }
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('info', { keyPath: 'id', autoIncrement: true });
      req.result.createObjectStore('rows');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('Your browser would not open its storage for this site (private browsing, or storage is blocked).'));
    req.onblocked = () => reject(new Error('Storage is busy in another tab. Close other tabs of this app and try again.'));
  }));
  const wrap = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Saving failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Saving was stopped. The browser may be out of storage space.'));
  });
  return {
    async list() {
      const db = await open();
      return wrap<DatasetInfo[]>(db.transaction('info').objectStore('info').getAll());
    },
    async get(id) {
      const db = await open();
      const tx = db.transaction(['info', 'rows']);
      const [info, rows] = await Promise.all([wrap<DatasetInfo | undefined>(tx.objectStore('info').get(id)), wrap<Row[] | undefined>(tx.objectStore('rows').get(id))]);
      return info ? { ...info, rows: rows ?? [] } : undefined;
    },
    async put(info, rows) {
      const db = await open();
      const record: Record<string, unknown> = { ...info };
      if (record.id === undefined) delete record.id;   // let the store assign the next id
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(['info', 'rows'], 'readwrite');
        let id = 0;
        const request = tx.objectStore('info').put(record);
        // The rows are written from the callback, so the transaction is certainly still open.
        request.onsuccess = () => { id = Number(request.result); tx.objectStore('rows').put(rows, id); };
        tx.oncomplete = () => resolve(id);
        tx.onerror = () => reject(tx.error ?? new Error('Saving failed.'));
        tx.onabort = () => reject(tx.error ?? new Error('Saving was stopped. The browser may be out of storage space.'));
      });
    },
    async remove(id) {
      const db = await open();
      const existing = await wrap(db.transaction('info').objectStore('info').get(id));
      if (!existing) return false;
      const tx = db.transaction(['info', 'rows'], 'readwrite');
      tx.objectStore('info').delete(id);
      tx.objectStore('rows').delete(id);
      await done(tx);
      return true;
    },
  };
}

/* ---------------- the library the app uses ---------------- */

let instance: ReturnType<typeof createLibrary> | undefined;
const library = () => (instance ??= createLibrary(idbStore()));

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Reads a CSV or Excel file in the browser. */
export async function readUploadFile(file: File): Promise<ParsedFile> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('This file is larger than 5 MB.');
  const isExcel = /\.(xlsx|xlsm)$/i.test(file.name);
  const parsed = parseUpload(file.name, isExcel ? { bytes: new Uint8Array(await file.arrayBuffer()) } : { text: await file.text() });
  return { ...parsed, filename: file.name };
}

export const listDatasets = () => library().list();
export const getDataset = (id: number) => library().get(id);
export const deleteDataset = (id: number) => library().remove(id);
export const inspectDataset = (file: ParsedFile) => library().inspect(file);
/** Once the user has data worth keeping, ask the browser not to evict it (a request, which the browser may refuse). */
const keepSafe = <T,>(saved: T): T => { void requestPersistence(); return saved; };

export const uploadDataset = async (file: ParsedFile, options: { name?: string; mode?: UploadMode; targetId?: number } = {}) => keepSafe(await library().upload(file, options));
export const saveTable = async (name: string, table: Table) => keepSafe(await library().saveTable(name, table));
export const saveResult = async (name: string, table: Table, mode: SaveMode) => keepSafe(await library().saveResult(name, table, mode));
export const exportDatasets = () => library().exportAll();
export const importDatasets = (items: BackupDataset[]) => library().importAll(items);

/** Names and columns of the user's datasets (never rows), so the model can pick real data. Empty if storage is unavailable. */
export async function datasetBriefs(): Promise<DatasetBrief[]> {
  try {
    return (await listDatasets()).map(d => ({ name: d.name, columns: d.columns }));
  } catch {
    return [];
  }
}
