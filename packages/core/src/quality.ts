import type { CatalogModel, CatalogQuant } from './types';

// Quality = 100 × e^(−mean KL divergence) against the full-precision model: the share of
// the original model's predictive information a quant keeps. It is measured with
// llama-perplexity where the reference fits in memory (see quality-measure.ts); otherwise
// estimated from typical published llama.cpp KLD figures per quant type, on the same scale.

/** Typical mean KLD vs BF16 for a mid-size (~8–30B) dense model. */
const KLD_BY_TYPE: [RegExp, number][] = [
  [/^(BF16|F16)$/, 0],
  [/Q8_0|Q8_K/, 0.0008],
  [/Q6_K/, 0.004],
  [/Q5_K/, 0.009],
  [/Q4_K/, 0.025],
  [/IQ4_NL|IQ4_XS/, 0.03],
  [/MXFP4/, 0.03],
  [/Q4_[01]/, 0.035],
  [/Q3_K_XL|Q3_K_L/, 0.06],
  [/Q3_K_M/, 0.08],
  [/IQ3_S|IQ3_M/, 0.1],
  [/IQ3_XXS|IQ3_XS/, 0.14],
  [/Q3_K_S/, 0.14],
  [/Q2_K_XL|Q2_K_L/, 0.22],
  [/IQ2_M|IQ2_S/, 0.28],
  [/Q2_K|Q2_0/, 0.3],
  [/IQ2_XS|IQ2_XXS/, 0.42],
  [/IQ1_M/, 0.7],
  [/IQ1_S|TQ1_0/, 0.9],
];

/** MLX affine quantisation by bits (group size 64), same scale. */
const KLD_MLX: Record<number, number> = { 8: 0.0012, 6: 0.006, 5: 0.014, 4: 0.04, 3: 0.12 };

export function kldToQuality(kld: number): number {
  return Math.round(100 * Math.exp(-Math.max(0, kld)) * 100) / 100;
}

function sizeFactor(model: CatalogModel): number {
  // Bigger models (and especially big MoEs) tolerate quantisation better; tiny ones suffer more
  const p = model.arch.totalParamsB;
  if (p >= 60) return 0.6;
  if (p >= 20) return 0.85;
  if (p < 3) return 1.6;
  if (p < 6) return 1.2;
  return 1;
}

export function estimateKld(model: CatalogModel, quant: CatalogQuant): number {
  if (quant.native) return 0;
  const id = quant.id.replace(/^UD-/, '');
  const base = KLD_BY_TYPE.find(([re]) => re.test(id))?.[1] ?? 0.05;
  // Unsloth Dynamic quants keep sensitive layers at higher precision: roughly a third less loss
  return base * (quant.id.startsWith('UD-') ? 0.7 : 1) * sizeFactor(model);
}

export function estimateMlxQuality(model: CatalogModel, bits: number): number {
  return kldToQuality((KLD_MLX[bits] ?? 0.05) * sizeFactor(model));
}

/** Measured results keyed by `${modelId}/${quantId}`. */
export type MeasuredQuality = Record<string, { qualityPct: number; kld: number; samePct: number; measuredAt: string; reference: string }>;

export interface QualityInfo {
  pct: number;
  source: 'native' | 'measured' | 'estimate';
  kld: number;
}

/** Quality for a quant: measured if we have a measurement, otherwise estimated. */
export function qualityOf(model: CatalogModel, quant: CatalogQuant, measured?: MeasuredQuality): QualityInfo {
  if (quant.native) return { pct: 100, source: 'native', kld: 0 };
  const m = measured?.[`${model.id}/${quant.id}`];
  if (m) return { pct: m.qualityPct, source: 'measured', kld: m.kld };
  const kld = estimateKld(model, quant);
  return { pct: kldToQuality(kld), source: 'estimate', kld };
}

/** Estimated share of full-precision quality kept, as a percentage. */
export function estimateQuality(model: CatalogModel, quant: CatalogQuant): number {
  return qualityOf(model, quant).pct;
}

/**
 * The score multiplies speed by a quality factor that falls off a cliff below 97%,
 * so crushing a model into junk can never win the leaderboard.
 */
export function qualityFactor(qualityPct: number): number {
  const q = qualityPct / 100;
  if (q >= 0.97) return q * q;
  return 0.97 * 0.97 * Math.exp(-(0.97 - q) * 40);
}

export function score(genTps: number, qualityPct: number): number {
  return Math.round(genTps * 100 * qualityFactor(qualityPct));
}
