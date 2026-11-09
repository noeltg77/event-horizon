import type { CatalogModel, HardwareProfile, KvType } from '../types';
import { GiB } from '../util';

const KV_BYTES: Record<KvType, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };

/** KV cache size for a context length. Sliding-window layers only keep the window; linear-attention layers keep a small fixed state. */
export function kvCacheBytes(model: CatalogModel, ctx: number, k: KvType, v: KvType): number {
  const a = model.arch;
  const perTokenPerLayer = a.kvHeads * a.headDim * (KV_BYTES[k] + KV_BYTES[v]);
  const full = a.fullAttnLayers * ctx * perTokenPerLayer;
  const swa = a.swaLayers * Math.min(ctx, a.slidingWindow ?? ctx) * perTokenPerLayer;
  const linear = a.linearAttnLayers * 4 * 1024 * 1024; // recurrent state, a few MB per layer
  return full + swa + linear;
}

/** Scratch buffers the backend allocates for a forward pass. Grows with ubatch and vocab. */
export function computeBufferBytes(model: CatalogModel, ubatch: number): number {
  const vocabTerm = (model.arch.vocab ?? 150000) / 150000;
  return 0.35 * GiB + (ubatch / 512) * 0.3 * GiB * Math.max(1, vocabTerm * 0.8);
}

/** Embedding + output head. The output head is read on every token; the embedding only one row. */
export function nonLayerBytes(model: CatalogModel, weightsBytes: number, bpw: number): { embed: number; output: number } {
  const a = model.arch;
  const one = (a.vocab * a.hidden * Math.max(bpw, 4.5)) / 8;
  // Never let this exceed a third of the model (protects tiny models with huge vocabularies)
  const capped = Math.min(one, weightsBytes / 3);
  return { embed: capped, output: capped };
}

export interface Budgets {
  /** Memory the GPU can hold for us (VRAM, or Metal's wired limit on Apple Silicon) */
  gpu: number;
  /** Memory available for weights that live on the CPU side */
  ram: number;
  /** Apple Silicon: the hard ceiling for everything together */
  unifiedCap: number | null;
  /** Memory free right now (plus whatever our own engine already holds) */
  freeNow: number;
  /** What the machine could offer with other apps closed */
  machine: number;
  gpuBandwidth: number;
  ramBandwidth: number;
  primaryGpu: HardwareProfile['gpus'][number] | null;
}

/**
 * How much memory a model may use.
 * mode 'free' (default) plans for what the OS can hand over right now without swapping;
 * 'total' plans for the whole machine as if other apps were closed.
 * `ownEngineBytes` is memory held by a model we already have loaded, which we'd free first.
 */
export function budgets(hw: HardwareProfile, mode: 'free' | 'total' = 'free', ownEngineBytes = 0): Budgets {
  const primary = [...hw.gpus].sort((a, b) => b.vramBytes - a.vramBytes)[0] ?? null;
  const reclaimable = Math.max(hw.memory.availableBytes, hw.memory.reclaimableBytes ?? 0);
  // Keep 1 GiB back so the OS and the app you're using don't start swapping
  const freeNow = Math.max(0, reclaimable + ownEngineBytes - 1 * GiB);
  const common = { gpuBandwidth: primary?.bandwidthGBs ?? 0, ramBandwidth: hw.memory.bandwidthGBs, primaryGpu: primary, freeNow };
  if (hw.unifiedMemory && primary) {
    const machine = hw.memory.totalBytes - 3.5 * GiB;
    const cap = mode === 'free' ? Math.min(machine, freeNow) : machine;
    const wired = hw.gpuWiredLimitBytes ?? primary.vramBytes;
    const gpu = Math.max(0, Math.min(wired - 0.75 * GiB, cap));
    return { ...common, gpu, ram: Math.max(0, cap - gpu), unifiedCap: cap, machine };
  }
  const machine = Math.max(0, hw.memory.totalBytes - 6 * GiB);
  const ram = mode === 'free' ? Math.min(machine, freeNow) : machine;
  if (!primary || hw.backend === 'cpu') {
    return { ...common, gpu: 0, ram, unifiedCap: null, gpuBandwidth: 0, primaryGpu: null, machine };
  }
  const vramFree = primary.vramFreeBytes ?? primary.vramBytes * 0.94;
  return { ...common, gpu: Math.max(0, vramFree - 0.5 * GiB), ram, unifiedCap: null, machine };
}
