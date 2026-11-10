/**
 * Sample datasets bundled with the site, so a first-time visitor can try the example requests without uploading a file.
 * employees, sales_orders and inventory are the small made-up tables used in the evaluation (backend/eval/datasets).
 * staff_list is laid out like a company HR export (column names with spaces and brackets, "Sales & Marketing" as a unit);
 * it was made by hand for trying jwork (docs/test-data/HR_export_Q3.xlsx) and is not in the evaluation. No real person is
 * in any of them.
 */
import employees from '../data/samples/employees.csv?raw';
import inventory from '../data/samples/inventory.csv?raw';
import salesOrders from '../data/samples/sales_orders.csv?raw';
import staffList from '../data/samples/staff_list.csv?raw';
import { listDatasets, saveTable } from './library';
import { parseCsv } from './tables';

const SAMPLES: [string, string][] = [
  ['staff_list', staffList],
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
