/**
 * Browser storage can be cleared by the browser when the device runs low on space, unless the site has been granted
 * "persistent" storage. Persistence is a request: Chrome decides from how much the site is used, Firefox asks the user,
 * Safari has its own rules. So the app asks, reports the answer honestly, and keeps backup as the real safety net.
 */

export interface StorageStatus {
  /** true granted, false not granted, null the browser cannot say */
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
}

const manager = (): StorageManager | undefined => (typeof navigator === 'undefined' ? undefined : navigator.storage);

export async function storageStatus(): Promise<StorageStatus> {
  const s = manager();
  if (!s) return { persisted: null, usage: null, quota: null };
  const [persisted, estimate] = await Promise.all([
    s.persisted?.().catch(() => null) ?? null,
    s.estimate?.().catch(() => undefined),
  ]);
  return { persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
}

let asked = false;

/** Asks the browser to keep this site's data. Returns whether it is now persistent; never throws. */
export async function requestPersistence(): Promise<boolean> {
  const s = manager();
  if (!s?.persist) return false;
  try {
    if (await s.persisted?.()) return true;
    if (asked) return false;   // do not nag (Firefox shows a prompt each time)
    asked = true;
    return await s.persist();
  } catch {
    return false;
  }
}

/** Asks again on purpose, because the user pressed a button. */
export async function requestPersistenceNow(): Promise<boolean> {
  asked = false;
  return requestPersistence();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
