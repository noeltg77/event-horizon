import { execFile } from 'node:child_process';
import type { HardwareProfile } from '../types';
import { tryExec } from '../util';

// macOS caps how much memory Metal may wire for the GPU (about 2/3 of RAM up to 36 GB,
// 3/4 above). The cap can be raised with `sysctl iogpu.wired_limit_mb`, which needs an
// administrator password and resets on reboot. On an 18 GB Mac it's the difference between
// a 12 GB model fitting on the GPU or being split with the much slower CPU.

const MiB = 1024 * 1024;

export interface WiredLimitInfo {
  supported: boolean;
  totalMb: number;
  /** What's in effect now */
  currentMb: number;
  /** macOS's default when nothing is set */
  defaultMb: number;
  /** Leaves 4 GB for macOS and your apps */
  recommendedMb: number;
  /** Whether someone has raised it already */
  raised: boolean;
  command: string;
}

export async function wiredLimitInfo(hw: HardwareProfile): Promise<WiredLimitInfo> {
  const totalMb = Math.floor(hw.memory.totalBytes / MiB);
  const defaultMb = Math.floor(totalMb * (hw.memory.totalBytes <= 36 * 1024 * MiB ? 2 / 3 : 3 / 4));
  const set = Number((await tryExec('sysctl', ['-n', 'iogpu.wired_limit_mb']))?.trim()) || 0;
  const recommendedMb = Math.max(defaultMb, totalMb - 4096);
  return {
    supported: hw.unifiedMemory && process.platform === 'darwin',
    totalMb,
    currentMb: set > 0 ? set : defaultMb,
    defaultMb,
    recommendedMb,
    raised: set > 0,
    command: `sudo sysctl iogpu.wired_limit_mb=${recommendedMb}`,
  };
}

export function validWiredMb(mb: number, totalMb: number): boolean {
  // 0 restores the default; anything else must leave at least 2 GB for macOS
  return Number.isInteger(mb) && (mb === 0 || (mb >= 1024 && mb <= totalMb - 2048));
}

/**
 * Apply a new limit. macOS shows its own administrator password dialog, so the person at the
 * keyboard authorises it; localmax never sees the password.
 */
export function applyWiredLimit(mb: number, totalMb: number): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Only available on macOS'));
  if (!validWiredMb(mb, totalMb)) return Promise.reject(new Error(`Choose 0 (default) or between 1024 and ${totalMb - 2048} MB`));
  const script = `do shell script "/usr/sbin/sysctl iogpu.wired_limit_mb=${mb}" with prompt "localmax wants to let the GPU use more memory (resets when you restart)." with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 120_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(/User canceled|-128/.test(String(stderr)) ? 'Cancelled' : `Could not change the limit: ${stderr || err.message}`));
      else resolve();
    });
  });
}
