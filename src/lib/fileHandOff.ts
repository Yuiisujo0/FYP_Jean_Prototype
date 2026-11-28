/**
 * Files dropped on a prompt box (the cover, the Overview or Generate) are handed to the Data library, which uploads them.
 * They wait here in memory while the app navigates; a File cannot be saved to storage, and a reload simply drops them.
 * Whatever the person had typed travels with them, so the request can be built once the data is in.
 */
export interface HandOff {
  files: File[];
  /** The request typed in the box when the files were dropped, or ''. */
  prompt: string;
}

let waiting: HandOff | null = null;

export function handOffFiles(files: File[], prompt = ''): void {
  waiting = { files, prompt: prompt.trim() };
}

/** Takes the waiting files, once: a second call returns null. */
export function takeHandOff(): HandOff | null {
  const w = waiting;
  waiting = null;
  return w;
}
