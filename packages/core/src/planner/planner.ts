import type {
  CatalogModel,
  CatalogQuant,
  Fit,
  HardwareProfile,
  KvType,
  Plan,
  PlanGoal,
  PlanReason,
  QuantOption,
  RunConfig,
} from '../types';
import { getModel } from '../catalog';
import { qualityOf, score, type MeasuredQuality } from '../quality';
import { formatBytes, GiB, MiB, clamp } from '../util';
import { pcieBandwidth } from '../hardware/profiler';
import { budgets, computeBufferBytes, kvCacheBytes, nonLayerBytes, type Budgets } from './memory';

// Phase 1 planner: rule-based plus memory maths. Every decision records a
// human-readable reason so the UI can explain itself.

const MIN_CTX = 4096;

/** Fraction of theoretical bandwidth llama.cpp actually achieves during generation. */
// Calibrated against public llama.cpp numbers (e.g. 27B dense Q4 ≈ 35 tok/s on an RTX 3090,
// 7B Q4_0 ≈ 30 tok/s on an M3 Pro, 30B-A3B Q4 ≈ 120–140 tok/s on a 3090).
const GPU_EFFICIENCY: Record<string, number> = { cuda: 0.68, metal: 0.72, rocm: 0.58, vulkan: 0.52, cpu: 0 };
const CPU_EFFICIENCY = 0.55;
/** Expert routing and small per-expert matmuls don't saturate bandwidth like dense layers do. */
const MOE_EFFICIENCY = 0.6;
/** Per-layer per-token overhead in seconds (kernel launches, routing). */
const LAYER_OVERHEAD = { dense: 0.000025, moe: 0.000045 };

interface Placement {
  fit: Fit;
  ctx: number;
  ngl: number | 'all';
  nCpuMoe: number;
  moeCacheMiB: number;
  gpuBytes: number;
  ramBytes: number;
  kvBytes: number;
  computeBytes: number;
  /** Bytes read from GPU memory and CPU memory for each generated token */
  gpuActive: number;
  cpuActive: number;
  /** Expert bytes living in RAM (for prompt-processing PCIe cost) */
  cpuExpertBytes: number;
}

interface Candidate {
  quant: CatalogQuant;
  placement: Placement;
  kvType: KvType;
  genTps: number;
  promptTps: number;
  quality: number;
  qualitySource: 'native' | 'measured' | 'estimate';
  score: number;
}

/** measured ÷ predicted speed from earlier tuning runs, keyed by calibrationKey() */
export type Calibration = Record<string, { factor: number; runs: number }>;

export function calibrationKey(backend: string, archType: string, fit: string): string {
  return `${backend}|${archType}|${fit}`;
}

/** How workloads change the server setup. */
export const WORKLOADS = {
  chat: { parallel: 1, ctxSlots: 1, cacheReuse: 0, label: 'Chat' },
  agent: { parallel: 2, ctxSlots: 2, cacheReuse: 256, label: 'Coding agent' },
  batch: { parallel: 8, ctxSlots: 1, cacheReuse: 0, label: 'Batch' },
} as const;

export interface PlanOptions {
  /** Memory held by a model localmax already has loaded; it gets freed before the new one loads */
  ownEngineBytes?: number;
  /** Quality measured with llama-perplexity (overrides estimates) */
  measured?: MeasuredQuality;
  /** How this machine actually performed against earlier predictions */
  calibration?: Calibration;
}

export function plan(hw: HardwareProfile, model: CatalogModel, goal: PlanGoal, opts: PlanOptions = {}): Plan {
  const memMode = goal.memory ?? 'free';
  const b0 = budgets(hw, memMode, opts.ownEngineBytes ?? 0);
  // Keep room on the GPU for a shipped speculative head (EAGLE3/MTP) if it is small relative to the budget
  const headReserve = model.specHead && model.specHead.file.size * 1.3 < b0.gpu * 0.08 ? model.specHead.file.size * 1.3 : 0;
  const b: Budgets = { ...b0, gpu: Math.max(0, b0.gpu - headReserve) };
  const ctxTarget = clamp(Math.round(goal.ctx), 512, model.arch.maxContext);
  const backend = hw.backend;
  const ubatch = chooseUbatch(hw, model);

  // Evaluate every quant at the target context
  const workload = WORKLOADS[goal.workload ?? 'chat'];
  const candidates: Candidate[] = model.quants.map((quant) => evaluate(hw, b, model, quant, goal, ctxTarget * workload.ctxSlots, ubatch, opts));
  const usable = candidates.filter((c) => c.placement.fit !== 'no-fit');

  let chosen: Candidate;
  let quantWhy: string;
  if (goal.quantId) {
    chosen = candidates.find((c) => c.quant.id.toLowerCase() === goal.quantId!.toLowerCase()) ?? candidates[0];
    quantWhy = 'You picked this quant yourself.';
  } else if (!usable.length) {
    chosen = [...candidates].sort((a, b2) => a.quant.sizeBytes - b2.quant.sizeBytes)[0];
    quantWhy = 'Even the smallest quant does not fit in this machine’s memory.';
  } else {
    [chosen, quantWhy] = pickByGoal(usable, goal);
  }

  const p = chosen.placement;
  const reasons: PlanReason[] = [];
  const warnings: string[] = [];
  const unified = hw.unifiedMemory;
  const need = p.gpuBytes + p.ramBytes;

  // Doesn't fit what's free now: would it fit with other apps closed?
  let blockedBy: Plan['blockedBy'] = null;
  if (p.fit === 'no-fit') {
    blockedBy = memMode === 'free' && plan(hw, model, { ...goal, memory: 'total' }, opts).fit !== 'no-fit' ? 'free-memory' : 'machine';
  }

  // ---------- Quant reason ----------
  reasons.push({
    kind: 'quant',
    title: `${chosen.quant.id} · ${formatBytes(chosen.quant.sizeBytes)} · ${chosen.quality.toFixed(1)}% quality`,
    detail: `${quantWhy}${chosen.quant.native ? ' This is the format the model was released in, so nothing is lost.' : ''}`,
  });

  // ---------- Placement reason ----------
  if (unified) {
    reasons.push({
      kind: 'placement',
      title: p.fit === 'gpu' ? 'Whole model on the GPU (unified memory)' : p.fit === 'partial' ? `${p.ngl} of ${model.arch.layers} layers on the GPU` : 'Does not fit',
      detail:
        p.fit === 'gpu'
          ? `Apple Silicon shares one pool of memory, so there is no VRAM/RAM split to manage. Weights ${formatBytes(chosen.quant.sizeBytes)} + KV cache ${formatBytes(p.kvBytes)} + ${formatBytes(p.computeBytes)} working memory fit inside the ${formatBytes(b.gpu)} Metal is allowed to use.`
          : p.fit === 'partial'
            ? `Metal may only wire ${formatBytes(b.gpu)} of your ${formatBytes(hw.memory.totalBytes)}. The remaining layers run on the CPU cores from the same memory, which is slower. Raising iogpu.wired_limit_mb would let more run on the GPU.`
            : blockedBy === 'free-memory'
              ? `Needs about ${formatBytes(need)} but only ${formatBytes(b.freeNow)} is free right now. It would fit if you closed other apps (this Mac can offer up to ${formatBytes(b.machine)}).`
              : `Needs about ${formatBytes(need)} but this Mac can offer at most ${formatBytes(b.machine)}, even with every other app closed.`,
    });
  } else if (b.gpu === 0) {
    reasons.push({
      kind: 'placement',
      title: 'CPU only',
      detail: `No supported GPU, so the model runs from system RAM at about ${hw.memory.bandwidthGBs} GB/s. Speed is set by RAM bandwidth, so smaller quants are much faster.`,
    });
  } else if (p.fit === 'gpu') {
    reasons.push({
      kind: 'placement',
      title: 'Everything on the GPU',
      detail: `Weights ${formatBytes(chosen.quant.sizeBytes)} + KV cache ${formatBytes(p.kvBytes)} + ${formatBytes(p.computeBytes)} working memory fit in the ${formatBytes(b.gpu)} of VRAM free. Nothing has to cross PCIe while generating.`,
    });
  } else if (p.fit === 'partial' && p.nCpuMoe > 0) {
    const a = model.arch;
    reasons.push({
      kind: 'placement',
      title: `Expert weights of ${p.nCpuMoe} of ${a.moeLayers} layers in RAM`,
      detail: `Attention, shared weights and the KV cache stay on the GPU. Only ${a.expertsPerToken} of ${a.experts} experts run per token, so parking the expert tensors of the first ${p.nCpuMoe} layers in system RAM costs far less speed than offloading whole layers. That is the minimum needed to fit (--n-cpu-moe ${p.nCpuMoe}).`,
    });
    if (p.moeCacheMiB > 0) {
      reasons.push({
        kind: 'placement',
        title: `${formatBytes(p.moeCacheMiB * MiB)} hot-expert cache`,
        detail: `The VRAM left over becomes a cache for the experts that live in RAM (--moe-cache-mib ${p.moeCacheMiB}), so frequently used experts are served from the GPU instead of being recomputed on the CPU.`,
      });
    }
  } else if (p.fit === 'partial') {
    reasons.push({
      kind: 'placement',
      title: `${p.ngl} of ${model.arch.layers} layers on the GPU`,
      detail: `The full model needs ${formatBytes(chosen.quant.sizeBytes + p.kvBytes + p.computeBytes)} but the GPU has ${formatBytes(b.gpu)} free. The rest run on the CPU from RAM. Dense models read every weight for every token, so each layer in RAM slows generation noticeably.`,
    });
  } else if (p.fit === 'cpu') {
    reasons.push({ kind: 'placement', title: 'Runs on the CPU', detail: 'Too large for the GPU at any useful split, so it runs from system RAM.' });
  } else {
    reasons.push({
      kind: 'warn',
      title: blockedBy === 'free-memory' ? 'Needs more free memory' : 'Won’t fit',
      detail:
        blockedBy === 'free-memory'
          ? `Needs about ${formatBytes(chosen.quant.sizeBytes + p.kvBytes)} but only ${formatBytes(b.freeNow)} of RAM is free right now. Close other apps to make room.`
          : `Needs about ${formatBytes(chosen.quant.sizeBytes + p.kvBytes)} but this machine can offer roughly ${formatBytes(b.machine + b.gpu)}.`,
    });
  }
  if (blockedBy === 'free-memory') {
    warnings.push(`Only ${formatBytes(b.freeNow)} of memory is free right now. Close some apps, or plan for the whole machine, to run this.`);
  } else if (blockedBy === 'machine') {
    warnings.push(`${model.name} is too big for this machine${goal.quantId ? ' at this quant' : ', even at the smallest quant'}.`);
  }

  // ---------- KV + context ----------
  const kvF16 = kvCacheBytes(model, p.ctx, 'f16', 'f16');
  reasons.push({
    kind: 'kv',
    title: `${chosen.kvType} KV cache · ${formatBytes(p.kvBytes)} at ${p.ctx.toLocaleString()} tokens`,
    detail:
      chosen.kvType === 'f16'
        ? goal.mode === 'quality'
          ? 'Full-precision KV cache, because you asked for maximum quality.'
          : `This model's KV cache is small (${model.arch.linearAttnLayers + model.arch.swaLayers > 0 ? 'most layers use linear or sliding-window attention' : 'few KV heads'}), so it stays at full precision for free.`
        : `8-bit KV cache is effectively lossless and saves ${formatBytes(kvF16 - p.kvBytes)} compared with f16, which goes towards keeping weights on the GPU.`,
  });
  if (p.ctx < ctxTarget) {
    reasons.push({
      kind: 'ctx',
      title: `Context reduced to ${p.ctx.toLocaleString()}`,
      detail: `${ctxTarget.toLocaleString()} tokens of context did not fit alongside the weights.`,
    });
    warnings.push(`Context reduced from ${ctxTarget.toLocaleString()} to ${p.ctx.toLocaleString()} tokens to fit.`);
  }

  // ---------- Speculative decoding ----------
  const spec = chooseSpec(hw, b, model, chosen, goal);
  reasons.push(spec.reason);

  // ---------- Workload ----------
  const wl = goal.workload ?? 'chat';
  reasons.push({
    kind: 'batch',
    title: `${workload.label} profile · ${workload.parallel} request slot${workload.parallel > 1 ? 's' : ''}`,
    detail:
      wl === 'agent'
        ? `Coding tools resend big prompts every turn and sometimes run two requests at once. Two slots share one ${Math.round(p.ctx / 1024)}K KV cache (--kv-unified), and --cache-reuse ${workload.cacheReuse} keeps unchanged parts of earlier prompts so they aren't processed again. When the model unloads after sitting idle, its prompt cache is saved to disk and restored on reload.`
        : wl === 'batch'
          ? `Eight requests are served side by side from one shared KV cache. Each request is a bit slower, but total throughput is several times higher.`
          : 'One conversation at a time gets the whole KV cache and all of the GPU.',
  });

  // ---------- Threads + batch ----------
  const cpuHeavy = p.fit !== 'gpu';
  const threads = Math.max(1, cpuHeavy ? (unified ? hw.cpu.performanceCores : hw.cpu.physicalCores) : Math.min(hw.cpu.performanceCores, 8));
  reasons.push({
    kind: 'threads',
    title: `${threads} CPU threads`,
    detail: cpuHeavy
      ? `CPU-side work is memory-bound, so one thread per ${unified ? 'performance' : 'physical'} core is fastest. Hyper-threads${unified ? ' and efficiency cores' : ''} just fight over bandwidth.`
      : 'The GPU does nearly all the work, so a few threads for sampling and scheduling are enough.',
  });
  reasons.push({
    kind: 'batch',
    title: `Batch 2048 · micro-batch ${ubatch}`,
    detail:
      ubatch > 512
        ? 'Experts in RAM have to be copied to the GPU for prompt processing. Bigger micro-batches reuse each copy across more tokens, which speeds up long prompts.'
        : 'Default micro-batch keeps working memory small, which leaves room for weights and context.',
  });

  // Planning for the whole machine: say clearly when that means closing apps first
  const pressured = unified ? need : p.ramBytes;
  if (p.fit !== 'no-fit' && pressured > b.freeNow) {
    warnings.push(
      `Needs ${formatBytes(pressured)} of ${unified ? 'memory' : 'RAM'} but only ${formatBytes(b.freeNow)} is free right now. Close other apps first, or ${unified ? 'macOS' : 'the OS'} will swap to disk and it will run far slower than predicted.`,
    );
  }
  if (model.experimental) warnings.push('Experimental: check that your engine build supports this architecture.');

  const config: RunConfig = {
    modelId: model.id,
    backend: 'llamacpp',
    workload: wl,
    quantId: chosen.quant.id,
    parallel: workload.parallel,
    cacheReuse: workload.cacheReuse,
    ctx: p.ctx,
    ngl: p.ngl,
    nCpuMoe: p.nCpuMoe,
    moeCacheMiB: p.moeCacheMiB,
    kvTypeK: chosen.kvType,
    kvTypeV: chosen.kvType,
    flashAttn: chosen.kvType === 'f16' ? 'auto' : 'on',
    threads,
    batch: 2048,
    ubatch,
    spec: spec.config,
  };

  const genTps = round1(chosen.genTps * spec.boost);
  const options: QuantOption[] = candidates.map((c) => ({
    quantId: c.quant.id,
    sizeBytes: c.quant.sizeBytes,
    fit: c.placement.fit,
    genTps: round1(c.genTps),
    qualityPct: c.quality,
    score: c.score,
    chosen: c === chosen,
  }));

  return {
    modelId: model.id,
    modelName: model.name,
    goal: { ...goal, ctx: ctxTarget },
    backend,
    config,
    fit: p.fit,
    memory: {
      weightsBytes: chosen.quant.sizeBytes,
      kvBytes: p.kvBytes,
      computeBytes: p.computeBytes,
      gpuBytes: p.gpuBytes,
      ramBytes: p.ramBytes,
      gpuBudgetBytes: b.gpu,
      ramBudgetBytes: b.ram,
      extraBytes: spec.extraBytes,
      freeNowBytes: b.freeNow,
      machineBytes: b.machine,
    },
    blockedBy,
    predicted: {
      genTps,
      promptTps: Math.round(chosen.promptTps),
      qualityPct: chosen.quality,
      qualitySource: chosen.qualitySource,
      score: score(genTps, chosen.quality),
      specBoost: spec.boost,
    },
    calibration: (() => {
      const c = opts.calibration?.[calibrationKey(hw.backend, model.arch.type, p.fit)];
      return c && c.runs > 0 ? c : null;
    })(),
    reasons,
    warnings,
    options,
  };
}

function pickByGoal(usable: Candidate[], goal: PlanGoal): [Candidate, string] {
  const byScore = (xs: Candidate[]) => [...xs].sort((a, b) => b.score - a.score)[0];
  if (goal.mode === 'quality') {
    // "Usable" scales with the machine: 5 tok/s, or half the fastest option on slow hardware
    const fastest = Math.max(...usable.map((c) => c.genTps));
    const floor = Math.min(5, fastest * 0.5);
    const ok = usable.filter((c) => c.genTps >= floor);
    const best = [...ok].sort((a, b) => b.quality - a.quality || b.genTps - a.genTps)[0];
    // Never end up below what the speed goal would pick
    const [speedPick] = pickByGoal(usable, { ...goal, mode: 'speed' });
    if (!best || speedPick.quality > best.quality) return [speedPick, 'Nothing higher-quality runs at a usable speed here, so this is the best available.'];
    return [best, `Highest quality that still runs at a usable speed (${round1(best.genTps)} tok/s predicted).`];
  }
  if (goal.mode === 'speed') {
    const floorPct = 95;
    const pool = usable.filter((c) => c.quality >= floorPct);
    const best = byScore(pool.length ? pool : usable);
    return [best, `Highest score (speed × quality) among quants that keep at least ${floorPct}% quality.`];
  }
  // Balanced: start from quants that keep ≥97.5% quality (about a good Q4), then take the
  // highest-quality one that is no more than 25% slower than the fastest of them.
  const floors = [97.5, 95, 0];
  const floorPct = floors.find((f) => usable.some((c) => c.quality >= f))!;
  const pool = usable.filter((c) => c.quality >= floorPct);
  const fastest = Math.max(...pool.map((c) => c.genTps));
  const minSpeed = fastest * 0.75;
  const best = [...pool].filter((c) => c.genTps >= minSpeed).sort((a, b) => b.quality - a.quality || b.genTps - a.genTps)[0];
  let why =
    floorPct > 0
      ? `Highest quality within 25% of the fastest quant that keeps at least ${floorPct}% quality.`
      : 'Nothing keeps 95% quality and fits, so this is the best balance available.';
  const better = usable.filter((c) => c.quality > best.quality).sort((a, b) => a.quant.sizeBytes - b.quant.sizeBytes)[0];
  if (better) {
    why += ` ${better.quant.id} is higher quality but would drop to ${round1(better.genTps)} tok/s${better.placement.fit !== best.placement.fit ? ' because it no longer fits the same way' : ''}.`;
  } else {
    why += ' Nothing that fits is higher quality.';
  }
  return [best, why];
}

function evaluate(hw: HardwareProfile, b: Budgets, model: CatalogModel, quant: CatalogQuant, goal: PlanGoal, ctxTarget: number, ubatch: number, opts: PlanOptions): Candidate {
  // KV type: f16 for quality mode or when the KV cache is tiny anyway; otherwise q8_0
  const kvTiny = kvCacheBytes(model, ctxTarget, 'f16', 'f16') <= 0.04 * Math.max(b.gpu || b.ram, 1);
  const preferred: KvType = goal.mode === 'quality' || kvTiny ? 'f16' : 'q8_0';
  // Better weights beat a full-precision KV cache, so fall back to q8_0 before shrinking context
  const kvOrder: KvType[] = preferred === 'f16' ? ['f16', 'q8_0'] : ['q8_0'];

  let kvType: KvType = preferred;
  let placement = place(hw, b, model, quant, ctxTarget, kvType, ubatch);
  for (const kv of kvOrder.slice(1)) {
    if (placement.fit !== 'no-fit') break;
    kvType = kv;
    placement = place(hw, b, model, quant, ctxTarget, kvType, ubatch);
  }
  // Shrink context until it fits, but never below MIN_CTX
  let ctx = ctxTarget;
  while (placement.fit === 'no-fit' && ctx > MIN_CTX) {
    ctx = Math.max(MIN_CTX, Math.floor(ctx / 2));
    placement = place(hw, b, model, quant, ctx, kvType, ubatch);
  }
  if (placement.fit === 'no-fit') placement = place(hw, b, model, quant, ctxTarget, kvType, ubatch);

  const raw = predictSpeed(hw, b, model, placement, ubatch);
  // Scale by how this machine actually performed in earlier tuning runs (clamped so one odd run can't dominate)
  const cal = opts.calibration?.[calibrationKey(hw.backend, model.arch.type, placement.fit)];
  const factor = cal && cal.runs > 0 ? clamp(cal.factor, 0.4, 2.5) : 1;
  const genTps = raw.genTps * factor;
  const promptTps = raw.promptTps;
  const q = qualityOf(model, quant, opts.measured);
  return { quant, placement, kvType, genTps, promptTps, quality: q.pct, qualitySource: q.source, score: score(genTps, q.pct) };
}

export function place(hw: HardwareProfile, b: Budgets, model: CatalogModel, quant: CatalogQuant, ctx: number, kvType: KvType, ubatch: number): Placement {
  const a = model.arch;
  const W = quant.sizeBytes;
  const kv = kvCacheBytes(model, ctx, kvType, kvType);
  const compute = computeBufferBytes(model, ubatch);
  const { embed, output } = nonLayerBytes(model, W, quant.bpw);
  const layerBytes = (W - embed - output) / a.layers;
  const kvPerLayer = kv / a.layers;
  const expertBytes = W * a.expertFraction;
  const expertPerLayer = a.moeLayers ? expertBytes / a.moeLayers : 0;
  const activeRatio = a.experts ? a.expertsPerToken / a.experts : 1;
  // Bytes touched per token if everything were in one place
  const activeTotal = a.type === 'moe' ? W - embed - expertBytes * (1 - activeRatio) : W - embed;
  const kvRead = kv * Math.min(1, 4096 / ctx) * 0.5;

  const result = (r: Partial<Placement> & Pick<Placement, 'fit'>): Placement => ({
    ctx,
    ngl: 'all',
    nCpuMoe: 0,
    moeCacheMiB: 0,
    gpuBytes: 0,
    ramBytes: 0,
    kvBytes: kv,
    computeBytes: compute,
    gpuActive: 0,
    cpuActive: 0,
    cpuExpertBytes: 0,
    ...r,
  });

  const fullNeed = W + kv + compute;

  // ----- CPU only -----
  if (b.gpu === 0) {
    const fits = fullNeed <= b.ram;
    return result({ fit: fits ? 'cpu' : 'no-fit', ngl: 0, ramBytes: fullNeed, cpuActive: activeTotal + kvRead });
  }

  // ----- Everything on the GPU -----
  if (fullNeed <= b.gpu) {
    return result({ fit: 'gpu', gpuBytes: fullNeed, gpuActive: activeTotal + kvRead });
  }

  // ----- Apple Silicon: one pool, but Metal's wired limit caps the GPU share -----
  if (hw.unifiedMemory) {
    if (fullNeed > (b.unifiedCap ?? 0)) return result({ fit: 'no-fit', gpuBytes: Math.min(fullNeed, b.gpu), ramBytes: Math.max(0, fullNeed - b.gpu) });
    const ngl = Math.max(0, Math.floor((b.gpu - compute - output) / (layerBytes + kvPerLayer)));
    const gpuLayers = Math.min(ngl, a.layers);
    const gpuBytes = gpuLayers * (layerBytes + kvPerLayer) + compute + output;
    const share = gpuLayers / a.layers;
    return result({
      fit: gpuLayers > 0 ? 'partial' : 'cpu',
      ngl: gpuLayers,
      gpuBytes,
      ramBytes: fullNeed - gpuBytes,
      gpuActive: (activeTotal - output) * share + output + kvRead * share,
      cpuActive: (activeTotal - output) * (1 - share) + kvRead * (1 - share),
    });
  }

  // ----- Discrete GPU, MoE: move expert tensors to RAM layer by layer -----
  if (a.type === 'moe' && expertPerLayer > 0) {
    const overflow = fullNeed - b.gpu;
    const n = Math.ceil(overflow / expertPerLayer);
    if (n <= a.moeLayers) {
      const cpuExperts = n * expertPerLayer;
      const gpuBytes = fullNeed - cpuExperts;
      if (cpuExperts <= b.ram) {
        const leftover = b.gpu - gpuBytes;
        const cacheBytes = leftover > 768 * MiB ? Math.min(leftover - 256 * MiB, cpuExperts) : 0;
        const cacheMiB = Math.floor(cacheBytes / MiB);
        // Cache hit rate: a cache holding x% of the RAM experts serves a bit more than x% of lookups (hot experts)
        const hit = cpuExperts > 0 ? Math.min(0.85, (cacheBytes / cpuExperts) * 1.6) : 0;
        const cpuActive = cpuExperts * activeRatio * (1 - hit);
        return result({
          fit: 'partial',
          nCpuMoe: n,
          moeCacheMiB: cacheMiB,
          gpuBytes: gpuBytes + cacheBytes,
          ramBytes: cpuExperts,
          gpuActive: activeTotal - cpuActive + kvRead,
          cpuActive,
          cpuExpertBytes: cpuExperts,
        });
      }
      return result({ fit: 'no-fit', gpuBytes, ramBytes: cpuExperts });
    }
    // Dense part alone doesn't fit: fall through to layer offload
  }

  // ----- Discrete GPU, dense: offload whole layers -----
  const ngl = Math.max(0, Math.min(a.layers, Math.floor((b.gpu - compute - output) / (layerBytes + kvPerLayer))));
  const gpuBytes = ngl * (layerBytes + kvPerLayer) + compute + output;
  const ramBytes = fullNeed - gpuBytes;
  if (ramBytes > b.ram) return result({ fit: 'no-fit', ngl, gpuBytes, ramBytes });
  const share = ngl / a.layers;
  return result({
    fit: ngl > 0 ? 'partial' : 'cpu',
    ngl,
    gpuBytes,
    ramBytes,
    gpuActive: (activeTotal - output) * share + output + kvRead * share,
    cpuActive: (activeTotal - output) * (1 - share) + kvRead * (1 - share),
  });
}

/** Generation is memory-bound: time per token ≈ bytes read ÷ effective bandwidth. */
export function predictSpeed(hw: HardwareProfile, b: Budgets, model: CatalogModel, p: Placement, ubatch: number): { genTps: number; promptTps: number } {
  if (p.fit === 'no-fit') return { genTps: 0, promptTps: 0 };
  const moe = model.arch.type === 'moe';
  const gpuEff = (GPU_EFFICIENCY[hw.backend] ?? 0.5) * (moe ? MOE_EFFICIENCY : 1);
  const gpuBw = b.gpuBandwidth * 1e9 * gpuEff;
  // CPU-side bandwidth: on Apple Silicon the CPU cluster can't saturate the full memory bus
  const cpuBwRaw = hw.unifiedMemory ? b.ramBandwidth * 0.45 : b.ramBandwidth;
  const threadCap = (hw.unifiedMemory ? hw.cpu.performanceCores : hw.cpu.physicalCores) * 12;
  const cpuBw = Math.min(cpuBwRaw * CPU_EFFICIENCY * (moe ? 0.8 : 1), threadCap) * 1e9;

  let seconds = 0;
  if (p.gpuActive > 0 && gpuBw > 0) seconds += p.gpuActive / gpuBw;
  if (p.cpuActive > 0) seconds += p.cpuActive / cpuBw;
  // Per-token overhead: kernel launches per layer, sampling, and GPU<->CPU sync when split
  seconds += model.arch.layers * (moe ? LAYER_OVERHEAD.moe : LAYER_OVERHEAD.dense) + 0.0006;
  if (p.fit === 'partial') seconds += 0.0015;
  const genTps = 1 / seconds;

  let promptTps: number;
  if (p.fit === 'gpu') {
    promptTps = Math.min(8000, genTps * (hw.unifiedMemory ? 14 : 22));
  } else if (p.fit === 'cpu') {
    promptTps = genTps * 5;
  } else if (p.cpuExpertBytes > 0 && !hw.unifiedMemory) {
    // Experts in RAM are streamed over PCIe once per micro-batch during prompt processing
    const pcie = pcieBandwidth(b.primaryGpu?.pcie) * 1e9 * 0.8;
    const perBatch = p.cpuExpertBytes / pcie + ubatch / Math.min(8000, (1 / (p.gpuActive / gpuBw + 0.002)) * 22);
    promptTps = ubatch / perBatch;
  } else {
    promptTps = genTps * 6;
  }
  return { genTps, promptTps };
}

function chooseUbatch(hw: HardwareProfile, model: CatalogModel): number {
  // Large micro-batches help when experts are offloaded on a discrete GPU (PCIe reuse)
  if (!hw.unifiedMemory && hw.backend !== 'cpu' && model.arch.type === 'moe' && model.arch.totalParamsB > 40) return 2048;
  return 512;
}

function chooseSpec(
  hw: HardwareProfile,
  b: Budgets,
  model: CatalogModel,
  chosen: Candidate,
  _goal: PlanGoal,
): { config: RunConfig['spec']; boost: number; extraBytes: number; reason: PlanReason } {
  const p = chosen.placement;
  const headroom = hw.unifiedMemory ? (b.unifiedCap ?? 0) - p.gpuBytes - p.ramBytes : b.gpu - p.gpuBytes;
  const reserved = model.specHead ? model.specHead.file.size * 1.3 : 0;

  // 1. A speculative head shipped with the model (EAGLE3 or MTP); room was reserved for it up front
  if (model.specHead && p.fit !== 'no-fit' && headroom + reserved >= model.specHead.file.size * 1.3 && reserved < b.gpu * 0.1) {
    const kind = model.specHead.type === 'draft-eagle3' ? 'EAGLE3' : 'MTP';
    return {
      config: { type: model.specHead.type, headFile: model.specHead.file.path, nMax: 8, nMin: 1 },
      boost: p.fit === 'gpu' ? 1.3 : 1.12,
      extraBytes: model.specHead.file.size,
      reason: {
        kind: 'spec',
        title: `${kind} speculative decoding`,
        detail: `${model.name} ships a ${formatBytes(model.specHead.file.size)} ${kind} head that guesses several tokens ahead; the full model then checks them in one pass. Output is the same as without it. The tuner confirms it actually helps on your machine before keeping it.`,
      },
    };
  }

  // 2. A small draft model with the same tokenizer
  const draft = model.draft ? getModel(model.draft.modelId) : undefined;
  const draftQuant = draft?.quants.find((q) => q.id === model.draft!.quantId);
  // Below ~8B the target is already fast and bandwidth-bound, so a draft usually costs more than it
  // saves; the tuner still tries one as a candidate, but the planner doesn't assume it helps.
  if (draft && draftQuant && model.arch.type === 'dense' && model.arch.totalParamsB >= 8 && p.fit !== 'no-fit') {
    const need = draftQuant.sizeBytes + 0.4 * GiB;
    if (headroom > need) {
      return {
        config: { type: 'draft-simple', draftModelId: draft.id, draftQuantId: draftQuant.id, nMax: 16, nMin: 1 },
        boost: p.fit === 'gpu' ? 1.35 : 1.15,
        extraBytes: draftQuant.sizeBytes,
        reason: {
          kind: 'spec',
          title: `Draft model: ${draft.name}`,
          detail: `${model.name} is dense, so each token reads all ${formatBytes(chosen.quant.sizeBytes)} of weights. ${draft.name} (${formatBytes(draftQuant.sizeBytes)}) shares its tokenizer and drafts tokens cheaply; the big model verifies a batch of them at once. Output is unchanged. The tuner keeps it only if it is faster.`,
        },
      };
    }
  }

  // 3. Draftless n-gram lookahead, decided by the tuner
  return {
    config: { type: 'none' },
    boost: 1,
    extraBytes: 0,
    reason: {
      kind: 'spec',
      title: 'No draft model',
      detail:
        model.arch.type === 'moe'
          ? `Only ${model.arch.activeParamsB}B parameters are active per token, so a separate draft model rarely pays for itself. The tuner will try draftless n-gram lookahead, which helps with code and edits.`
          : 'No compatible draft model fits alongside this one. The tuner will try draftless n-gram lookahead, which helps with code and edits.',
    },
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Plan every catalog model for this machine (used by the "what can I run" list). */
export function planAll(hw: HardwareProfile, models: CatalogModel[], goal: PlanGoal, opts: PlanOptions = {}): Plan[] {
  return models.map((m) => plan(hw, m, goal, opts));
}
