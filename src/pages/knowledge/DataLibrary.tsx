import { Database, FileSpreadsheet, RefreshCw, Trash2, Upload, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, IconButton } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Modal } from '../../components/ui/Modal';
import { deleteDataset, getDataset, inspectDataset, readUploadFile, uploadDataset, type ParsedFile, type UploadInfo, type UploadMode } from '../../lib/library';
import { plural, timeAgo } from '../../lib/format';
import { useDatasets } from '../../state/useDatasets';
import { useWorkspace } from '../../state/WorkspaceContext';
import type { Dataset, DatasetInfo } from '../../types';

const PREVIEW_ROWS = 8;
const ACCEPT = '.csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Decision = { mode: UploadMode; name?: string; targetId?: number };

interface Pending {
  file: ParsedFile;
  info: UploadInfo;
  /** Set when the user pressed "Update with a new file" on a specific dataset. */
  forcedId?: number;
  /** Which file of a batch this is. */
  index: number;
  total: number;
  resolve: (decision: Decision | null) => void;
}

const isSupported = (f: File) => /\.(csv|xlsx|xlsm)$/i.test(f.name);
const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

/** Uploaded data lives here, separate from workflows. A workflow's read step picks a dataset by name. */
export function DataLibrary({ uploadRef }: { uploadRef: React.RefObject<HTMLInputElement | null> }) {
  const { notify } = useWorkspace();
  const { items, error, refresh } = useDatasets();
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceId = useRef<number | null>(null);
  const working = useRef(false);
  const dragDepth = useRef(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [preview, setPreview] = useState<Dataset | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const uploads = items?.filter(d => d.origin !== 'result') ?? [];
  const results = items?.filter(d => d.origin === 'result') ?? [];
  const selected = items?.find(d => d.id === selectedId) ?? uploads[0] ?? results[0];
  const selectedKey = selected ? `${selected.id}:${selected.updatedAt}` : '';

  useEffect(() => {
    if (!selected) { setPreview(null); return; }
    let live = true;
    getDataset(selected.id).then(d => live && setPreview(d ?? null)).catch(() => live && setPreview(null));
    return () => { live = false; };
  }, [selectedKey]);

  // A file dropped outside the drop area would make the browser open it and leave the app.
  useEffect(() => {
    const stop = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);

  const ask = (p: Omit<Pending, 'resolve'>) => new Promise<Decision | null>(resolve => setPending({ ...p, resolve }));

  /** Handles files one after another. Unrelated files are saved straight away; likely updates ask the user. */
  const processFiles = async (files: File[], forcedId?: number) => {
    if (!files.length) return;
    if (working.current) { notify('Another upload is still running.'); return; }
    working.current = true;
    setProgress({ done: 0, total: files.length });
    let saved = 0, skipped = 0, failed = 0;
    let last: Dataset | null = null;
    let lastMessage = '';
    const errors: string[] = [];

    for (const [i, picked] of files.entries()) {
      try {
        if (!isSupported(picked)) throw new Error('Only CSV and Excel (.xlsx) files can be uploaded.');
        const file = await readUploadFile(picked);
        const info = await inspectDataset(file);

        let decision: Decision | null = { mode: 'new', name: info.suggestedName };
        if (forcedId || info.matches.length > 0) decision = await ask({ file, info, forcedId, index: i + 1, total: files.length });
        if (!decision) { skipped++; continue; }

        last = await uploadDataset(file, decision);
        saved++;
        lastMessage = `${last.name} ${decision.mode === 'append' ? 'now has' : 'saved with'} ${plural(last.rowCount, 'row')}`;
      } catch (e) {
        failed++;
        errors.push(`${picked.name}: ${e instanceof Error ? e.message : 'Upload failed.'}`);
      } finally {
        setPending(null);
        setProgress({ done: i + 1, total: files.length });
      }
    }

    await refresh();
    if (last) setSelectedId(last.id);
    const summary = `${plural(saved, 'file')} saved${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`;
    if (files.length === 1) {
      if (failed) notify(errors[0], { tone: 'error' });
      else if (saved) notify(lastMessage);
    } else if (failed) {
      notify(`${summary}. ${errors.join(' ')}`, { tone: 'error' });
    } else if (saved || skipped) {
      notify(summary);
    }
    setProgress(null);
    working.current = false;
  };

  const remove = async (d: DatasetInfo) => {
    if (!window.confirm(`Delete “${d.name}”? Workflows that read it will need another dataset.`)) return;
    try {
      await deleteDataset(d.id);
      await refresh();
      notify(`Deleted “${d.name}”`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not delete.', { tone: 'error' });
    }
  };

  return (
    <div
      className="data"
      onDragEnter={e => { if (hasFiles(e)) { dragDepth.current++; setDragging(true); } }}
      onDragOver={e => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={e => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void processFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="data__drop" aria-hidden>
          <Upload size={28} />
          <b>Drop files to upload</b>
          <small>CSV or Excel. You can drop several at once.</small>
        </div>
      )}

      <input
        ref={uploadRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={e => {
          const files = Array.from(e.target.files ?? []);
          e.currentTarget.value = '';
          void processFiles(files);
        }}
      />
      <input
        ref={replaceRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={e => {
          const file = e.target.files?.[0];
          e.currentTarget.value = '';
          if (file && replaceId.current !== null) void processFiles([file], replaceId.current);
        }}
      />

      {error && (
        <div className="data__error card" role="alert">
          <span><b>Could not open your datasets</b>{error}</span>
          <Button size="sm" onClick={refresh}>Retry</Button>
        </div>
      )}

      {items && items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Database size={24} />}
            title="No data yet"
            description="Drag CSV or Excel files here, or choose them. Upload once, for example your student marks. Workflows read the data from here, and you can replace it or add rows to it later."
            action={<Button variant="primary" icon={<Upload size={16} />} onClick={() => uploadRef.current?.click()}>Choose files</Button>}
          />
        </div>
      ) : items && (
        <div className="kb">
          <div className="kb__lists">
            {[
              { title: 'Your data', note: 'Files you uploaded.', list: uploads, result: false },
              { title: 'Saved by workflows', note: 'Tables that Database steps saved. They are not uploads, so uploads never replace them.', list: results, result: true },
            ].filter(g => g.list.length > 0).map(g => (
              <section key={g.title} aria-label={g.title}>
                <h3 className="kb__group">{g.title}</h3>
                <ul className="kb__list card">
                  {g.list.map(d => (
                    <li key={d.id}>
                      <button type="button" className="kb__row" aria-current={selected?.id === d.id} onClick={() => setSelectedId(d.id)}>
                        <span className="kb__icon">{g.result ? <Workflow size={17} /> : <Database size={17} />}</span>
                        <span className="kb__text">
                          <small>{plural(d.rowCount, 'row')} · {plural(d.columns.length, 'column')}</small>
                          <b>{d.name}</b>
                          <span>{g.result ? 'saved by a workflow' : d.filename} · updated {timeAgo(d.updatedAt)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {g.result && <p className="hint kb__groupnote">{g.note}</p>}
              </section>
            ))}
          </div>

          {selected && (
            <article className="kb__detail card" key={selected.id}>
              <h2>{selected.name}</h2>
              <p className="kb__summary">{selected.origin === 'result' ? 'Saved by a workflow' : selected.filename} · {plural(selected.rowCount, 'row')}</p>
              <div className="data__actions">
                {selected.origin !== 'result' && (
                  <Button size="sm" icon={<RefreshCw size={15} />} onClick={() => { replaceId.current = selected.id; replaceRef.current?.click(); }}>Update with a new file</Button>
                )}
                <IconButton label={`Delete ${selected.name}`} danger onClick={() => remove(selected)}><Trash2 size={16} /></IconButton>
              </div>
              <h3>Preview</h3>
              <div className="data__scroll">
                <table className="data__table">
                  <thead><tr>{selected.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>
                    {(preview?.rows ?? []).slice(0, PREVIEW_ROWS).map((r, i) => (
                      <tr key={i}>{selected.columns.map(c => <td key={c}>{r[c]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {selected.rowCount > PREVIEW_ROWS && <p className="hint">Showing the first {PREVIEW_ROWS} rows.</p>}
            </article>
          )}
        </div>
      )}

      {progress && <p className="hint data__progress" role="status">Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}…</p>}
      <p className="hint">Your data stays in this browser and is never uploaded: only dataset and column names (never rows) go to the AI. Clearing this site's data in your browser deletes it, so keep a copy: <Link to="/profile">download a backup</Link> (it includes your datasets). Drag and drop files anywhere on this page. CSV and Excel (.xlsx) are supported; for Excel, the first sheet with data is used.</p>

      {pending && items && <UploadDialog pending={pending} datasets={items} />}
    </div>
  );
}

type Choice = { kind: 'replace' | 'append'; id: number } | { kind: 'new' };

function UploadDialog({ pending, datasets }: { pending: Pending; datasets: DatasetInfo[] }) {
  const { file, info, forcedId, index, total, resolve } = pending;
  const onCancel = () => resolve(null);
  const matches = forcedId
    ? datasets.filter(d => d.id === forcedId).map(d => ({
        id: d.id, name: d.name, rowCount: d.rowCount, sameName: false,
        sameColumns: JSON.stringify([...d.columns].map(c => c.toLowerCase()).sort()) === JSON.stringify([...info.columns].map(c => c.toLowerCase()).sort()),
      }))
    : info.matches;
  const best = matches.find(m => m.sameName) ?? matches[0];

  const taken = new Set(datasets.map(d => d.name.toLowerCase()));
  const freeName = (base: string) => {
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    return name;
  };

  const [choice, setChoice] = useState<Choice>(forcedId || best?.sameName ? { kind: 'replace', id: best.id } : { kind: 'new' });
  const [name, setName] = useState(() => freeName(info.suggestedName));

  const go = () => {
    if (choice.kind === 'new') resolve({ mode: 'new', name: name.trim() });
    else if (choice.kind === 'replace') resolve({ mode: 'replace', name: matches.find(m => m.id === choice.id)!.name });
    else resolve({ mode: 'append', targetId: choice.id });
  };

  const radio = (value: Choice, title: string, text: string, disabled = false) => {
    const checked = choice.kind === value.kind && ('id' in choice ? 'id' in value && choice.id === value.id : true);
    return (
      <label className={`updlg__opt ${checked ? 'is-checked' : ''} ${disabled ? 'is-disabled' : ''}`}>
        <input type="radio" name="upload-choice" checked={checked} disabled={disabled} onChange={() => setChoice(value)} />
        <span><b>{title}</b><small>{text}</small></span>
      </label>
    );
  };

  return (
    <Modal
      title={total > 1 ? `What should happen to this file? (${index} of ${total})` : 'What should happen to this file?'}
      icon={<FileSpreadsheet size={20} />}
      onClose={onCancel}
      description={`${file.filename}${info.sheet ? ` (sheet “${info.sheet}”)` : ''} has ${plural(info.rowCount, 'row')} and ${plural(info.columns.length, 'column')}: ${info.columns.slice(0, 6).join(', ')}${info.columns.length > 6 ? ', …' : ''}.`}
      actions={<>
        <Button variant="ghost" onClick={onCancel}>{total > 1 ? 'Skip this file' : 'Cancel'}</Button>
        <Button variant="primary" disabled={choice.kind === 'new' && !name.trim()} onClick={go}>Save</Button>
      </>}
    >
      <div className="updlg">
        {matches.map(m => (
          <div key={m.id} className="updlg__group">
            {radio(
              { kind: 'replace', id: m.id },
              `Replace “${m.name}”`,
              `Swap its ${plural(m.rowCount, 'row')} for these ${plural(info.rowCount, 'row')}. Workflows keep using it.${m.sameColumns ? '' : ' The columns are different, so steps that use a removed column will fail.'}`,
            )}
            {radio(
              { kind: 'append', id: m.id },
              `Add these rows to “${m.name}”`,
              m.sameColumns ? `Keep its ${plural(m.rowCount, 'row')} and add ${info.rowCount} more.` : 'Not possible: the columns are different.',
              !m.sameColumns,
            )}
          </div>
        ))}
        {!forcedId && (
          <div className="updlg__group">
            {radio({ kind: 'new' }, 'Save as a new dataset', 'Keep the existing data as it is.')}
            {choice.kind === 'new' && (
              <input className="input" aria-label="New dataset name" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && go()} />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
