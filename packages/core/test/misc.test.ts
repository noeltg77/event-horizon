import { describe, expect, it } from 'vitest';
import {
  appleBandwidth,
  estimateQuality,
  getCatalog,
  getModel,
  gpuBandwidth,
  kvCacheBytes,
  parseMetrics,
  parseNvidiaSmi,
  qualityFactor,
  ramBandwidth,
  requireModel,
  score,
} from '../src';

describe('catalog integrity', () => {
  const { models } = getCatalog();

  it('has the launch models from the plan', () => {
    for (const id of ['qwen3.6-27b', 'mistral-small-3.2-24b', 'qwen3.6-35b-a3b', 'gpt-oss-20b', 'gemma-4-26b-a4b', 'gpt-oss-120b', 'glm-4.5-air', 'qwen3-next-80b-a3b', 'qwen3.5-122b-a10b', 'qwen3.8-flash-next']) {
      expect(getModel(id), id).toBeTruthy();
    }
  });

  it.each(models.map((m) => [m.id, m] as const))('%s has verified files and sane architecture', (_id, m) => {
    expect(m.quants.length).toBeGreaterThan(0);
    for (const q of m.quants) {
      expect(q.files.length).toBeGreaterThan(0);
      for (const f of q.files) {
        expect(f.sha256, `${m.id} ${f.path}`).toMatch(/^[0-9a-f]{64}$/);
        expect(f.size).toBeGreaterThan(0);
      }
      expect(q.sizeBytes).toBe(q.files.reduce((s, f) => s + f.size, 0));
    }
    expect(m.arch.layers).toBeGreaterThan(0);
    expect(m.arch.activeParamsB).toBeGreaterThan(0);
    expect(m.arch.activeParamsB).toBeLessThanOrEqual(m.arch.totalParamsB);
    if (m.arch.type === 'moe') expect(m.arch.expertFraction).toBeGreaterThan(0.5);
    if (m.draft) expect(getModel(m.draft.modelId)?.quants.some((q) => q.id === m.draft!.quantId)).toBe(true);
  });
});

describe('quality and score', () => {
  it('treats native formats as lossless', () => {
    const m = requireModel('gpt-oss-120b');
    expect(estimateQuality(m, m.quants[0])).toBe(100);
  });

  it('ranks Q8 above Q4 above Q2', () => {
    const m = requireModel('qwen3.6-27b');
    const q = (id: string) => estimateQuality(m, m.quants.find((x) => x.id === id)!);
    expect(q('Q8_0')).toBeGreaterThan(q('UD-Q4_K_XL'));
    expect(q('UD-Q4_K_XL')).toBeGreaterThan(q('UD-Q2_K_XL'));
  });

  it('falls off a cliff below 97% so junk quants cannot win', () => {
    expect(qualityFactor(99)).toBeGreaterThan(0.97);
    expect(qualityFactor(95)).toBeLessThan(0.5);
    // 100 tok/s at 90% quality loses to 30 tok/s at 99%
    expect(score(100, 90)).toBeLessThan(score(30, 99));
  });

  it('matches the headline example shape', () => {
    expect(score(47, 99.2)).toBeGreaterThan(4500);
    expect(score(47, 99.2)).toBeLessThan(4700);
  });
});

describe('hardware tables and parsers', () => {
  it('looks up bandwidth', () => {
    expect(appleBandwidth('M3 Pro')).toBe(150);
    expect(appleBandwidth('M3 Max')).toBe(400);
    expect(appleBandwidth('M4')).toBe(120);
    expect(gpuBandwidth('NVIDIA GeForce RTX 3090')).toBe(936);
    expect(gpuBandwidth('NVIDIA GeForce RTX 3090 Ti')).toBe(1008);
    expect(gpuBandwidth('NVIDIA GeForce RTX 4070 Ti SUPER')).toBe(672);
    expect(gpuBandwidth('Mystery GPU')).toBeNull();
    expect(ramBandwidth(3600, 2, 'DDR4').gbs).toBe(58);
    expect(ramBandwidth(null, null, 'DDR5').measured).toBe(false);
  });

  it('parses nvidia-smi output', () => {
    const gpus = parseNvidiaSmi('NVIDIA GeForce RTX 3090, 24576, 23800, 4, 16, 580.97\n');
    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({ vendor: 'nvidia', bandwidthGBs: 936, pcie: { gen: 4, width: 16 }, driver: '580.97' });
    expect(gpus[0].vramBytes).toBe(24576 * 1024 * 1024);
  });

  it('parses llama-server Prometheus metrics', () => {
    const m = parseMetrics(
      '# HELP llamacpp:tokens_predicted_total x\n# TYPE llamacpp:tokens_predicted_total counter\nllamacpp:tokens_predicted_total 1234\nllamacpp:predicted_tokens_seconds 41.5\nllamacpp:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 7\n',
    );
    expect(m.tokens_predicted_total).toBe(1234);
    expect(m.predicted_tokens_seconds).toBe(41.5);
    expect(m.spec_decode_num_accepted_tokens_per_pos_total).toBe(7);
  });
});

describe('KV cache maths', () => {
  it('is much smaller for hybrid linear-attention models', () => {
    const dense = requireModel('mistral-small-3.2-24b');
    const hybrid = requireModel('qwen3.6-27b');
    expect(kvCacheBytes(hybrid, 32768, 'f16', 'f16')).toBeLessThan(kvCacheBytes(dense, 32768, 'f16', 'f16'));
  });

  it('caps sliding-window layers at the window', () => {
    const m = requireModel('gpt-oss-20b');
    const a = kvCacheBytes(m, 32768, 'f16', 'f16');
    const b = kvCacheBytes(m, 65536, 'f16', 'f16');
    // Only the full-attention half of the layers grows with context
    expect(b / a).toBeLessThan(2);
    expect(b).toBeGreaterThan(a);
  });

  it('halves (roughly) with q8_0', () => {
    const m = requireModel('mistral-small-3.2-24b');
    const r = kvCacheBytes(m, 16384, 'q8_0', 'q8_0') / kvCacheBytes(m, 16384, 'f16', 'f16');
    expect(r).toBeCloseTo(0.53, 1);
  });
});
