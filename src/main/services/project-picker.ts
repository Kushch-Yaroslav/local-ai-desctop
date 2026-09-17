import { stat } from 'node:fs/promises';

/** Electron receives this as showOpenDialog.defaultPath when the saved root still exists. */
export async function existingProjectDirectory(directory: string | null | undefined): Promise<string | undefined> {
  if (!directory) return undefined;
  try { return (await stat(directory)).isDirectory() ? directory : undefined; }
  catch { return undefined; }
}
