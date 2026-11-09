import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchmarkRecord } from './types';
import { paths, ensureDirs } from './paths';

/** Every tuning run is logged as JSON so we build our own dataset from day one. */
export async function saveBenchmark(rec: BenchmarkRecord): Promise<string> {
  await ensureDirs();
  const file = join(paths.benchmarks, `${rec.id}.json`);
  await writeFile(file, JSON.stringify(rec, null, 2));
  return file;
}

export async function listBenchmarks(limit = 100): Promise<BenchmarkRecord[]> {
  await ensureDirs();
  const files = (await readdir(paths.benchmarks)).filter((f) => f.endsWith('.json') && !f.startsWith('compare_')).sort().reverse().slice(0, limit);
  const out: BenchmarkRecord[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await readFile(join(paths.benchmarks, f), 'utf8')));
    } catch {}
  }
  return out;
}

export function benchmarkId(modelId: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}_${modelId}`;
}
