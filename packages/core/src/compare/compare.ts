import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import type { CatalogModel, CatalogQuant, HardwareProfile, RunConfig } from '../types';
import { requireModel, getQuant } from '../catalog';
import { getHardware } from '../hardware/profiler';
import { plan as makePlan } from '../planner/planner';
import { getInstalledEngine, installEngine, type InstalledEngine } from '../engine/engine-manager';
import { LlamaServer, freePort, normalizeConfig } from '../engine/llama-server';
import { createEngineProcess } from '../engine/factory';
import { isMlxDownloaded, mlxVariant } from '../engine/mlx';
import { isQuantDownloaded, localPath, modelEntryPath } from '../models/store';
import { estimateMlxQuality, qualityOf, score as scoreOf } from '../quality';
import { loadMeasuredQuality } from '../quality-measure';
import { listBenchmarks } from '../benchmarks';
import { COMPARE_POOLS } from '../tuner/tuner';
import { paths, ensureDirs } from '../paths';
import { formatBytes } from '../util';
import type { EngineSession } from '../session';
import { MemorySampler, measureOllama, measureOpenAI, median, type PromptResult } from './measure';

export type ContenderId = 'localmax' | 'llamacpp' | 'lmstudio' | 'ollama';

export const PROMPT_LABELS = ['Explain (prose)', 'Write code', 'Edit code'];

export interface ContenderStatus {
  id: ContenderId;
  label: string;
  /** Installed and usable for this model */
  available: boolean;
  version: string | null;
  /** One line on the current state */
  detail: string;
  /** What localmax will do to set it up (so nothing happens by surprise) */
  setup: string | null;
  /** How to make it available, when it isn't */
  hint: string | null;
}

export type CompareMode = 'same-file' | 'best';

export interface ContenderResult {
  id: ContenderId;
  label: string;
  version: string | null;
  ok: boolean;
  error: string | null;
  /** How this contender was configured */
  configNote: string;
  /** Which weights it ran (quant or MLX build) */
  weights: string;
  qualityPct: number;
  qualitySource: 'native' | 'measured' | 'estimate';
  /** Speed × quality factor: what "best setup" mode ranks on */
  score: number;
  genTps: number;
  ttftMs: number;
  engineGenTps: number | null;
  peakMemBytes: number;
  loadMs: number;
  prompts: PromptResult[];
}

export interface CompareRecord {
  schema: 1;
  id: string;
  createdAt: string;
  model: { id: string; name: string; quantId: string; sizeBytes: number };
  mode?: CompareMode;
  ctx: number;
  maxTokens: number;
  rounds: number;
  hardware: { cpu: string; gpus: string[]; ramGB: number; os: string };
  results: ContenderResult[];
}

export type CompareEvent =
  | { type: 'stage'; contender: ContenderId | null; detail: string }
  | { type: 'log'; line: string }
  | { type: 'result'; result: ContenderResult };

interface Prepared {
  weights?: string;
  qualityPct?: number;
  qualitySource?: 'native' | 'measured' | 'estimate';
  protocol: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  version: string | null;
  configNote: string;
  loadMs: number;
  sampler: MemorySampler;
  cleanup: () => Promise<void>;
}

interface PrepareCtx {
  mode: CompareMode;
  model: CatalogModel;
  quant: CatalogQuant;
  ctx: number;
  engine: InstalledEngine;
  hw: HardwareProfile;
  log: (line: string) => void;
  signal?: AbortSignal;
}

const LABELS: Record<ContenderId, string> = {
  localmax: 'localmax (tuned)',
  llamacpp: 'llama.cpp defaults',
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
};

// ---------------------------------------------------------------- helpers

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}` });
      });
    } catch (e) {
      resolve({ ok: false, out: (e as Error).message });
    }
  });
}

// ---------------------------------------------------------------- localmax + plain llama.cpp

/**
 * localmax's configuration for the test. Same-file mode: the tuned llama.cpp config for this
 * exact quant. Best mode: whatever the tuner picked as the overall winner for this model,
 * which may be a different quant or the MLX backend.
 */
async function tunedConfig(model: CatalogModel, quant: CatalogQuant, ctx: number, hw: HardwareProfile, mode: CompareMode): Promise<{ config: RunConfig; note: string }> {
  const recs = (await listBenchmarks(200)).filter((b) => b.model.id === model.id && b.winner);
  if (mode === 'best') {
    for (const rec of recs) {
      const c = normalizeConfig(rec.winner!.config);
      if (await configOnDisk(model, c)) return { config: { ...c, ctx }, note: `Tuner’s overall winner from ${rec.createdAt.slice(0, 10)} (${rec.winner!.label})` };
    }
    const p = makePlan(hw, model, { mode: 'balanced', ctx });
    if (await configOnDisk(model, p.config)) return { config: p.config, note: 'Planner’s own pick (not tuned yet)' };
  }
  for (const rec of recs) {
    // Same file: use the best llama.cpp trial for this quant, even if MLX won overall
    const t = rec.trials.filter((x) => x.ok && normalizeConfig(x.config).backend === 'llamacpp' && x.config.quantId === quant.id).sort((a, b) => (b.score ?? b.genTps) - (a.score ?? a.genTps))[0];
    if (t) return { config: { ...normalizeConfig(t.config), ctx }, note: `Tuned config from ${rec.createdAt.slice(0, 10)} (${t.label})` };
  }
  const p = makePlan(hw, model, { mode: 'balanced', ctx, quantId: quant.id, memory: 'total' });
  return { config: p.config, note: 'Planner config (not tuned yet: run “Tune & run” first for the best result)' };
}

async function configOnDisk(model: CatalogModel, c: RunConfig): Promise<boolean> {
  if (c.backend === 'mlx') {
    const v = mlxVariant(model, c.mlxVariant);
    return !!v && (await isMlxDownloaded(v));
  }
  const q = model.quants.find((x) => x.id === c.quantId);
  return !!q && (await isQuantDownloaded(model, q));
}

async function prepareLlama(c: PrepareCtx, kind: 'localmax' | 'llamacpp'): Promise<Prepared> {
  const port = await freePort();
  let server: Awaited<ReturnType<typeof createEngineProcess>>;
  let note: string;
  let weights = c.quant.id;
  let quality: { pct: number; source: 'native' | 'measured' | 'estimate' } | undefined;
  if (kind === 'localmax') {
    const { config, note: n } = await tunedConfig(c.model, c.quant, c.ctx, c.hw, c.mode);
    // Benchmarks measure single-stream speed, whatever workload profile was tuned
    server = await createEngineProcess(c.model, { ...config, parallel: 1, cacheReuse: 0 }, port, { llama: c.engine });
    note = `${n}. ${describeConfig(server.config)}`;
    const measured = await loadMeasuredQuality();
    if (server.config.backend === 'mlx') {
      const v = mlxVariant(c.model, server.config.mlxVariant)!;
      weights = `MLX ${v.bits}-bit`;
      quality = { pct: estimateMlxQuality(c.model, v.bits), source: 'estimate' };
    } else {
      weights = server.config.quantId;
      quality = qualityOf(c.model, getQuant(c.model, server.config.quantId), measured);
    }
  } else {
    // What you get from `llama-server -m model.gguf -c <ctx>`: no tuning at all
    const modelPath = modelEntryPath(c.model, c.quant);
    const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-a', c.model.id, '-c', String(c.ctx)];
    const placeholder = makePlan(c.hw, c.model, { mode: 'balanced', ctx: c.ctx, quantId: c.quant.id, memory: 'total' }).config;
    server = new LlamaServer(c.engine, placeholder, { modelPath }, port, c.model.id, args);
    note = `llama-server with only -m and -c ${c.ctx}: every other setting left at its default`;
  }
  const sampler = new MemorySampler({ pid: () => server.pid });
  const t0 = Date.now();
  server.start();
  sampler.start();
  await server.waitReady(180_000, c.signal);
  return {
    protocol: 'openai',
    baseUrl: `${server.url}/v1`,
    model: server.requestModel,
    version: server.backend === 'mlx' ? server.label.tag : `llama.cpp ${c.engine.tag}`,
    configNote: note,
    loadMs: Date.now() - t0,
    sampler,
    weights,
    qualityPct: quality?.pct,
    qualitySource: quality?.source,
    cleanup: () => server.stop(),
  };
}

function describeConfig(c: RunConfig): string {
  if (c.backend === 'mlx') return `MLX ${c.mlxVariant ?? ''} build · KV ${c.kvTypeK === 'q8_0' ? '8-bit' : 'full precision'}`;
  const bits = [`ngl ${c.ngl}`, `KV ${c.kvTypeK}`, `flash-attn ${c.flashAttn}`, `${c.threads} threads`, `ubatch ${c.ubatch}`];
  if (c.nCpuMoe) bits.push(`n-cpu-moe ${c.nCpuMoe}`);
  if (c.spec.type !== 'none') bits.push(`spec ${c.spec.type}`);
  return bits.join(' · ');
}

// ---------------------------------------------------------------- LM Studio

function lmsBin(): string | null {
  const home = homedir();
  const candidates = process.platform === 'win32' ? [join(home, '.lmstudio', 'bin', 'lms.exe')] : [join(home, '.lmstudio', 'bin', 'lms'), '/usr/local/bin/lms', '/opt/homebrew/bin/lms'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Turn lms's boxed, coloured error output into one plain sentence. */
async function explainLmsError(raw: string): Promise<string> {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[│┌┐└┘─]/g, ' ').replace(/\s+/g, ' ');
  const arch = text.match(/unknown model architecture: '([^']+)'/);
  if (arch) {
    const runtime = await lmStudioRuntime();
    return `LM Studio’s llama.cpp runtime${runtime ? ` (${runtime})` : ''} doesn’t support this model’s architecture (${arch[1]}) yet. Update LM Studio and select its newest llama.cpp runtime, or compare with a model on an older architecture such as Qwen3 4B 2507.`;
  }
  const cause = text.match(/CAUSE\s+(.*?)\s+(<\/> STACK TRACE|$)/)?.[1] ?? text.match(/Error\s+(.*?)\s+error: found/)?.[1];
  return `LM Studio could not load the model: ${(cause ?? text).trim().slice(0, 300)}`;
}

async function lmStudioRuntime(): Promise<string | null> {
  try {
    const prefs = JSON.parse(await readFile(join(homedir(), '.lmstudio', '.internal', 'backend-preferences-v1.json'), 'utf8')) as { model_format: string; version: string }[];
    const v = prefs.find((p) => p.model_format === 'gguf')?.version;
    return v ? `runtime ${v}` : null;
  } catch {
    return null;
  }
}

async function lmStudioVersion(lms: string): Promise<string> {
  if (process.platform === 'darwin') {
    const r = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '/Applications/LM Studio.app/Contents/Info.plist'], 5000);
    if (r.ok && /\d/.test(r.out)) return `LM Studio ${r.out.trim()}`;
  }
  const r = await run(lms, ['version'], 10_000);
  // eslint-disable-next-line no-control-regex
  const v = r.out.replace(/\x1b\[[0-9;]*m/g, '').match(/v(\d+\.\d+\.\d+)/)?.[1];
  return v ? `LM Studio (lms ${v})` : 'LM Studio';
}

async function lmsServerPort(lms: string): Promise<number | null> {
  const r = await run(lms, ['server', 'status'], 10_000);
  const m = r.out.match(/port[^\d]*(\d{2,5})/i);
  if (/not running|is off|stopped/i.test(r.out)) return null;
  return m ? Number(m[1]) : r.ok && /running|on/i.test(r.out) ? 1234 : null;
}

async function lmsFind(lms: string, quant: CatalogQuant): Promise<string | null> {
  const r = await run(lms, ['ls', '--json'], 15_000);
  try {
    const list = JSON.parse(r.out.slice(r.out.indexOf('['))) as { modelKey: string; path: string; type: string }[];
    const file = basename(quant.files[0].path);
    // `lms load --exact` matches on the full path, not the model key
    return list.find((m) => m.path.endsWith(file))?.path ?? null;
  } catch {
    return null;
  }
}

async function detectLmStudio(model: CatalogModel, quant: CatalogQuant): Promise<ContenderStatus> {
  const lms = lmsBin();
  const base = { id: 'lmstudio' as const, label: LABELS.lmstudio, version: null };
  if (!lms) {
    return { ...base, available: false, detail: 'Not installed', setup: null, hint: 'Install LM Studio from lmstudio.ai, open it once, then come back.' };
  }
  if (quant.files.length > 1) {
    return { ...base, available: false, detail: 'Split model files', setup: null, hint: 'Pick a single-file quant for this comparison.' };
  }
  const [port, key] = await Promise.all([lmsServerPort(lms), lmsFind(lms, quant)]);
  const steps = [port ? null : 'start the LM Studio server', key ? null : 'link this exact GGUF into LM Studio (a shortcut, no extra disk space)', `load it with ${'the same'} context length, then unload it afterwards`].filter(Boolean);
  return {
    ...base,
    available: true,
    detail: `${port ? `Server running on port ${port}` : 'Server not running'} · ${key ? 'model already in LM Studio' : 'model not in LM Studio yet'}`,
    setup: `localmax will ${steps.join(', ')}.`,
    hint: null,
  };
}

async function prepareLmStudio(c: PrepareCtx): Promise<Prepared> {
  const lms = lmsBin();
  if (!lms) throw new Error('LM Studio is not installed');
  let port = await lmsServerPort(lms);
  let startedServer = false;
  if (!port) {
    c.log('Starting the LM Studio server');
    const r = await run(lms, ['server', 'start'], 60_000);
    if (!r.ok) throw new Error(`Could not start the LM Studio server: ${r.out.slice(0, 300)}`);
    startedServer = true;
    port = (await lmsServerPort(lms)) ?? 1234;
  }
  try {
    return await loadInLmStudio(c, lms, port, startedServer);
  } catch (e) {
    // Leave LM Studio as we found it
    await run(lms, ['unload', 'localmax-bench'], 30_000);
    if (startedServer) await run(lms, ['server', 'stop'], 30_000);
    throw e;
  }
}

async function loadInLmStudio(c: PrepareCtx, lms: string, port: number, startedServer: boolean): Promise<Prepared> {
  let key = await lmsFind(lms, c.quant);
  if (!key) {
    const file = modelEntryPath(c.model, c.quant);
    c.log(`Linking ${basename(file)} into LM Studio (symbolic link, no copy)`);
    const r = await run(lms, ['import', file, '--symbolic-link', '--yes', '--user-repo', c.model.repo], 60_000);
    if (!r.ok) throw new Error(`lms import failed: ${r.out.slice(0, 300)}`);
    // LM Studio indexes new files in the background; give it a few seconds
    for (let i = 0; i < 20 && !key; i++) {
      await new Promise((r) => setTimeout(r, 750));
      key = await lmsFind(lms, c.quant);
    }
    if (!key) throw new Error('LM Studio did not list the model after importing it');
  }
  const version = await lmStudioVersion(lms);
  await run(lms, ['unload', 'localmax-bench'], 20_000);
  const loaded = await run(lms, ['ps', '--json'], 10_000);
  if (/"identifier"/.test(loaded.out)) c.log('Note: LM Studio has other models loaded, which use memory during this test');

  const sampler = new MemorySampler({ pattern: /LM Studio|lmstudio|llmworker/i });
  await sampler.takeBaseline();
  sampler.start();
  c.log(`Loading ${key} in LM Studio with ${c.ctx.toLocaleString()} context`);
  const t0 = Date.now();
  const r = await run(lms, ['load', key, '--context-length', String(c.ctx), '--identifier', 'localmax-bench', '--exact', '--yes'], 300_000);
  if (!r.ok) {
    await sampler.stop();
    throw new Error(await explainLmsError(r.out));
  }
  return {
    protocol: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'localmax-bench',
    version,
    configNote: `LM Studio’s own runtime and default settings, context ${c.ctx.toLocaleString()}, same GGUF file`,
    loadMs: Date.now() - t0,
    sampler,
    cleanup: async () => {
      await run(lms, ['unload', 'localmax-bench'], 60_000);
      if (startedServer) await run(lms, ['server', 'stop'], 30_000);
    },
  };
}

// ---------------------------------------------------------------- Ollama

const OLLAMA = process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, '')}` : 'http://127.0.0.1:11434';

function ollamaName(model: CatalogModel, quant: CatalogQuant): string {
  return `localmax-${model.id}-${quant.id}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

async function ollamaVersion(): Promise<string | null> {
  try {
    const r = await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()) as any).version ?? 'unknown' : null;
  } catch {
    return null;
  }
}

async function ollamaHas(name: string): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function detectOllama(model: CatalogModel, quant: CatalogQuant): Promise<ContenderStatus> {
  const base = { id: 'ollama' as const, label: LABELS.ollama };
  const version = await ollamaVersion();
  if (!version) {
    const installed = (await run(process.platform === 'win32' ? 'where' : 'which', ['ollama'], 3000)).ok || existsSync('/Applications/Ollama.app');
    return {
      ...base,
      version: null,
      available: false,
      detail: installed ? 'Installed but not running' : 'Not installed',
      setup: null,
      hint: installed ? 'Open the Ollama app (or run `ollama serve`), then refresh.' : 'Install Ollama from ollama.com, open it, then refresh.',
    };
  }
  if (quant.files.length > 1) return { ...base, version, available: false, detail: 'Split model files', setup: null, hint: 'Ollama can’t import split GGUFs; pick a single-file quant.' };
  const has = await ollamaHas(ollamaName(model, quant));
  return {
    ...base,
    version,
    available: true,
    detail: `Ollama ${version} running · ${has ? 'model already imported' : 'model not imported yet'}`,
    setup: has ? 'localmax will load it with the same context length (num_ctx) and unload it afterwards.' : `localmax will import this exact GGUF into Ollama. Ollama keeps its own copy, so this uses ${formatBytes(quant.sizeBytes)} more disk.`,
    hint: null,
  };
}

async function prepareOllama(c: PrepareCtx): Promise<Prepared> {
  const version = await ollamaVersion();
  if (!version) throw new Error('Ollama is not running');
  const name = ollamaName(c.model, c.quant);
  if (!(await ollamaHas(name))) {
    const f = c.quant.files[0];
    if (!f.sha256) throw new Error('No checksum for this file, so it can’t be imported into Ollama');
    const digest = `sha256:${f.sha256}`;
    const head = await fetch(`${OLLAMA}/api/blobs/${digest}`, { method: 'HEAD' });
    if (!head.ok) {
      c.log(`Copying ${formatBytes(f.size)} into Ollama`);
      const body = Readable.toWeb(createReadStream(localPath(c.model, f))) as unknown as ReadableStream;
      const up = await fetch(`${OLLAMA}/api/blobs/${digest}`, { method: 'POST', body, duplex: 'half', signal: c.signal } as RequestInit & { duplex: 'half' });
      if (!up.ok) throw new Error(`Ollama blob upload failed: ${up.status} ${await up.text()}`);
    }
    const cr = await fetch(`${OLLAMA}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, files: { [basename(f.path)]: digest }, stream: false }),
    });
    if (!cr.ok) throw new Error(`Ollama create failed: ${cr.status} ${await cr.text()}`);
  }
  const sampler = new MemorySampler({ pattern: /ollama/i });
  await sampler.takeBaseline();
  sampler.start();
  const t0 = Date.now();
  const load = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, prompt: '', keep_alive: '10m', options: { num_ctx: c.ctx } }),
    signal: c.signal,
  });
  if (!load.ok) {
    await sampler.stop();
    throw new Error(`Ollama could not load the model: ${await load.text()}`);
  }
  return {
    protocol: 'ollama',
    baseUrl: OLLAMA,
    model: name,
    version: `Ollama ${version}`,
    configNote: `Ollama’s default settings, num_ctx ${c.ctx.toLocaleString()}, same GGUF file`,
    loadMs: Date.now() - t0,
    sampler,
    cleanup: async () => {
      await fetch(`${OLLAMA}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, keep_alive: 0 }) }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- public API

export async function detectContenders(modelId: string, quantId: string): Promise<ContenderStatus[]> {
  const model = requireModel(modelId);
  const quant = getQuant(model, quantId);
  const engine = await getInstalledEngine();
  const llamaStatus = (id: 'localmax' | 'llamacpp'): ContenderStatus => ({
    id,
    label: LABELS[id],
    available: true,
    version: engine ? `llama.cpp ${engine.tag}` : null,
    detail: id === 'localmax' ? 'Your tuned setup for this machine' : 'Stock llama-server, no tuning: the baseline both apps build on',
    setup: engine ? null : 'localmax will install the llama.cpp engine first.',
    hint: null,
  });
  const [lm, ol] = await Promise.all([detectLmStudio(model, quant), detectOllama(model, quant)]);
  return [llamaStatus('localmax'), llamaStatus('llamacpp'), lm, ol];
}

export interface CompareOptions {
  modelId: string;
  quantId: string;
  ctx: number;
  contenders: ContenderId[];
  /** same-file: everyone runs the chosen GGUF. best: localmax runs its own tuned pick. */
  mode?: CompareMode;
  maxTokens?: number;
  /** Times each prompt is run; the median is reported so one hiccup can't decide the result */
  rounds?: number;
  session?: EngineSession;
  onEvent?: (e: CompareEvent) => void;
  signal?: AbortSignal;
}

export async function runComparison(opts: CompareOptions): Promise<CompareRecord> {
  const emit = opts.onEvent ?? (() => {});
  const log = (line: string) => emit({ type: 'log', line });
  const model = requireModel(opts.modelId);
  const quant = getQuant(model, opts.quantId);
  const maxTokens = opts.maxTokens ?? 256;
  const rounds = Math.max(1, Math.min(10, opts.rounds ?? 3));
  const mode: CompareMode = opts.mode ?? 'same-file';
  const measured = await loadMeasuredQuality();
  const fileQuality = qualityOf(model, quant, measured);
  if (!(await isQuantDownloaded(model, quant))) throw new Error(`Download ${model.name} ${quant.id} first.`);

  // Only one engine in memory at a time, and refuse to run a test that would swap
  if (opts.session) {
    const st = opts.session.status();
    if (st.state === 'starting' || st.state === 'waking') throw new Error('A model is still loading. Wait for it to finish first.');
    if (st.state === 'ready') {
      log('Unloading your running model so every engine starts with the same free memory');
      await opts.session.park();
      // Give the OS a moment to reclaim the memory before we measure what's free
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  const hw = await getHardware({ refresh: true });
  const fit = makePlan(hw, model, { mode: 'balanced', ctx: opts.ctx, quantId: quant.id });
  if (fit.fit === 'no-fit') {
    throw new Error(
      `Not enough free memory for a fair test: ${model.name} ${quant.id} at ${opts.ctx.toLocaleString()} context needs about ${formatBytes(fit.memory.gpuBytes + fit.memory.ramBytes)} and ${formatBytes(fit.memory.freeNowBytes)} is free. Close some apps or lower the context.`,
    );
  }

  let engine = await getInstalledEngine();
  if (!engine) {
    log('Installing the llama.cpp engine');
    engine = await installEngine(hw, { onLog: log, signal: opts.signal });
  }

  const results: ContenderResult[] = [];
  for (const id of opts.contenders) {
    if (opts.signal?.aborted) throw new Error('Cancelled');
    emit({ type: 'stage', contender: id, detail: `Setting up ${LABELS[id]}` });
    const ctx: PrepareCtx = { mode, model, quant, ctx: opts.ctx, engine, hw, log, signal: opts.signal };
    let prepared: Prepared | null = null;
    const result: ContenderResult = {
      id,
      label: LABELS[id],
      version: null,
      ok: false,
      error: null,
      configNote: '',
      weights: quant.id,
      qualityPct: fileQuality.pct,
      qualitySource: fileQuality.source,
      score: 0,
      genTps: 0,
      ttftMs: 0,
      engineGenTps: null,
      peakMemBytes: 0,
      loadMs: 0,
      prompts: [],
    };
    try {
      prepared =
        id === 'localmax' || id === 'llamacpp' ? await prepareLlama(ctx, id) : id === 'lmstudio' ? await prepareLmStudio(ctx) : await prepareOllama(ctx);
      result.version = prepared.version;
      result.configNote = prepared.configNote;
      if (prepared.weights) result.weights = prepared.weights;
      if (prepared.qualityPct != null) {
        result.qualityPct = prepared.qualityPct;
        result.qualitySource = prepared.qualitySource ?? 'estimate';
      }
      result.loadMs = prepared.loadMs;
      const p = prepared;
      const measure = (prompt: string, n: number) =>
        p.protocol === 'ollama'
          ? measureOllama(p.baseUrl, p.model, prompt, n, opts.ctx, opts.signal)
          : measureOpenAI(p.baseUrl, p.model, prompt, n, { chat_template_kwargs: { enable_thinking: false } }, opts.signal);
      emit({ type: 'stage', contender: id, detail: `Warming up ${LABELS[id]}` });
      await measure('Say hello.', 16);
      for (let i = 0; i < COMPARE_POOLS.length; i++) {
        const runs: PromptResult[] = [];
        for (let k = 0; k < rounds; k++) {
          emit({ type: 'stage', contender: id, detail: `${LABELS[id]}: ${PROMPT_LABELS[i]}${rounds > 1 ? ` (${k + 1}/${rounds})` : ''}` });
          // A different prompt each round: repeating one lets n-gram lookahead replay its earlier answer
          runs.push(await measure(COMPARE_POOLS[i][k % COMPARE_POOLS[i].length], maxTokens));
        }
        const samples = runs.map((r) => r.genTps);
        const med = median(samples);
        const pick = runs.reduce((a, b) => (Math.abs(b.genTps - med) < Math.abs(a.genTps - med) ? b : a));
        const spread = med > 0 ? (Math.max(...samples) - Math.min(...samples)) / med : 0;
        const agg: PromptResult = {
          ...pick,
          prompt: PROMPT_LABELS[i],
          genTps: Math.round(med * 10) / 10,
          // Later rounds can reuse a cached prompt, so time-to-first-token comes from the cold first run only
          ttftMs: runs[0].ttftMs,
          engineGenTps: runs.some((r) => r.engineGenTps) ? Math.round(median(runs.map((r) => r.engineGenTps ?? 0)) * 10) / 10 : null,
          samples,
          spread: Math.round(spread * 1000) / 1000,
        };
        result.prompts.push(agg);
        log(`${LABELS[id]} · ${PROMPT_LABELS[i]}: ${agg.genTps} tok/s (runs: ${samples.join(', ')}), first token ${agg.ttftMs} ms`);
      }
      result.genTps = Math.round(median(result.prompts.map((x) => x.genTps)) * 10) / 10;
      result.ttftMs = Math.round(median(result.prompts.map((x) => x.ttftMs)));
      const eng = result.prompts.map((x) => x.engineGenTps ?? 0);
      result.engineGenTps = eng.some((x) => x > 0) ? Math.round(median(eng) * 10) / 10 : null;
      result.score = scoreOf(result.genTps, result.qualityPct);
      result.ok = true;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      result.error = (e as Error).message.split('\n').slice(0, 3).join(' ');
      log(`${LABELS[id]} failed: ${result.error}`);
    } finally {
      if (prepared) {
        result.peakMemBytes = await prepared.sampler.stop();
        emit({ type: 'stage', contender: id, detail: `Unloading ${LABELS[id]}` });
        await prepared.cleanup().catch(() => {});
      }
    }
    results.push(result);
    emit({ type: 'result', result });
  }

  const rec: CompareRecord = {
    schema: 1,
    id: `compare_${new Date().toISOString().replace(/[:.]/g, '-')}_${model.id}`,
    createdAt: new Date().toISOString(),
    model: { id: model.id, name: model.name, quantId: quant.id, sizeBytes: quant.sizeBytes },
    mode,
    ctx: opts.ctx,
    maxTokens,
    rounds,
    hardware: { cpu: hw.cpu.model, gpus: hw.gpus.map((g) => g.model), ramGB: Math.round(hw.memory.totalBytes / 1024 ** 3), os: hw.os.name },
    results,
  };
  await ensureDirs();
  await writeFile(join(paths.benchmarks, `${rec.id}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

export async function listComparisons(limit = 30): Promise<CompareRecord[]> {
  await ensureDirs();
  const files = (await readdir(paths.benchmarks)).filter((f) => f.startsWith('compare_') && f.endsWith('.json')).sort().reverse().slice(0, limit);
  const out: CompareRecord[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await readFile(join(paths.benchmarks, f), 'utf8')));
    } catch {}
  }
  return out;
}
