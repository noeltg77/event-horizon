import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/** Everything localmax writes lives under one folder: ~/.localmax (override with LOCALMAX_HOME). */
export function homeDir(): string {
  return process.env.LOCALMAX_HOME || join(homedir(), '.localmax');
}

export const paths = {
  get root() {
    return homeDir();
  },
  get engines() {
    return join(homeDir(), 'engines');
  },
  get models() {
    return join(homeDir(), 'models');
  },
  get benchmarks() {
    return join(homeDir(), 'benchmarks');
  },
  get hardwareProfile() {
    return join(homeDir(), 'hardware.json');
  },
  get engineState() {
    return join(homeDir(), 'engines', 'installed.json');
  },
  get settings() {
    return join(homeDir(), 'settings.json');
  },
  get calibration() {
    return join(homeDir(), 'calibration.json');
  },
  get quality() {
    return join(homeDir(), 'quality.json');
  },
  get qualityWork() {
    return join(homeDir(), 'quality');
  },
  get slots() {
    return join(homeDir(), 'slots');
  },
  get mlxEngine() {
    return join(homeDir(), 'engines', 'mlx');
  },
};

export async function ensureDirs(): Promise<void> {
  for (const d of [paths.root, paths.engines, paths.models, paths.benchmarks]) {
    await mkdir(d, { recursive: true });
  }
}
