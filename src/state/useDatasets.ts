import { useCallback, useEffect, useState } from 'react';
import { listDatasets } from '../lib/library';
import type { DatasetInfo } from '../types';

/** The Data library. `items` is null while loading or when the browser will not open its storage. */
export function useDatasets(enabled = true) {
  const [items, setItems] = useState<DatasetInfo[] | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setItems(await listDatasets());
      setError('');
    } catch (e) {
      setItems(null);
      setError(e instanceof Error ? e.message : 'Could not load the data library.');
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { items, error, refresh };
}
