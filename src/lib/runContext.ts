/** Connects the execution engine to the data library (stored in this browser) and the network. */
import { getDataset, listDatasets, saveResult } from './library';
import type { RunContext } from './engine';

export const runContext: RunContext = {
  listDatasets,
  loadDataset: async id => {
    const d = await getDataset(id);
    if (!d) throw new Error('That dataset no longer exists in your data library.');
    return { columns: d.columns, rows: d.rows };
  },
  saveTable: (name, table, mode) => saveResult(name, table, mode),
  fetchJson: async url => {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new Error('The request failed. The address may be wrong, or the server does not allow requests from the browser (CORS).');
    }
    if (!res.ok) throw new Error(`The server answered with status ${res.status}.`);
    return res.json();
  },
};
