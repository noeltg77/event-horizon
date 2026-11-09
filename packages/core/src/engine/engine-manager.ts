import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Backend, HardwareProfile } from '../types';
import { paths, ensureDirs } from '../paths';
import { downloadFile, type Progress } from '../download';

/** The llama.cpp build this release of localmax was tested against. `engine install --latest` overrides it. */
export const PINNED_ENGINE_TAG = 'b12202';
const REPO = 'ggml-org/llama.cpp';

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  browser_download_url: string;
}

export interface EngineSelection {
  backend: Backend;
  /** Platform suffix used in asset names, e.g. "macos-arm64" or "win-cuda-12.4-x64" */
  suffix: string;
  /** Extra runtime archive (Windows CUDA DLLs) */
  runtimeAsset?: string;
  why: string;
}

export interface InstalledEngine {
  tag: string;
  backend: Backend;
  suffix: string;
  dir: string;
  serverPath: string;
  installedAt: string;
  assets: { name: string; sha256: string | null }[];
}

/**
 * Pick the prebuilt llama.cpp binary for this machine. Pure function, so it's unit-tested
 * against fake hardware profiles.
 */
export function selectEngine(hw: HardwareProfile): EngineSelection {
  const { platform, arch } = hw.os;
  const nvidia = hw.gpus.find((g) => g.vendor === 'nvidia');
  const amdIntel = hw.gpus.find((g) => g.vendor === 'amd' || g.vendor === 'intel');

  if (platform === 'darwin') {
    return arch === 'arm64'
      ? { backend: 'metal', suffix: 'macos-arm64', why: 'Apple Silicon: Metal build' }
      : { backend: 'cpu', suffix: 'macos-x64', why: 'Intel Mac: CPU build' };
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return { backend: 'cpu', suffix: 'win-cpu-arm64', why: 'Windows on ARM: CPU build' };
    if (nvidia) {
      // CUDA 13 needs a 580+ driver; otherwise use the CUDA 12.4 build
      const drv = parseFloat(nvidia.driver ?? '0');
      const cuda = drv >= 580 ? '13.5' : '12.4';
      return {
        backend: 'cuda',
        suffix: `win-cuda-${cuda}-x64`,
        runtimeAsset: `cudart-llama-bin-win-cuda-${cuda}-x64.zip`,
        why: `NVIDIA GPU with driver ${nvidia.driver ?? 'unknown'}: CUDA ${cuda} build`,
      };
    }
    if (amdIntel) return { backend: 'vulkan', suffix: 'win-vulkan-x64', why: `${amdIntel.vendor.toUpperCase()} GPU: Vulkan build` };
    return { backend: 'cpu', suffix: 'win-cpu-x64', why: 'No supported GPU: CPU build' };
  }
  // Linux
  if (arch === 'arm64') return { backend: 'cpu', suffix: 'ubuntu-arm64', why: 'Linux ARM64: CPU build' };
  if (nvidia) {
    const drv = parseFloat(nvidia.driver ?? '0');
    const cuda = drv >= 580 ? '13.5' : '12.8';
    return { backend: 'cuda', suffix: `ubuntu-cuda-${cuda}-x64`, why: `NVIDIA GPU: CUDA ${cuda} build` };
  }
  if (amdIntel) return { backend: 'vulkan', suffix: 'ubuntu-vulkan-x64', why: `${amdIntel.vendor.toUpperCase()} GPU: Vulkan build` };
  return { backend: 'cpu', suffix: 'ubuntu-x64', why: 'No supported GPU: CPU build' };
}

export function assetNameFor(tag: string, suffix: string): string {
  const ext = suffix.startsWith('win-') ? 'zip' : 'tar.gz';
  return `llama-${tag}-bin-${suffix}.${ext}`;
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'localmax' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

export async function fetchRelease(tag: string | 'latest'): Promise<{ tag: string; assets: ReleaseAsset[] }> {
  if (tag === 'latest') {
    // llama.cpp publishes every build as a pre-release named bNNNNN
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers: ghHeaders() });
    if (!res.ok) throw new Error(`GitHub API error ${res.status} while listing llama.cpp releases`);
    const list = (await res.json()) as any[];
    const rel = list.find((r) => /^b\d+$/.test(r.tag_name) && r.assets?.length > 10);
    if (!rel) throw new Error('No llama.cpp build release found');
    return { tag: rel.tag_name, assets: rel.assets };
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for llama.cpp release ${tag}`);
  const rel = (await res.json()) as any;
  return { tag: rel.tag_name, assets: rel.assets };
}

export async function getInstalledEngine(): Promise<InstalledEngine | null> {
  try {
    const state = JSON.parse(await readFile(paths.engineState, 'utf8')) as { active: InstalledEngine | null };
    if (!state.active) return null;
    await stat(state.active.serverPath);
    return state.active;
  } catch {
    return null;
  }
}

export interface InstallOptions {
  tag?: string | 'latest';
  onProgress?: (p: Progress & { stage: string }) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

/** Download, verify and unpack the right llama.cpp build into ~/.localmax/engines/<tag>/<backend>/ */
export async function installEngine(hw: HardwareProfile, opts: InstallOptions = {}): Promise<InstalledEngine> {
  await ensureDirs();
  const log = opts.onLog ?? (() => {});
  const sel = selectEngine(hw);
  log(`Selected ${sel.suffix} (${sel.why})`);
  const release = await fetchRelease(opts.tag ?? PINNED_ENGINE_TAG);
  log(`llama.cpp ${release.tag}`);

  const wanted = [assetNameFor(release.tag, sel.suffix)];
  if (sel.runtimeAsset) wanted.push(sel.runtimeAsset);
  const assets = wanted.map((name) => {
    const a = release.assets.find((x) => x.name === name);
    if (!a) throw new Error(`Release ${release.tag} has no asset named ${name}`);
    return a;
  });

  const dir = join(paths.engines, release.tag, sel.suffix);
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const dlDir = join(paths.engines, '_downloads');

  for (const asset of assets) {
    const file = join(dlDir, asset.name);
    log(`Downloading ${asset.name} (${(asset.size / 1e6).toFixed(0)} MB)`);
    const sha = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
    if (!sha) log('Warning: GitHub did not publish a checksum for this asset; skipping verification');
    const onProgress = (p: Progress) => opts.onProgress?.({ ...p, stage: asset.name });
    try {
      // The API asset endpoint is more reliable than the release CDN link
      await downloadFile(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, file, {
        headers: { ...ghHeaders(), Accept: 'application/octet-stream' },
        expectedSha256: sha,
        expectedSize: asset.size,
        onProgress,
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      log(`API download failed (${(e as Error).message}), trying the release link`);
      await downloadFile(asset.browser_download_url, file, { expectedSha256: sha, expectedSize: asset.size, onProgress, signal: opts.signal });
    }
    log(`Verified SHA256 ${sha ? sha.slice(0, 12) + '…' : '(none)'}`);
    await extract(file, tmp);
    await rm(file, { force: true });
  }

  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const binDir = await findDirContaining(tmp, exe);
  if (!binDir) throw new Error(`llama-server not found in ${assets[0].name}`);
  if (process.platform !== 'win32') {
    for (const f of await readdir(binDir)) {
      if (f.startsWith('llama-') || f.startsWith('ggml-')) await chmod(join(binDir, f), 0o755).catch(() => {});
    }
  }
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  const finalBin = binDir.replace(tmp, dir);

  const installed: InstalledEngine = {
    tag: release.tag,
    backend: sel.backend,
    suffix: sel.suffix,
    dir: finalBin,
    serverPath: join(finalBin, exe),
    installedAt: new Date().toISOString(),
    assets: assets.map((a) => ({ name: a.name, sha256: a.digest })),
  };
  await writeFile(paths.engineState, JSON.stringify({ active: installed }, null, 2));
  log(`Installed to ${finalBin}`);
  return installed;
}

/** System tar handles .tar.gz everywhere and .zip on Windows 10+ (bsdtar), so we need no npm dependency. */
function extract(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', archive, '-C', dest], { windowsHide: true }, (err, _o, stderr) => {
      if (err) reject(new Error(`Could not unpack ${archive}: ${stderr || err.message}`));
      else resolve();
    });
  });
}

async function findDirContaining(root: string, file: string, depth = 4): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === file)) return root;
  if (depth === 0) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = await findDirContaining(join(root, e.name), file, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

export function engineTool(engine: InstalledEngine, tool: 'llama-server' | 'llama-bench' | 'llama-perplexity' | 'llama-quantize'): string {
  return join(engine.dir, process.platform === 'win32' ? `${tool}.exe` : tool);
}
