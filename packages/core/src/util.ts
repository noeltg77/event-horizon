import { execFile } from 'node:child_process';

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;

/** Run a command and return stdout, or null if it fails or isn't installed. Never throws. */
export function tryExec(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * MiB }, (err, stdout) => {
        resolve(err ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(i >= 3 ? digits : 0)} ${units[i]}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
