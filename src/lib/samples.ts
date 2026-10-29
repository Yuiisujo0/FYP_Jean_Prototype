/**
 * Sample datasets bundled with the site, so a first-time visitor can try the example requests without uploading a file.
 * They are the small made-up tables used in the evaluation (backend/eval/datasets); no real person is in them.
 */
import employees from '../data/samples/employees.csv?raw';
import inventory from '../data/samples/inventory.csv?raw';
import libraryLoans from '../data/samples/library_loans.csv?raw';
import salesOrders from '../data/samples/sales_orders.csv?raw';
import { listDatasets, saveTable } from './library';
import { parseCsv } from './tables';

const SAMPLES: [string, string][] = [
  ['library_loans', libraryLoans],
  ['employees', employees],
  ['sales_orders', salesOrders],
  ['inventory', inventory],
];

export const SAMPLE_NAMES = SAMPLES.map(([name]) => name);

/** Adds the sample datasets that are not in the Data library yet. Returns how many were added. */
export async function addSampleData(): Promise<number> {
  const have = new Set((await listDatasets()).map(d => d.name));
  let added = 0;
  for (const [name, text] of SAMPLES) {
    if (have.has(name)) continue;
    await saveTable(name, parseCsv(text));
    added++;
  }
  return added;
}
