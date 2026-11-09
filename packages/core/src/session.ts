import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchmarkRecord, CatalogModel, HardwareProfile, Plan, PlanGoal, RunConfig, TrialResult, WorkloadKey } from './types';
import { requireModel, getQuant } from './catalog';
import { getHardware } from './hardware/profiler';
import { plan as makePlan, WORKLOADS } from './planner/planner';
import { getInstalledEngine, installEngine, type InstalledEngine } from './engine/engine-manager';
import { freePort, normalizeConfig, type EngineProcess } from './engine/llama-server';
import { createEngineProcess } from './engine/factory';
import { getInstalledMlx, installMlx, isMlxDownloaded, mlxSupported, mlxVariant } from './engine/mlx';
import { extraFilesFor, pullFiles, isQuantDownloaded } from './models/store';
import { mlxCandidateFor, pickWinner, runTrials, tuneCandidates } from './tuner/tuner';
import { saveBenchmark, benchmarkId } from './benchmarks';
import { estimateMlxQuality, qualityOf, score } from './quality';
import { loadMeasuredQuality } from './quality-measure';
import { loadCalibration, recordCalibration } from './calibration';
import { paths } from './paths';

export type SessionEvent =
  | { type: 'stage'; stage: 'engine' | 'plan' | 'download' | 'tune' | 'start' | 'ready'; detail: string }
  | { type: 'progress'; received: number; total: number; speed: number; label: string }
  | { type: 'log'; line: string }
  | { type: 'trialStart'; label: string; index: number; total: number }
  | { type: 'trial'; result: TrialResult }
  | { type: 'plan'; plan: Plan };

export interface RunOptions {
  modelId: string;
  goal: PlanGoal;
  tune: boolean;
  /** Also benchmark an MLX build (Apple Silicon). Installs the MLX engine and downloads the build if needed. */
  tryMlx?: boolean;
  /** Override the planner config entirely (e.g. a preset) */
  config?: RunConfig;
  onEvent?: (e: SessionEvent) => void;
  signal?: AbortSignal;
}

export interface Headline {
  genTps: number;
  promptTps: number;
  qualityPct: number;
  qualitySource: 'native' | 'estimate' | 'measured';
  score: number;
  tuned: boolean;
  /** Per-workload speeds of the winning config, when tuned */
  workloads?: TrialResult['workloads'];
  bestPerWorkload?: Partial<Record<WorkloadKey, string>>;
}

export interface SessionStatus {
  /**
   * idle: nothing loaded. starting: run in progress. ready: loaded and serving.
   * parked: unloaded after sitting idle; reloads on the next request. waking: reloading after parking.
   */
  state: 'idle' | 'starting' | 'ready' | 'crashed' | 'parked' | 'waking';
  modelId: string | null;
  modelName: string | null;
  config: RunConfig | null;
  plan: Plan | null;
  headline: Headline | null;
  trials: TrialResult[];
  upstream: string | null;
  pid: number | null;
  command: string | null;
  startedAt: number | null;
  engine: { tag: string; backend: string } | null;
  /** Unload after this many idle minutes (0 = never) */
  keepAliveMinutes: number;
  /** When the last request finished (or started), for the idle countdown */
  lastUsedAt: number | null;
  parkedAt: number | null;
}

interface Parked {
  model: CatalogModel;
  config: RunConfig;
  engine: InstalledEngine | undefined;
  label: { tag: string; backend: string };
  loadTimeoutMs: number;
  /** Prompt-cache files saved when unloading (agent workload) */
  savedSlots: string[];
}

/** Owns the one engine process that is serving requests. */
export class EngineSession {
  private server: EngineProcess | null = null;
  private model: CatalogModel | null = null;
  private currentPlan: Plan | null = null;
  private headline: Headline | null = null;
  private trials: TrialResult[] = [];
  private starting = false;
  private parked: Parked | null = null;
  private parkedAt: number | null = null;
  private waking: Promise<string> | null = null;
  private inflight = 0;
  private lastUsedAt = Date.now();
  private loadTimeoutMs = 120_000;
  private llamaEngine: InstalledEngine | undefined;
  private idleTimer: ReturnType<typeof setInterval>;
  /** Unload the model after this many idle minutes so it stops holding memory (0 = never) */
  keepAliveMinutes: number;

  constructor(opts: { keepAliveMinutes?: number } = {}) {
    this.keepAliveMinutes = opts.keepAliveMinutes ?? 10;
    this.idleTimer = setInterval(() => void this.checkIdle(), 15_000);
    this.idleTimer.unref?.();
  }

  status(): SessionStatus {
    const s = this.server;
    const state: SessionStatus['state'] = this.starting
      ? 'starting'
      : this.waking
        ? 'waking'
        : this.parked
          ? 'parked'
          : !s
            ? 'idle'
            : s.state === 'ready'
              ? 'ready'
              : s.state === 'crashed'
                ? 'crashed'
                : 'starting';
    return {
      state,
      modelId: this.model?.id ?? null,
      modelName: this.model?.name ?? null,
      config: s?.config ?? this.parked?.config ?? null,
      plan: this.currentPlan,
      headline: this.headline,
      trials: this.trials,
      upstream: s && s.state === 'ready' ? s.url : null,
      pid: s?.pid ?? null,
      command: s?.command ?? null,
      startedAt: s?.readyAt || null,
      engine: s ? s.label : (this.parked?.label ?? null),
      keepAliveMinutes: this.keepAliveMinutes,
      lastUsedAt: this.model ? this.lastUsedAt : null,
      parkedAt: this.parkedAt,
    };
  }

  get upstream(): string | null {
    return this.server?.state === 'ready' ? this.server.url : null;
  }

  get pid(): number | undefined {
    return this.server?.pid;
  }

  /** The model name the running engine expects, when it differs from the catalog id (MLX) */
  get requestModel(): string | null {
    const s = this.server;
    return s && s.requestModel !== s.alias ? s.requestModel : null;
  }

  /** llama.cpp exposes Prometheus metrics and slot state; MLX doesn't */
  get hasMetrics(): boolean {
    return !!this.server?.hasMetrics;
  }

  logs(n = 200): string[] {
    return this.server?.logs.slice(-n) ?? [];
  }

  /** Mark the start and end of an API request, so we never unload mid-reply and the idle clock resets. */
  begin(): void {
    this.inflight++;
    this.lastUsedAt = Date.now();
  }

  end(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.lastUsedAt = Date.now();
  }

  private async checkIdle(): Promise<void> {
    const s = this.server;
    if (!this.keepAliveMinutes || !s || s.state !== 'ready' || this.inflight > 0 || this.starting || this.waking) return;
    if (Date.now() - this.lastUsedAt < this.keepAliveMinutes * 60_000) return;
    await this.park();
  }

  /** Unload the model but remember exactly how it was running, so the next request can bring it back. */
  async park(): Promise<void> {
    const s = this.server;
    if (!s || s.state !== 'ready' || !this.model) return;
    const savedSlots = await this.saveSlots(s);
    this.parked = { model: this.model, config: s.config, engine: this.llamaEngine, label: s.label, loadTimeoutMs: this.loadTimeoutMs, savedSlots };
    this.parkedAt = Date.now();
    this.server = null;
    await s.stop();
  }

  /** URL of a ready engine, reloading a parked model if needed. Null when nothing is loaded or parked. */
  async ensureUpstream(): Promise<string | null> {
    if (this.server?.state === 'ready') return this.server.url;
    if (this.waking) return this.waking;
    const p = this.parked;
    if (!p) return null;
    this.waking = (async () => {
      const server = await createEngineProcess(p.model, p.config, await freePort(), { llama: p.engine });
      this.server = server;
      server.start();
      try {
        await server.waitReady(p.loadTimeoutMs);
      } catch (e) {
        this.server = null;
        throw e;
      }
      await this.restoreSlots(server, p.savedSlots);
      this.parked = null;
      this.parkedAt = null;
      this.lastUsedAt = Date.now();
      return server.url;
    })().finally(() => {
      this.waking = null;
    });
    return this.waking;
  }

  /**
   * Agents resend the same huge system prompt every turn. Before unloading, save each slot's
   * prompt cache to disk so the first request after a reload doesn't reprocess thousands of tokens.
   */
  private async saveSlots(s: EngineProcess): Promise<string[]> {
    if (s.backend !== 'llamacpp' || s.config.workload !== 'agent' || !this.model) return [];
    await mkdir(paths.slots, { recursive: true });
    const saved: string[] = [];
    for (let i = 0; i < Math.max(1, s.config.parallel); i++) {
      const filename = `${this.model.id}-slot${i}.bin`;
      try {
        const r = await fetch(`${s.url}/slots/${i}?action=save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename }),
          signal: AbortSignal.timeout(30_000),
        });
        if (r.ok) saved.push(filename);
      } catch {}
    }
    return saved;
  }

  private async restoreSlots(s: EngineProcess, files: string[]): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      try {
        await stat(join(paths.slots, files[i]));
        await fetch(`${s.url}/slots/${i}?action=restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: files[i] }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {}
    }
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    // Saved prompt caches only matter for reloading a parked model; they're hundreds of MB
    for (const f of this.parked?.savedSlots ?? []) await rm(join(paths.slots, f), { force: true }).catch(() => {});
    this.parked = null;
    this.parkedAt = null;
    this.model = null;
    this.currentPlan = null;
    this.headline = null;
    this.trials = [];
    await s?.stop();
  }

  async run(opts: RunOptions): Promise<SessionStatus> {
    const emit = opts.onEvent ?? (() => {});
    const log = (line: string) => emit({ type: 'log', line });
    const model = requireModel(opts.modelId);
    await this.stop();
    this.starting = true;
    try {
      // 1. Engine
      emit({ type: 'stage', stage: 'engine', detail: 'Checking engines' });
      const hw = await getHardware();
      let engine = await getInstalledEngine();
      if (!engine) {
        log('No engine installed yet, downloading llama.cpp');
        engine = await installEngine(hw, {
          onLog: log,
          signal: opts.signal,
          onProgress: (p) => emit({ type: 'progress', received: p.received, total: p.total, speed: p.speed, label: 'Engine' }),
        });
      }
      this.llamaEngine = engine;
      log(`Engine llama.cpp ${engine.tag} (${engine.backend})`);

      // 2. Plan, using measured quality and this machine's calibration where we have them
      emit({ type: 'stage', stage: 'plan', detail: 'Planning for your hardware' });
      const [measured, calibration] = await Promise.all([loadMeasuredQuality(), loadCalibration()]);
      const plan = makePlan(hw, model, opts.goal, { measured, calibration });
      emit({ type: 'plan', plan });
      if (plan.fit === 'no-fit' && !opts.config) throw new Error(`${model.name} won't fit on this machine right now. Try a smaller model, quant or context.`);
      const base = normalizeConfig(opts.config ?? plan.config);
      const quant = getQuant(model, base.quantId);

      // 3. Download weights + any speculative files
      emit({ type: 'stage', stage: 'download', detail: `Fetching ${model.name} ${quant.id}` });
      const progress = (label: string) => (p: { received: number; total: number; speed: number }) =>
        emit({ type: 'progress', received: p.received, total: p.total, speed: p.speed, label });
      if (!(await isQuantDownloaded(model, quant))) {
        await pullFiles(model, quant.files, { onLog: log, onProgress: progress(`${model.name} ${quant.id}`), signal: opts.signal });
      } else log(`${model.name} ${quant.id} already downloaded`);
      let config = base;
      const extra = extraFilesFor(model, config.spec);
      if (extra) {
        try {
          await pullFiles(extra.model, extra.files, { onLog: log, onProgress: progress('Speculative decoding files'), signal: opts.signal });
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          log(`Could not fetch speculative decoding files (${(e as Error).message}); continuing without`);
          config = { ...config, spec: { type: 'none' } };
        }
      }

      // Optional MLX contender on Apple Silicon
      let mlxOpt: ReturnType<typeof mlxCandidateFor> = null;
      if (opts.tune && opts.tryMlx && mlxSupported()) {
        mlxOpt = mlxCandidateFor(model, plan, (bits) => estimateMlxQuality(model, bits));
        if (mlxOpt) {
          try {
            if (!(await getInstalledMlx())) {
              log('Installing the MLX engine');
              await installMlx({ onLog: log, signal: opts.signal, onProgress: (p) => emit({ type: 'progress', ...p, label: 'MLX engine' }) });
            }
            const v = mlxVariant(model, mlxOpt.variantId)!;
            if (!(await isMlxDownloaded(v))) {
              log(`Downloading the MLX ${v.id} build (${(v.sizeBytes / 1e9).toFixed(1)} GB)`);
              await pullFiles({ ...model, repo: v.repo }, v.files, { onLog: log, onProgress: progress(`MLX ${v.id}`), signal: opts.signal });
            }
          } catch (e) {
            if (opts.signal?.aborted) throw e;
            log(`Skipping MLX: ${(e as Error).message.split('\n')[0]}`);
            mlxOpt = null;
          }
        } else log('No MLX build of this model is available');
      }

      const loadTimeoutMs = 60_000 + (quant.sizeBytes / (hw.disk.readMBs * 1e6)) * 2000;
      this.loadTimeoutMs = loadTimeoutMs;
      const workload = config.workload;
      const baseQuality = qualityOf(model, quant, measured);

      // 4. Tune
      let winner = config;
      let winnerTrial: TrialResult | null = null;
      let bestPerWorkload: Partial<Record<WorkloadKey, string>> = {};
      this.trials = [];
      if (opts.tune) {
        const candidates = tuneCandidates({ ...plan, config }, model, hw, { max: 6, mlx: mlxOpt });
        // Fetch the small files any candidate needs (draft models, speculative heads)
        for (const cand of candidates) {
          const files = extraFilesFor(model, cand.config.spec);
          if (!files) continue;
          try {
            await pullFiles(files.model, files.files, { onLog: log, onProgress: progress('Draft model'), signal: opts.signal });
          } catch (e) {
            if (opts.signal?.aborted) throw e;
            log(`Could not fetch files for "${cand.label}": ${(e as Error).message}`);
          }
        }
        emit({ type: 'stage', stage: 'tune', detail: `Benchmarking ${candidates.length} configurations` });
        const t0 = Date.now();
        const results = await runTrials({
          engine,
          model,
          candidates,
          workload,
          baseQualityPct: baseQuality.pct,
          ctxPerSlot: Math.floor(config.ctx / WORKLOADS[workload].ctxSlots),
          loadTimeoutMs,
          signal: opts.signal,
          onLog: log,
          onTrialStart: (c, i) => emit({ type: 'trialStart', label: c.label, index: i, total: candidates.length }),
          onTrial: (r) => {
            this.trials.push(r);
            emit({ type: 'trial', result: r });
          },
        });
        const picked = pickWinner(results);
        if (!picked.winner) throw new Error(`Every configuration failed to start.\n${results[0]?.error ?? ''}`);
        winnerTrial = picked.winner;
        bestPerWorkload = picked.bestPerWorkload;
        winner = winnerTrial.config;
        log(`Winner for ${workload}: ${winnerTrial.label} (${winnerTrial.genTps} tok/s)`);

        // Teach the planner how this machine really performs. Compare *base* speed only: a llama.cpp
        // run of the planner's quant with no speculative decoding, against the prediction without
        // its assumed speculation boost or any earlier correction.
        const baseRun = results.find((r) => r.ok && r.config.backend !== 'mlx' && r.config.spec.type === 'none' && r.config.quantId === plan.config.quantId && r.config.kvTypeK === plan.config.kvTypeK);
        if (baseRun) {
          const factor = plan.calibration ? Math.min(2.5, Math.max(0.4, plan.calibration.factor)) : 1;
          const raw = plan.predicted.genTps / (plan.predicted.specBoost || 1) / factor;
          await recordCalibration(hw.backend, model.arch.type, plan.fit, baseRun.genTps, raw);
        }
        await this.logBenchmark(hw, engine, model, plan, opts.goal, results, winnerTrial, bestPerWorkload, Date.now() - t0, measured);
      }

      // 5. Start the winner for real
      emit({ type: 'stage', stage: 'start', detail: 'Loading the model' });
      const server = await createEngineProcess(model, winner, await freePort(), { llama: engine });
      this.server = server;
      this.model = model;
      this.currentPlan = plan;
      server.start();
      log(server.command);
      await server.waitReady(loadTimeoutMs, opts.signal);
      this.lastUsedAt = Date.now();

      const q = winner.backend === 'mlx' ? { pct: estimateMlxQuality(model, mlxVariant(model, winner.mlxVariant)?.bits ?? 4), source: 'estimate' as const } : baseQuality;
      const gen = winnerTrial?.genTps ?? plan.predicted.genTps;
      this.headline = {
        genTps: gen,
        promptTps: winnerTrial?.promptTps ?? plan.predicted.promptTps,
        qualityPct: q.pct,
        qualitySource: q.source,
        score: score(gen, q.pct),
        tuned: !!winnerTrial,
        workloads: winnerTrial?.workloads,
        bestPerWorkload,
      };
      emit({ type: 'stage', stage: 'ready', detail: `${model.name} is ready` });
      return this.status();
    } catch (e) {
      await this.server?.stop();
      this.server = null;
      this.model = null;
      throw e;
    } finally {
      this.starting = false;
    }
  }

  private async logBenchmark(
    hw: HardwareProfile,
    engine: InstalledEngine,
    model: CatalogModel,
    plan: Plan,
    goal: PlanGoal,
    trials: TrialResult[],
    winner: TrialResult,
    bestPerWorkload: Partial<Record<WorkloadKey, string>>,
    durationMs: number,
    measured: Awaited<ReturnType<typeof loadMeasuredQuality>>,
  ): Promise<void> {
    const q =
      winner.config.backend === 'mlx'
        ? estimateMlxQuality(model, mlxVariant(model, winner.config.mlxVariant)?.bits ?? 4)
        : qualityOf(model, getQuant(model, winner.config.quantId), measured).pct;
    const rec: BenchmarkRecord = {
      schema: 1,
      id: benchmarkId(model.id),
      createdAt: new Date().toISOString(),
      engine: { tag: engine.tag, backend: engine.backend },
      hardware: {
        os: hw.os.name,
        cpu: hw.cpu.model,
        ramGB: Math.round(hw.memory.totalBytes / 1024 ** 3),
        gpus: hw.gpus.map((g) => g.model),
        unifiedMemory: hw.unifiedMemory,
      },
      model: { id: model.id, quantId: winner.config.quantId },
      goal,
      predicted: plan.predicted,
      trials,
      winner: { label: winner.label, config: winner.config, genTps: winner.genTps, promptTps: winner.promptTps, qualityPct: q, score: score(winner.genTps, q) },
      workload: winner.config.workload,
      bestPerWorkload,
      durationMs,
    };
    await saveBenchmark(rec);
  }
}
