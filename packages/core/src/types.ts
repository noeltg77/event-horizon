// Shared types for the localmax engine. The UI imports these too, so keep them plain data.

export type Backend = 'metal' | 'cuda' | 'vulkan' | 'rocm' | 'cpu';
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown';
export type Source = 'measured' | 'table' | 'estimate';

export interface GpuInfo {
  vendor: GpuVendor;
  model: string;
  vramBytes: number;
  /** Free VRAM where the driver tells us, otherwise null */
  vramFreeBytes: number | null;
  backends: Backend[];
  bandwidthGBs: number;
  bandwidthSource: Source;
  cores?: number;
  driver?: string;
  pcie?: { gen: number; width: number } | null;
}

export interface HardwareProfile {
  schema: 1;
  detectedAt: string;
  os: { platform: NodeJS.Platform; arch: string; release: string; name: string };
  cpu: {
    model: string;
    vendor: string;
    physicalCores: number;
    /** Performance cores on hybrid CPUs (Apple P-cores). Equals physicalCores when unknown. */
    performanceCores: number;
    logicalCores: number;
    avx2: boolean;
    avx512: boolean;
    neon: boolean;
  };
  memory: {
    totalBytes: number;
    availableBytes: number;
    /** Memory the OS can hand over without swapping (free + reclaimable caches). macOS only; falls back to availableBytes. */
    reclaimableBytes?: number;
    swapUsedBytes?: number;
    type: string | null;
    speedMTs: number | null;
    channels: number | null;
    bandwidthGBs: number;
    bandwidthSource: Source;
  };
  gpus: GpuInfo[];
  /** Apple Silicon: CPU and GPU share one pool of memory */
  unifiedMemory: boolean;
  /** Apple Silicon: the most memory Metal may wire for the GPU */
  gpuWiredLimitBytes: number | null;
  disk: {
    path: string;
    freeBytes: number;
    totalBytes: number;
    kind: 'nvme' | 'ssd' | 'hdd' | 'unknown';
    readMBs: number;
    readSource: Source;
  };
  backend: Backend;
  notes: string[];
}

// ---------- Catalog ----------

export interface CatalogFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface CatalogQuant {
  id: string;
  sizeBytes: number;
  bpw: number;
  /** The model was released in this format (e.g. gpt-oss MXFP4), so there is no quantisation loss */
  native: boolean;
  files: CatalogFile[];
}

export interface ModelArch {
  type: 'dense' | 'moe';
  layers: number;
  hidden: number;
  vocab: number;
  kvHeads: number;
  headDim: number;
  fullAttnLayers: number;
  swaLayers: number;
  linearAttnLayers: number;
  slidingWindow: number | null;
  experts: number;
  expertsPerToken: number;
  moeLayers: number;
  /** Share of all weights that are routed-expert tensors */
  expertFraction: number;
  totalParamsB: number;
  activeParamsB: number;
  maxContext: number;
}

/** An MLX build of the same model (Apple Silicon only), from mlx-community. */
export interface MlxVariant {
  id: string;
  bits: number;
  repo: string;
  sizeBytes: number;
  files: CatalogFile[];
}

export interface CatalogModel {
  id: string;
  name: string;
  vendor: string;
  repo: string;
  baseRepo: string | null;
  tier: 'small' | 'dense' | 'moe' | 'big';
  tags: string[];
  blurb: string;
  experimental: boolean;
  /** A separate small model with the same tokenizer that can draft tokens */
  draft: { modelId: string; quantId: string } | null;
  /** A speculative head shipped with the model (EAGLE3 or MTP) */
  specHead: { type: 'draft-eagle3' | 'draft-mtp'; file: CatalogFile } | null;
  arch: ModelArch;
  quants: CatalogQuant[];
  /** MLX builds for Apple Silicon (may be empty) */
  mlx: MlxVariant[];
}

export interface Catalog {
  schema: 1;
  generatedAt: string;
  models: CatalogModel[];
}

// ---------- Planner ----------

export type GoalMode = 'speed' | 'balanced' | 'quality';
/**
 * chat: one person, one conversation. agent: coding tools that resend big prompts and run
 * requests side by side (prefill and prompt caching matter). batch: many requests at once.
 */
export type Workload = 'chat' | 'agent' | 'batch';
export type EngineBackendId = 'llamacpp' | 'mlx';

export interface PlanGoal {
  mode: GoalMode;
  /** Target context length in tokens */
  ctx: number;
  /**
   * 'free': plan for memory that is free right now (default, avoids swapping).
   * 'total': plan for the whole machine, as if other apps were closed.
   */
  memory?: 'free' | 'total';
  workload?: Workload;
  /** Force a specific quant instead of letting the planner choose */
  quantId?: string;
}

export type KvType = 'f16' | 'q8_0' | 'q4_0';
export type SpecType = 'none' | 'ngram-mod' | 'draft-simple' | 'draft-eagle3' | 'draft-mtp';

export interface RunConfig {
  modelId: string;
  /** Which engine runs it. 'mlx' uses mlxVariant instead of quantId's GGUF. */
  backend: EngineBackendId;
  mlxVariant?: string;
  workload: Workload;
  quantId: string;
  /** Request slots served side by side (-np) */
  parallel: number;
  /** Reuse matching chunks of earlier prompts from the KV cache (--cache-reuse); 0 = off */
  cacheReuse: number;
  ctx: number;
  /** Number of layers on the GPU, or 'all' */
  ngl: number | 'all';
  nCpuMoe: number;
  moeCacheMiB: number;
  kvTypeK: KvType;
  kvTypeV: KvType;
  flashAttn: 'on' | 'off' | 'auto';
  threads: number;
  batch: number;
  ubatch: number;
  spec: {
    type: SpecType;
    /** For draft-simple: a catalog model + quant. For eagle3/mtp: the head file in the main repo. */
    draftModelId?: string;
    draftQuantId?: string;
    headFile?: string;
    nMax?: number;
    nMin?: number;
  };
}

export type Fit = 'gpu' | 'partial' | 'cpu' | 'no-fit';

export interface PlanReason {
  kind: 'quant' | 'placement' | 'kv' | 'ctx' | 'spec' | 'threads' | 'batch' | 'warn';
  title: string;
  detail: string;
}

export interface QuantOption {
  quantId: string;
  sizeBytes: number;
  fit: Fit;
  genTps: number;
  qualityPct: number;
  score: number;
  chosen: boolean;
}

export interface Plan {
  modelId: string;
  modelName: string;
  goal: PlanGoal;
  backend: Backend;
  config: RunConfig;
  fit: Fit;
  memory: {
    weightsBytes: number;
    kvBytes: number;
    computeBytes: number;
    gpuBytes: number;
    ramBytes: number;
    gpuBudgetBytes: number;
    ramBudgetBytes: number;
    /** Extra files that have to be downloaded for speculative decoding */
    extraBytes: number;
    /** Memory the OS can give us right now without swapping */
    freeNowBytes: number;
    /** The most this machine could offer with other apps closed */
    machineBytes: number;
  };
  /** Why it doesn't fit: the machine itself, or only what's free right now */
  blockedBy: 'machine' | 'free-memory' | null;
  predicted: {
    genTps: number;
    promptTps: number;
    qualityPct: number;
    qualitySource: 'native' | 'estimate' | 'measured';
    score: number;
    /** Assumed speed-up from speculative decoding, included in genTps */
    specBoost: number;
  };
  /** Predictions scaled by how this machine actually performed in earlier tuning runs */
  calibration: { factor: number; runs: number } | null;
  reasons: PlanReason[];
  warnings: string[];
  options: QuantOption[];
}

// ---------- Tuning + benchmarks ----------

export type WorkloadKey = 'chat' | 'code' | 'edit';

export interface TrialResult {
  label: string;
  config: RunConfig;
  ok: boolean;
  error?: string;
  /** Headline generation speed: the workload-weighted figure the winner is chosen on */
  genTps: number;
  promptTps: number;
  draftAcceptRate: number | null;
  loadMs: number;
  /** Generation speed per kind of prompt: median of every run, with run-to-run spread */
  workloads?: Partial<Record<WorkloadKey, { genTps: number; spread: number }>>;
  /** Speed with real sampling (temperature 0.7), where speculative decoding accepts less */
  sampledTps?: number;
  /** Agent profile: a long prompt's prefill speed and time to first token */
  longPrompt?: { tokens: number; promptTps: number; ttftMs: number };
  /** Batch profile: total tokens per second across parallel requests */
  parallelTps?: number;
  /** What the winner was picked on (higher is better) */
  score?: number;
  /** Stopped after one round because it was clearly slower */
  pruned?: boolean;
}

export interface BenchmarkRecord {
  schema: 1;
  id: string;
  createdAt: string;
  engine: { tag: string; backend: string };
  hardware: {
    os: string;
    cpu: string;
    ramGB: number;
    gpus: string[];
    unifiedMemory: boolean;
  };
  model: { id: string; quantId: string };
  goal: PlanGoal;
  predicted: Plan['predicted'];
  trials: TrialResult[];
  winner: { label: string; config: RunConfig; genTps: number; promptTps: number; qualityPct: number; score: number } | null;
  workload?: Workload;
  /** Best config for each kind of prompt, in case they differ */
  bestPerWorkload?: Partial<Record<WorkloadKey, string>>;
  durationMs: number;
}
