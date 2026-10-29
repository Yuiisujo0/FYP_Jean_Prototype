/**
 * Example requests shown on the landing cover, on Generate and in small-talk replies. Each is a job an office or admin
 * person might be asked to do, and each runs on the bundled sample data (src/data/samples), so a first-time visitor
 * can try one without uploading anything.
 */
export const EXAMPLES = [
  'From library loans, list the loans where returned is no, latest due date first',
  'From employees, list everyone in Sales earning over 6000, highest salary first',
  'From sales orders, count the orders for each status',
  'From inventory, list the items with fewer than 5 in stock and their supplier',
];

/** Shorter labels for the landing cover's chips; each fills the prompt box with the full example. */
export const EXAMPLE_LABELS = ['Books still out', 'Sales staff over 6,000', 'Orders by status', 'Low stock'];
