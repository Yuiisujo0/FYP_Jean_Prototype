import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BUILT_IN_KNOWLEDGE } from '../data/knowledge';
import { makeStarters } from '../data/starters';
import { chainEdges, withPositions } from '../lib/flowGraph';
import { makeId } from '../lib/id';
import { buildBackup, parseBackup, restoreMessage } from '../lib/backup';
import { plural, slug } from '../lib/format';
import { exportDatasets, importDatasets } from '../lib/library';
import { KEYS, downloadJSON, loadFlows, loadKnowledge, normaliseFlow, parseFlowFile, parseKnowledgeFile, readString, writeJSON, writeString } from '../lib/storage';
import type { Flow, KnowledgeEntry, Profile } from '../types';
import { useOllama } from './useOllama';
import { normaliseProfile, useProfile } from './useProfile';
import { useAppearance } from './useTheme';

interface ToastMessage {
  id: number;
  message: string;
  tone: 'ok' | 'error';
  action?: { label: string; run: () => void };
}

interface NotifyOptions {
  tone?: 'ok' | 'error';
  action?: ToastMessage['action'];
}

function useWorkspaceState() {
  const [flows, setFlows] = useState<Flow[]>(loadFlows);
  const [importedKnowledge, setImportedKnowledge] = useState<KnowledgeEntry[]>(loadKnowledge);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(() => Number(readString(KEYS.lastBackup, '')) || null);
  const appearance = useAppearance();
  const ollama = useOllama();
  const { profile, updateProfile } = useProfile();

  const flowsRef = useRef(flows);
  flowsRef.current = flows;

  useEffect(() => writeJSON(KEYS.flows, flows), [flows]);
  useEffect(() => writeJSON(KEYS.knowledge, importedKnowledge), [importedKnowledge]);

  const toastCounter = useRef(0);
  const notify = useCallback((message: string, options: NotifyOptions = {}) => {
    setToast({ id: ++toastCounter.current, message, tone: options.tone ?? 'ok', action: options.action });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.action ? 6000 : 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const knowledge = useMemo(() => [...importedKnowledge, ...BUILT_IN_KNOWLEDGE], [importedKnowledge]);

  const addFlow = useCallback((flow: Flow) => setFlows(prev => [flow, ...prev]), []);

  const createFlow = useCallback((name: string): Flow => {
    const start = withPositions([{ id: makeId(), type: 'INPUT', name: 'Start', description: 'Workflow input.', config: { source: 'manual' } }]);
    const flow: Flow = { id: makeId(), name: name.trim() || 'Untitled workflow', description: 'A new structured workflow.', updatedAt: Date.now(), nodes: start, edges: [] };
    setFlows(prev => [flow, ...prev]);
    return flow;
  }, []);

  const updateFlow = useCallback((id: string, patch: Partial<Flow>) => {
    setFlows(prev => prev.map(f => (f.id === id ? { ...f, ...patch, updatedAt: Date.now() } : f)));
  }, []);

  const deleteFlow = useCallback((id: string) => {
    const index = flowsRef.current.findIndex(f => f.id === id);
    if (index < 0) return;
    const removed = flowsRef.current[index];
    setFlows(prev => prev.filter(f => f.id !== id));
    notify(`Deleted “${removed.name}”`, {
      action: {
        label: 'Undo',
        run: () => setFlows(current => (current.some(f => f.id === removed.id) ? current : [...current.slice(0, index), removed, ...current.slice(index)])),
      },
    });
  }, [notify]);

  const duplicateFlow = useCallback((flow: Flow) => {
    const idMap = new Map(flow.nodes.map(n => [n.id, makeId()]));
    const nodes = flow.nodes.map(n => ({ ...n, id: idMap.get(n.id)!, config: { ...n.config } }));
    const edges = flow.edges.length
      ? flow.edges.filter(e => idMap.has(e.source) && idMap.has(e.target)).map(e => ({ id: makeId(), source: idMap.get(e.source)!, target: idMap.get(e.target)! }))
      : chainEdges(nodes);
    const copy: Flow = { ...flow, id: makeId(), name: `${flow.name} copy`, nodes, edges, updatedAt: Date.now() };
    setFlows(prev => [copy, ...prev]);
    notify('Workflow duplicated');
    return copy;
  }, [notify]);

  const exportFlow = useCallback((flow: Flow) => {
    downloadJSON(`${slug(flow.name)}.jwork.json`, { format: 'jwork.workflow', version: 1, ...flow });
    notify('Workflow exported as JSON');
  }, [notify]);

  const importFlow = useCallback(async (file: File): Promise<Flow | null> => {
    try {
      const flow = await parseFlowFile(file);
      setFlows(prev => [flow, ...prev]);
      notify('Workflow imported');
      return flow;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not import this workflow.', { tone: 'error' });
      return null;
    }
  }, [notify]);

  const importKnowledge = useCallback(async (file: File) => {
    try {
      const entries = await parseKnowledgeFile(file);
      setImportedKnowledge(prev => [...entries, ...prev]);
      notify(`Imported ${entries.length} knowledge ${entries.length === 1 ? 'entry' : 'entries'}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Invalid knowledge file.', { tone: 'error' });
    }
  }, [notify]);

  const exportWorkspace = useCallback(async () => {
    let datasets;
    try {
      datasets = await exportDatasets();
    } catch {
      // A backup that silently left out the data would be worse than no backup.
      notify('Could not read your data library, so no backup was made. Try again, or reload the page.', { tone: 'error' });
      return;
    }
    downloadJSON('jwork-backup.json', buildBackup({ profile, flows: flowsRef.current, knowledge: importedKnowledge, datasets }), 0);
    const now = Date.now();
    writeString(KEYS.lastBackup, String(now));
    setLastBackupAt(now);
    notify(`Backup downloaded (${plural(flowsRef.current.length, 'workflow')}, ${plural(datasets.length, 'dataset')})`);
  }, [profile, importedKnowledge, notify]);

  const restoreWorkspace = useCallback(async (file: File) => {
    try {
      const parsed = parseBackup(JSON.parse(await file.text()));
      // Datasets first: if the browser cannot store them, nothing else is replaced.
      const restored = parsed.datasets ? await importDatasets(parsed.datasets) : 0;
      setFlows(parsed.flows.map(f => normaliseFlow(f as Flow)));
      setImportedKnowledge(parsed.knowledge);
      if (parsed.profile) updateProfile(normaliseProfile(parsed.profile as Partial<Profile>));
      notify(restoreMessage(parsed.flows.length, parsed, restored));
    } catch (e) {
      notify(e instanceof SyntaxError ? 'That file is not valid JSON.' : e instanceof Error ? e.message : 'Could not restore the backup.', { tone: 'error' });
    }
  }, [notify, updateProfile]);

  const resetDemoData = useCallback(() => {
    setFlows(makeStarters());
    setImportedKnowledge([]);
    notify('Demo data restored');
  }, [notify]);

  return {
    flows, knowledge, toast, dismissToast, notify,
    addFlow, createFlow, updateFlow, deleteFlow, duplicateFlow, exportFlow, importFlow,
    importKnowledge, resetDemoData, exportWorkspace, restoreWorkspace,
    profile, updateProfile, lastBackupAt,
    ...appearance,
    ollama,
  };
}

type Workspace = ReturnType<typeof useWorkspaceState>;
const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const value = useWorkspaceState();
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return ctx;
}
