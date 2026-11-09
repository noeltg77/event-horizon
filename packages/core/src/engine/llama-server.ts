import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { delimiter } from 'node:path';
import type { EngineBackendId, RunConfig } from '../types';
import type { InstalledEngine } from './engine-manager';
import { sleep } from '../util';

export interface ServerPaths {
  modelPath: string;
  /** Draft model or speculative head file */
  specPath?: string;
  /** Folder for saving and restoring prompt caches (agent workload) */
  slotSavePath?: string;
}

/** Fill in fields added in later versions, so configs saved in old benchmark records still run. */
export function normalizeConfig(c: RunConfig): RunConfig {
  return { ...c, backend: c.backend ?? 'llamacpp', workload: c.workload ?? 'chat', parallel: c.parallel ?? 1, cacheReuse: c.cacheReuse ?? 0 };
}

/**
 * Turn a RunConfig into llama-server arguments. Every flag here was checked against
 * llama.cpp b12202's common/arg.cpp (note: --draft-max/--draft-min were removed
 * upstream in favour of --spec-draft-n-max/--spec-draft-n-min).
 */
export function buildServerArgs(config: RunConfig, p: ServerPaths, net: { host: string; port: number; alias: string }): string[] {
  const args = [
    '-m', p.modelPath,
    '--host', net.host,
    '--port', String(net.port),
    '-a', net.alias,
    '-c', String(config.ctx),
    '-ngl', String(config.ngl),
    '-ctk', config.kvTypeK,
    '-ctv', config.kvTypeV,
    '-fa', config.flashAttn,
    '-t', String(config.threads),
    '-b', String(config.batch),
    '-ub', String(config.ubatch),
    '-np', String(config.parallel ?? 1),
    '--jinja',
    '--metrics',
    '--no-webui',
  ];
  // Several slots share one KV buffer, so a long request can use the space a short one isn't
  if ((config.parallel ?? 1) > 1) args.push('--kv-unified');
  if (config.cacheReuse > 0) args.push('--cache-reuse', String(config.cacheReuse));
  if (p.slotSavePath) args.push('--slot-save-path', p.slotSavePath.endsWith('/') ? p.slotSavePath : `${p.slotSavePath}/`);
  if (config.nCpuMoe > 0) args.push('--n-cpu-moe', String(config.nCpuMoe));
  if (config.moeCacheMiB > 0) args.push('--moe-cache-mib', String(config.moeCacheMiB));

  const s = config.spec;
  if (s.type === 'ngram-mod') {
    args.push('--spec-type', 'ngram-mod');
  } else if (s.type !== 'none' && p.specPath) {
    args.push('--spec-type', s.type, '--spec-draft-model', p.specPath, '--spec-draft-ngl', '99');
    if (s.nMax) args.push('--spec-draft-n-max', String(s.nMax));
    if (s.nMin) args.push('--spec-draft-n-min', String(s.nMin));
  }
  return args;
}

/** Render the args as a copy-pasteable command line for the UI. */
export function commandLine(bin: string, args: string[]): string {
  const q = (a: string) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a);
  return [q(bin), ...args.map(q)].join(' ');
}

export async function freePort(preferred?: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : port;
        srv.close(() => resolve(p));
      });
    });
  if (preferred) {
    try {
      return await tryPort(preferred);
    } catch {}
  }
  return tryPort(0);
}

export type ServerState = 'starting' | 'ready' | 'stopped' | 'crashed';

/**
 * Any inference engine localmax runs as a child process with an OpenAI-compatible HTTP API.
 * llama.cpp and MLX implement this; a Phase 4 fork would be a third implementation.
 */
export interface EngineProcess {
  readonly backend: EngineBackendId;
  readonly config: RunConfig;
  readonly port: number;
  readonly alias: string;
  readonly host: string;
  state: ServerState;
  readonly logs: string[];
  readyAt: number;
  /** Engine name and version for display */
  readonly label: { tag: string; backend: string };
  /** llama.cpp exposes /metrics and /slots; MLX doesn't */
  readonly hasMetrics: boolean;
  /** The `model` name this engine expects in API requests */
  readonly requestModel: string;
  readonly url: string;
  readonly pid: number | undefined;
  readonly command: string;
  start(): void;
  waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  tail(n: number): string;
  stop(): Promise<void>;
}

/** Spawning, logging, health checks and shutdown shared by every backend. */
export abstract class ChildServer implements EngineProcess {
  abstract readonly backend: EngineBackendId;
  abstract readonly label: { tag: string; backend: string };
  abstract readonly hasMetrics: boolean;
  readonly host = '127.0.0.1';
  state: ServerState = 'starting';
  readonly logs: string[] = [];
  private proc: ChildProcess | null = null;
  private exitPromise: Promise<number | null> | null = null;
  startedAt = 0;
  readyAt = 0;

  constructor(
    readonly config: RunConfig,
    readonly port: number,
    readonly alias: string,
  ) {}

  protected abstract get binary(): string;
  protected abstract get cwd(): string;
  abstract get args(): string[];
  protected env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return base;
  }
  protected readonly name: string = 'engine';

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get command(): string {
    return commandLine(this.binary, this.args);
  }

  get requestModel(): string {
    return this.alias;
  }

  start(): void {
    this.startedAt = Date.now();
    this.proc = spawn(this.binary, this.args, { cwd: this.cwd, env: this.env({ ...process.env }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logs.push(line);
        if (this.logs.length > 800) this.logs.splice(0, this.logs.length - 800);
      }
    };
    this.proc.stdout?.on('data', onData);
    this.proc.stderr?.on('data', onData);
    this.exitPromise = new Promise((resolve) => {
      this.proc!.on('exit', (code) => {
        this.state = this.state === 'stopped' ? 'stopped' : 'crashed';
        resolve(code);
      });
      this.proc!.on('error', (err) => {
        this.logs.push(`spawn error: ${err.message}`);
        this.state = 'crashed';
        resolve(-1);
      });
    });
  }

  /** Poll /health until the model is loaded. Rejects with the tail of the log if the process dies. */
  async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Cancelled');
      if (this.state === 'crashed') throw new Error(`${this.name} exited while loading.\n${this.tail(12)}`);
      try {
        const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          this.state = 'ready';
          this.readyAt = Date.now();
          return;
        }
      } catch {}
      await sleep(400);
    }
    throw new Error(`${this.name} did not become ready within ${Math.round(timeoutMs / 1000)}s.\n${this.tail(8)}`);
  }

  tail(n: number): string {
    return this.logs.slice(-n).join('\n');
  }

  async stop(): Promise<void> {
    if (!this.proc || this.state === 'stopped') return;
    const wasRunning = this.state !== 'crashed';
    this.state = 'stopped';
    if (wasRunning) {
      this.proc.kill('SIGTERM');
      const timer = setTimeout(() => this.proc?.kill('SIGKILL'), 5000);
      await this.exitPromise;
      clearTimeout(timer);
    }
  }
}

/** A running llama-server child process. */
export class LlamaServer extends ChildServer {
  readonly backend = 'llamacpp' as const;
  readonly hasMetrics = true;
  protected readonly name = 'llama-server';

  constructor(
    readonly engine: InstalledEngine,
    config: RunConfig,
    readonly paths: ServerPaths,
    port: number,
    alias: string,
    /** Use these arguments verbatim instead of the planner's (e.g. stock llama.cpp defaults for comparison) */
    readonly rawArgs?: string[],
  ) {
    super(config, port, alias);
  }

  get label() {
    return { tag: this.engine.tag, backend: this.engine.backend };
  }

  protected get binary(): string {
    return this.engine.serverPath;
  }

  protected get cwd(): string {
    return this.engine.dir;
  }

  protected env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // Windows finds the CUDA/ggml DLLs next to the exe via PATH
    return { ...base, PATH: `${this.engine.dir}${delimiter}${base.PATH ?? ''}` };
  }

  get args(): string[] {
    return this.rawArgs ?? buildServerArgs(this.config, this.paths, { host: this.host, port: this.port, alias: this.alias });
  }
}
