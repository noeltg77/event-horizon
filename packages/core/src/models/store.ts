import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import si from 'systeminformation';
import type { CatalogFile, CatalogModel, CatalogQuant } from '../types';
import { getCatalog, getModel } from '../catalog';
import { paths } from '../paths';
import { downloadFile, type Progress } from '../download';
import { formatBytes } from '../util';

/** Where a catalog file lives on disk: ~/.localmax/models/<repo>/<path> */
export function localPath(model: CatalogModel, file: CatalogFile | string): string {
  const p = typeof file === 'string' ? file : file.path;
  return join(paths.models, ...model.repo.split('/'), ...p.split('/'));
}

async function exists(path: string, size?: number): Promise<boolean> {
  try {
    const s = await stat(path);
    return size ? s.size === size : true;
  } catch {
    return false;
  }
}

export async function isQuantDownloaded(model: CatalogModel, quant: CatalogQuant): Promise<boolean> {
  for (const f of quant.files) if (!(await exists(localPath(model, f), f.size))) return false;
  return true;
}

export async function isFileDownloaded(model: CatalogModel, file: CatalogFile): Promise<boolean> {
  return exists(localPath(model, file), file.size);
}

/** The path llama.cpp should be given: the first shard of a split model. */
export function modelEntryPath(model: CatalogModel, quant: CatalogQuant): string {
  return localPath(model, quant.files[0]);
}

export interface LocalModel {
  modelId: string;
  quantId: string;
  sizeBytes: number;
  path: string;
}

export async function listDownloaded(): Promise<LocalModel[]> {
  const out: LocalModel[] = [];
  for (const m of getCatalog().models) {
    for (const q of m.quants) {
      if (await isQuantDownloaded(m, q)) out.push({ modelId: m.id, quantId: q.id, sizeBytes: q.sizeBytes, path: modelEntryPath(m, q) });
    }
  }
  return out;
}

/** Partially downloaded bytes for a quant, to show resume progress in the UI. */
export async function partialBytes(model: CatalogModel, quant: CatalogQuant): Promise<number> {
  let total = 0;
  for (const f of quant.files) {
    const p = localPath(model, f);
    try {
      total += (await stat(p)).size;
      continue;
    } catch {}
    try {
      total += (await stat(`${p}.part`)).size;
    } catch {}
  }
  return total;
}

export interface PullOptions {
  onProgress?: (p: Progress & { file: string }) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

function hfHeaders(): Record<string, string> {
  return process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
}

/** Download files from Hugging Face with resume and SHA256 verification. */
export async function pullFiles(model: CatalogModel, files: CatalogFile[], opts: PullOptions = {}): Promise<void> {
  const need = files.reduce((s, f) => s + f.size, 0);
  const free = await freeDiskBytes();
  if (free !== null && free < need * 1.02) {
    throw new Error(`Not enough disk space: needs ${formatBytes(need)}, ${formatBytes(free)} free.`);
  }
  let doneBefore = 0;
  for (const f of files) {
    const dest = localPath(model, f);
    if (await exists(dest, f.size)) {
      opts.onLog?.(`${f.path} already downloaded`);
      doneBefore += f.size;
      continue;
    }
    opts.onLog?.(`Downloading ${f.path} (${formatBytes(f.size)})`);
    const url = `https://huggingface.co/${model.repo}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    const base = doneBefore;
    await downloadFile(url, dest, {
      headers: hfHeaders(),
      expectedSha256: f.sha256,
      expectedSize: f.size,
      signal: opts.signal,
      onProgress: (p) => opts.onProgress?.({ received: base + p.received, total: need, speed: p.speed, file: f.path }),
    });
    doneBefore += f.size;
    opts.onLog?.(`Verified ${f.path}`);
  }
}

export async function pullQuant(model: CatalogModel, quant: CatalogQuant, opts: PullOptions = {}): Promise<void> {
  return pullFiles(model, quant.files, opts);
}

/** Files needed for a run config beyond the main weights (draft model or speculative head). */
export function extraFilesFor(model: CatalogModel, spec: { type: string; draftModelId?: string; draftQuantId?: string; headFile?: string }): { model: CatalogModel; files: CatalogFile[] } | null {
  if ((spec.type === 'draft-eagle3' || spec.type === 'draft-mtp') && model.specHead) {
    return { model, files: [model.specHead.file] };
  }
  if (spec.type === 'draft-simple' && spec.draftModelId) {
    const dm = getModel(spec.draftModelId);
    const dq = dm?.quants.find((q) => q.id === spec.draftQuantId);
    if (dm && dq) return { model: dm, files: dq.files };
  }
  return null;
}

export async function deleteQuant(model: CatalogModel, quant: CatalogQuant): Promise<void> {
  for (const f of quant.files) {
    const p = localPath(model, f);
    await rm(p, { force: true });
    await rm(`${p}.part`, { force: true });
  }
  // Clean up empty folders
  try {
    const dir = join(paths.models, ...model.repo.split('/'));
    if (!(await readdir(dir)).length) await rm(dir, { recursive: true });
  } catch {}
}

export async function freeDiskBytes(): Promise<number | null> {
  try {
    const list = await si.fsSize();
    const root = paths.models.toLowerCase();
    const fs = list.filter((f) => root.startsWith(String(f.mount).toLowerCase())).sort((a, b) => b.mount.length - a.mount.length)[0];
    return fs ? fs.available : null;
  } catch {
    return null;
  }
}
