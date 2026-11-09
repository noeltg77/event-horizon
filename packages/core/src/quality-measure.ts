import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { CatalogModel, CatalogQuant, HardwareProfile } from './types';
import { paths, ensureDirs } from './paths';
import { CORPUS } from './corpus';
import { kldToQuality, type MeasuredQuality } from './quality';
import { engineTool, type InstalledEngine } from './engine/engine-manager';
import { isQuantDownloaded, modelEntryPath, pullFiles } from './models/store';
import { budgets } from './planner/memory';
import type { Progress } from './download';

// Measured quality: KL divergence of the quant's next-token probabilities against a
// reference (Q8_0, which is within ~0.1% of BF16) over a fixed original text, using
// llama.cpp's own llama-perplexity tool. Quality = 100 × e^(−mean KLD).

const CTX = 512;
const CHUNKS = 4; // 4 × 512 tokens; the second half of each chunk is scored ≈ 1,000 tokens

export async function loadMeasuredQuality(): Promise<MeasuredQuality> {
  try {
    return JSON.parse(await readFile(paths.quality, 'utf8')) as MeasuredQuality;
  } catch {
    return {};
  }
}

async function saveMeasured(key: string, value: MeasuredQuality[string]): Promise<void> {
  const all = await loadMeasuredQuality();
  all[key] = value;
  await ensureDirs();
  await writeFile(paths.quality, JSON.stringify(all, null, 2));
}

export function referenceQuant(model: CatalogModel): CatalogQuant | null {
  return model.quants.find((q) => q.id === 'Q8_0') ?? null;
}

/** Can this machine measure the model? The Q8_0 reference has to fit in free memory. */
export function canMeasureQuality(model: CatalogModel, hw: HardwareProfile, ownEngineBytes = 0): { ok: boolean; reason: string; reference: CatalogQuant | null } {
  const ref = referenceQuant(model);
  if (!ref) return { ok: false, reason: 'No Q8_0 reference is published for this model, so quality stays an estimate.', reference: null };
  // llama-perplexity at a 512-token context needs the weights plus well under a gigabyte
  const free = budgets(hw, 'free', ownEngineBytes).freeNow;
  if (ref.sizeBytes + 0.6 * 1024 ** 3 > free) {
    return { ok: false, reason: `The Q8_0 reference (${(ref.sizeBytes / 1e9).toFixed(1)} GB) doesn't fit in free memory, so quality stays an estimate.`, reference: ref };
  }
  return { ok: true, reason: '', reference: ref };
}

/** Parse llama-perplexity's KL-divergence summary. */
export function parseKld(out: string): { kld: number; samePct: number } | null {
  const kld = out.match(/Mean\s+KLD:\s+([\d.]+)/);
  const same = out.match(/Same top p:\s+([\d.]+)/);
  if (!kld) return null;
  return { kld: Number(kld[1]), samePct: same ? Number(same[1]) : NaN };
}

export interface MeasureOptions {
  model: CatalogModel;
  quant: CatalogQuant;
  engine: InstalledEngine;
  onLog?: (line: string) => void;
  onProgress?: (p: Progress & { label: string }) => void;
  signal?: AbortSignal;
}

export async function measureQuality(o: MeasureOptions): Promise<MeasuredQuality[string]> {
  const log = o.onLog ?? (() => {});
  const ref = referenceQuant(o.model);
  if (!ref) throw new Error('No Q8_0 reference for this model.');
  const key = `${o.model.id}/${o.quant.id}`;
  if (o.quant.id === ref.id) {
    const v = { qualityPct: 99.92, kld: 0.0008, samePct: NaN, measuredAt: new Date().toISOString(), reference: 'Q8_0 (is the reference; ≈ BF16)' };
    await saveMeasured(key, v);
    return v;
  }
  if (!(await isQuantDownloaded(o.model, o.quant))) throw new Error(`Download ${o.quant.id} first.`);
  if (!(await isQuantDownloaded(o.model, ref))) {
    log(`Downloading the Q8_0 reference (${(ref.sizeBytes / 1e9).toFixed(1)} GB)`);
    await pullFiles(o.model, ref.files, { onLog: log, signal: o.signal, onProgress: (p) => o.onProgress?.({ ...p, label: 'Q8_0 reference' }) });
  }

  const work = join(paths.qualityWork, o.model.id);
  await mkdir(work, { recursive: true });
  const corpus = join(work, 'corpus.txt');
  const base = join(work, 'reference.kld');
  await writeFile(corpus, CORPUS);
  const tool = engineTool(o.engine, 'llama-perplexity');
  try {
    log('Recording the reference model’s token probabilities');
    await runTool(o.engine, tool, ['-m', modelEntryPath(o.model, ref), '-f', corpus, '-c', String(CTX), '--chunks', String(CHUNKS), '-ngl', '99', '--kl-divergence-base', base], log, o.signal);
    log(`Comparing ${o.quant.id} against the reference`);
    const out = await runTool(o.engine, tool, ['-m', modelEntryPath(o.model, o.quant), '-c', String(CTX), '-ngl', '99', '--kl-divergence-base', base, '--kl-divergence'], log, o.signal);
    const parsed = parseKld(out);
    if (!parsed) throw new Error(`Could not read the KL divergence result.\n${out.slice(-600)}`);
    const v = { qualityPct: kldToQuality(parsed.kld), kld: parsed.kld, samePct: parsed.samePct, measuredAt: new Date().toISOString(), reference: 'Q8_0' };
    await saveMeasured(key, v);
    log(`Mean KLD ${parsed.kld.toFixed(4)} → ${v.qualityPct}% quality (top token matches the reference ${parsed.samePct.toFixed(1)}% of the time)`);
    return v;
  } finally {
    // The reference probabilities are hundreds of MB; recreating them takes seconds
    await rm(base, { force: true });
  }
}

function runTool(engine: InstalledEngine, bin: string, args: string[], log: (l: string) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: engine.dir, env: { ...process.env, PATH: `${engine.dir}${delimiter}${process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b: Buffer) => {
      const s = b.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) if (/KLD|Same top|chunk|error/i.test(line) && line.trim()) log(line.trim().slice(0, 160));
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    signal?.addEventListener('abort', () => p.kill('SIGTERM'));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`llama-perplexity exited with code ${code}\n${out.slice(-800)}`))));
  });
}
