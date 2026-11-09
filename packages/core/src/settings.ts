import { readFile, writeFile } from 'node:fs/promises';
import { paths, ensureDirs } from './paths';

export interface Settings {
  /** Unload a loaded model after this many idle minutes; 0 keeps it loaded until you stop it */
  keepAliveMinutes: number;
}

const DEFAULTS: Settings = { keepAliveMinutes: 10 };

export async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULTS, ...JSON.parse(await readFile(paths.settings, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await ensureDirs();
  await writeFile(paths.settings, JSON.stringify(next, null, 2));
  return next;
}
