import { Plus, Upload } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CommandPalette } from '../components/CommandPalette';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { useWorkspace } from './WorkspaceContext';

type Dialog = 'create' | 'import' | 'palette' | null;

interface Dialogs {
  openCreate: () => void;
  openImport: () => void;
  openPalette: () => void;
}

const DialogsContext = createContext<Dialogs | null>(null);

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = useCallback(() => setDialog(null), []);
  const value = useMemo<Dialogs>(() => ({
    openCreate: () => setDialog('create'),
    openImport: () => setDialog('import'),
    openPalette: () => setDialog('palette'),
  }), []);

  return (
    <DialogsContext.Provider value={value}>
      {children}
      {dialog === 'create' && <CreateDialog onClose={close} />}
      {dialog === 'import' && <ImportDialog onClose={close} />}
      <CommandPalette open={dialog === 'palette'} onOpen={value.openPalette} onClose={close} onCreate={value.openCreate} />
    </DialogsContext.Provider>
  );
}

export function useDialogs(): Dialogs {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error('useDialogs must be used inside <DialogsProvider>');
  return ctx;
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { createFlow } = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');

  const submit = () => {
    const flow = createFlow(name);
    onClose();
    navigate(`/editor/${flow.id}`);
  };

  return (
    <Modal
      title="Create a workflow"
      description="Start from a blank flow, then add steps in the editor."
      icon={<Plus size={20} />}
      onClose={onClose}
      actions={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>Create workflow</Button>
      </>}
    >
      <div className="field">
        <label className="field__label" htmlFor="new-flow-name">Workflow name</label>
        <input
          id="new-flow-name"
          className="input"
          value={name}
          placeholder="e.g. Weekly data review"
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
        />
      </div>
    </Modal>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { importFlow } = useWorkspace();
  const navigate = useNavigate();

  const pick = async (file?: File) => {
    if (!file) return;
    const flow = await importFlow(file);
    if (flow) {
      onClose();
      navigate(`/editor/${flow.id}`);
    }
  };

  return (
    <Modal
      title="Import a workflow"
      description="Choose a jwork workflow file you exported earlier."
      icon={<Upload size={20} />}
      onClose={onClose}
      actions={<Button variant="ghost" onClick={onClose}>Cancel</Button>}
    >
      <label className="dropzone">
        <Upload size={22} />
        <b>Choose a JSON file</b>
        <small>.jwork.json or .json</small>
        <input type="file" accept="application/json,.json" onChange={e => pick(e.target.files?.[0])} />
      </label>
    </Modal>
  );
}
