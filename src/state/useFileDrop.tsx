import { FileSpreadsheet } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { checkFile } from '../lib/fileKind';
import { handOffFiles } from '../lib/fileHandOff';
import { plural } from '../lib/format';
import { useWorkspace } from './WorkspaceContext';

const ACCEPT = '.csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const hasFiles = (e: DragEvent | globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Lets a prompt box take files: dropped anywhere on the area that spreads `bind`, or chosen with `pick`. Each file is checked
 * (by its contents, not only its name); CSV and Excel files go to the Data library to be uploaded there, with whatever the
 * person had typed, and anything else is turned away with the reason. `leave` runs right after navigating (the cover uses
 * it to close itself).
 */
export function useFileDrop(getPrompt: () => string, leave?: () => void) {
  const navigate = useNavigate();
  const { notify } = useWorkspace();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // A file dropped beside the drop area would make the browser open it and leave the app.
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);

  const take = async (files: File[]) => {
    if (!files.length) return;
    const checks = await Promise.all(files.map(f => checkFile(f).catch(() => null)));
    const good = files.filter((_, i) => checks[i]?.ok);
    const bad = files.flatMap((f, i) => (checks[i]?.ok ? [] : [`${f.name}: ${checks[i]?.reason ?? 'could not be read.'}`]));
    if (!good.length) {
      notify(bad.length === 1 ? bad[0] : `None of these ${files.length} files can be used. ${bad.join(' ')}`, { tone: 'error' });
      return;
    }
    handOffFiles(good, getPrompt());
    if (bad.length) notify(`${plural(bad.length, 'file')} left out. ${bad.join(' ')}`, { tone: 'error' });
    navigate('/knowledge?tab=data');
    leave?.();
  };

  const bind = {
    onDragEnter: (e: DragEvent) => { if (hasFiles(e)) { depth.current++; setDragging(true); } },
    onDragOver: (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      void take(Array.from(e.dataTransfer.files));
    },
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={ACCEPT}
      multiple
      hidden
      data-testid="prompt-file"
      onChange={e => {
        const files = Array.from(e.target.files ?? []);
        e.currentTarget.value = '';
        void take(files);
      }}
    />
  );

  const overlay = dragging ? (
    <div className="filedrop" aria-hidden>
      <FileSpreadsheet size={30} />
      <b>Drop to add it to your data</b>
      <small>CSV or Excel. It opens in your Data library, where you can save it or add it to a table you already have.</small>
    </div>
  ) : null;

  return { bind, pick: () => inputRef.current?.click(), input, overlay, dragging };
}
