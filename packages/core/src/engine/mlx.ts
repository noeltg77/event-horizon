import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogModel, MlxVariant, RunConfig } from '../types';
import { paths } from '../paths';
import { downloadFile, type Progress } from '../download';
import { ChildServer } from './llama-server';

// MLX backend for Apple Silicon. Installed without touching the system Python:
// a pinned `uv` binary (checksum-verified from GitHub) installs a pinned `mlx-lm`, plus its
// own Python, into ~/.localmax/engines/mlx. Then `mlx_lm.server` runs as the child process.

export const PINNED_UV = '0.13.1';
export const PINNED_MLX_LM = '0.32.2';

export interface InstalledMlx {
  uvVersion: string;
  mlxLmVersion: string;
  serverPath: string;
  dir: string;
  installedAt: string;
}

const stateFile = () => join(paths.mlxEngine, 'installed.json');

export function mlxSupported(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

export async function getInstalledMlx(): Promise<InstalledMlx | null> {
  try {
    const s = JSON.parse(await readFile(stateFile(), 'utf8')) as InstalledMlx;
    await stat(s.serverPath);
    return s;
  } catch {
    return null;
  }
}

function uvEnv(): NodeJS.ProcessEnv {
  const d = paths.mlxEngine;
  return {
    ...process.env,
    UV_TOOL_DIR: join(d, 'tools'),
    UV_TOOL_BIN_DIR: join(d, 'bin'),
    UV_PYTHON_INSTALL_DIR: join(d, 'python'),
    UV_CACHE_DIR: join(d, 'cache'),
    // Use uv's own standalone Python, never the system one
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_PROGRESS: '1',
  };
}

export interface MlxInstallOptions {
  onLog?: (line: string) => void;
  onProgress?: (p: Progress & { stage: string }) => void;
  signal?: AbortSignal;
}

export async function installMlx(opts: MlxInstallOptions = {}): Promise<InstalledMlx> {
  if (!mlxSupported()) throw new Error('MLX only runs on Apple Silicon Macs.');
  const log = opts.onLog ?? (() => {});
  const d = paths.mlxEngine;
  await mkdir(d, { recursive: true });

  // 1. uv, from its GitHub release, verified against GitHub's SHA256 digest
  const rel = await fetch(`https://api.github.com/repos/astral-sh/uv/releases/tags/${PINNED_UV}`, { headers: { 'User-Agent': 'localmax', Accept: 'application/vnd.github+json' } });
  if (!rel.ok) throw new Error(`GitHub API error ${rel.status} fetching uv ${PINNED_UV}`);
  const asset = ((await rel.json()) as any).assets.find((a: any) => a.name === 'uv-aarch64-apple-darwin.tar.gz');
  if (!asset) throw new Error('uv release has no macOS arm64 build');
  const tgz = join(d, 'uv.tar.gz');
  log(`Downloading uv ${PINNED_UV} (${(asset.size / 1e6).toFixed(0)} MB)`);
  await downloadFile(`https://api.github.com/repos/astral-sh/uv/releases/assets/${asset.id}`, tgz, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'localmax' },
    expectedSha256: asset.digest?.replace(/^sha256:/, '') ?? null,
    expectedSize: asset.size,
    signal: opts.signal,
    onProgress: (p) => opts.onProgress?.({ ...p, stage: 'uv' }),
  });
  const uvDir = join(d, 'uv');
  await rm(uvDir, { recursive: true, force: true });
  await mkdir(uvDir, { recursive: true });
  await run('tar', ['-xf', tgz, '-C', uvDir, '--strip-components', '1'], {}, log);
  await rm(tgz, { force: true });
  const uv = join(uvDir, 'uv');
  await chmod(uv, 0o755);
  log('Verified and unpacked uv');

  // 2. mlx-lm and a private Python
  log(`Installing mlx-lm ${PINNED_MLX_LM} (downloads Python and MLX, a few hundred MB)`);
  await run(uv, ['tool', 'install', '--force', '--python', '3.12', `mlx-lm==${PINNED_MLX_LM}`], uvEnv(), log, opts.signal);
  const serverPath = join(d, 'bin', 'mlx_lm.server');
  await stat(serverPath);
  // Downloaded wheels aren't needed once installed
  await run(uv, ['cache', 'clean'], uvEnv(), () => {}).catch(() => {});

  const installed: InstalledMlx = { uvVersion: PINNED_UV, mlxLmVersion: PINNED_MLX_LM, serverPath, dir: d, installedAt: new Date().toISOString() };
  await writeFile(stateFile(), JSON.stringify(installed, null, 2));
  log('MLX engine ready');
  return installed;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, log: (l: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: Object.keys(env).length ? env : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (b: Buffer) => b.toString().split(/\r?\n/).filter((l) => l.trim()).forEach((l) => log(l.slice(0, 200)));
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    signal?.addEventListener('abort', () => p.kill('SIGTERM'));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.split('/').pop()} exited with code ${code}`))));
  });
}

/** Where an MLX variant's files live: ~/.localmax/models/<repo>/ (the folder mlx_lm.server loads). */
export function mlxModelDir(variant: MlxVariant): string {
  return join(paths.models, ...variant.repo.split('/'));
}

export async function isMlxDownloaded(variant: MlxVariant): Promise<boolean> {
  for (const f of variant.files) {
    try {
      if ((await stat(join(mlxModelDir(variant), f.path))).size !== f.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function mlxVariant(model: CatalogModel, id: string | undefined): MlxVariant | undefined {
  return model.mlx?.find((v) => v.id === id);
}

/** Pick the MLX build closest in precision to a GGUF quant, so speed comparisons are like-for-like. */
export function closestMlx(model: CatalogModel, bpw: number): MlxVariant | undefined {
  if (!model.mlx?.length) return undefined;
  // MLX n-bit with group size 64 stores about n + 0.5 bits per weight
  return [...model.mlx].sort((a, b) => Math.abs(a.bits + 0.5 - bpw) - Math.abs(b.bits + 0.5 - bpw))[0];
}

/** mlx_lm.server as a child process. */
export class MlxServer extends ChildServer {
  readonly backend = 'mlx' as const;
  readonly hasMetrics = false;
  protected readonly name = 'mlx_lm.server';

  constructor(
    readonly engine: InstalledMlx,
    config: RunConfig,
    readonly modelDir: string,
    port: number,
    alias: string,
    readonly draftDir?: string,
  ) {
    super(config, port, alias);
  }

  get label() {
    return { tag: `mlx-lm ${this.engine.mlxLmVersion}`, backend: 'mlx' };
  }

  /** mlx_lm.server serves its preloaded model as "default_model"; any other name is fetched from Hugging Face */
  get requestModel(): string {
    return 'default_model';
  }

  protected get binary(): string {
    return this.engine.serverPath;
  }

  protected get cwd(): string {
    return this.engine.dir;
  }

  get args(): string[] {
    const a = ['--model', this.modelDir, '--host', this.host, '--port', String(this.port), '--max-tokens', '4096', '--log-level', 'WARNING'];
    if (this.draftDir) a.push('--draft-model', this.draftDir, '--num-draft-tokens', String(this.config.spec.nMax ?? 4));
    if (this.config.kvTypeK === 'q8_0') a.push('--kv-bits', '8');
    return a;
  }
}

/** All the MLX files currently on disk, for listing and deleting. */
export async function listMlxDownloads(models: CatalogModel[]): Promise<{ modelId: string; variantId: string; sizeBytes: number }[]> {
  const out: { modelId: string; variantId: string; sizeBytes: number }[] = [];
  for (const m of models) for (const v of m.mlx ?? []) if (await isMlxDownloaded(v)) out.push({ modelId: m.id, variantId: v.id, sizeBytes: v.sizeBytes });
  return out;
}

export async function deleteMlxVariant(variant: MlxVariant): Promise<void> {
  await rm(mlxModelDir(variant), { recursive: true, force: true });
}

export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await readdir(p)).length > 0;
  } catch {
    return false;
  }
}
