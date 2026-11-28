import { useCallback, useEffect, useState } from 'react';
import { KEYS, readJSON, writeJSON } from '../../lib/storage';

/**
 * How the "How it was done" view is arranged, chosen by the person and remembered in this browser: where the Logs sit (under
 * the canvas, or as a column on either side) and which side the tools (Add, Inspect, Ask, Check) are on. When the Logs and
 * the tools share a side, the Logs sit next to the canvas and the tools on the outside. Narrow screens always stack.
 */
export type LogsDock = 'bottom' | 'left' | 'right';
export type ToolsSide = 'left' | 'right';
export interface EditorLayout { logs: LogsDock; tools: ToolsSide }

export const DEFAULT_LAYOUT: EditorLayout = { logs: 'bottom', tools: 'right' };

function readLayout(): EditorLayout {
  const saved = readJSON<Partial<EditorLayout>>(KEYS.editorLayout, {});
  return {
    logs: saved.logs === 'left' || saved.logs === 'right' ? saved.logs : 'bottom',
    tools: saved.tools === 'left' ? 'left' : 'right',
  };
}

/** True on screens too narrow for side columns, where the canvas, the logs and the tools stack. */
export function useNarrow(query = '(max-width: 900px)') {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

export function useEditorLayout() {
  const [layout, setLayout] = useState<EditorLayout>(readLayout);
  const update = useCallback((patch: Partial<EditorLayout>) => {
    setLayout(l => {
      const next = { ...l, ...patch };
      writeJSON(KEYS.editorLayout, next);
      return next;
    });
  }, []);
  const narrow = useNarrow();
  // What is actually shown: on a narrow screen everything stacks, whatever was chosen.
  const shown: EditorLayout = narrow ? DEFAULT_LAYOUT : layout;
  return {
    layout,
    shown,
    narrow,
    setLogs: (logs: LogsDock) => update({ logs }),
    setTools: (tools: ToolsSide) => update({ tools }),
    reset: () => update(DEFAULT_LAYOUT),
  };
}
