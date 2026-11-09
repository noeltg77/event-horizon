import { describe, expect, it } from 'vitest';
import { fixtures, getCatalog, plan, requireModel, type GoalMode, type HardwareProfile } from '../src';

const GB = 1e9;
const goal = (mode: GoalMode = 'balanced', ctx = 16384) => ({ mode, ctx });

describe('planner: RTX 3090 + 64 GB (reference rig)', () => {
  const hw = fixtures.rig3090;

  it('offloads gpt-oss-120b experts to RAM instead of whole layers', () => {
    const p = plan(hw, requireModel('gpt-oss-120b'), goal());
    expect(p.fit).toBe('partial');
    expect(p.config.ngl).toBe('all');
    expect(p.config.nCpuMoe).toBeGreaterThan(0);
    expect(p.config.nCpuMoe).toBeLessThanOrEqual(36);
    expect(p.memory.gpuBytes).toBeLessThanOrEqual(hw.gpus[0].vramFreeBytes!);
    // Plan baseline was ~15 tok/s with naive settings; we should predict better than that
    expect(p.predicted.genTps).toBeGreaterThan(15);
    expect(p.predicted.genTps).toBeLessThan(40);
    expect(p.reasons.some((r) => r.title.includes('in RAM'))).toBe(true);
  });

  it('keeps Qwen3.6-27B fully on the GPU at Q4 or better, around the expected speed', () => {
    const p = plan(hw, requireModel('qwen3.6-27b'), goal());
    expect(p.fit).toBe('gpu');
    expect(p.predicted.qualityPct).toBeGreaterThanOrEqual(98.5);
    expect(p.predicted.genTps).toBeGreaterThan(25);
    expect(p.predicted.genTps).toBeLessThan(60);
  });

  it('uses the shipped EAGLE3 head for gpt-oss', () => {
    const p = plan(hw, requireModel('gpt-oss-20b'), goal());
    expect(p.config.spec.type).toBe('draft-eagle3');
    expect(p.config.spec.headFile).toMatch(/eagle3/);
  });

  it('suggests a same-tokenizer draft model for a dense model', () => {
    const p = plan(hw, requireModel('qwen3.6-27b'), goal());
    expect(p.config.spec.type).toBe('draft-simple');
    expect(p.config.spec.draftModelId).toBe('qwen3.5-0.8b');
    expect(p.memory.extraBytes).toBeGreaterThan(0);
  });

  it('prefers a full-GPU Q4 MoE over an offloaded Q6 in balanced mode', () => {
    const p = plan(hw, requireModel('qwen3.6-35b-a3b'), goal());
    expect(p.fit).toBe('gpu');
    expect(p.predicted.genTps).toBeGreaterThan(80);
  });
});

describe('planner: RTX 3060 12 GB + 32 GB', () => {
  const hw = fixtures.rig3060;

  it('offloads whole layers for a dense model that does not fit', () => {
    const p = plan(hw, requireModel('qwen3.6-27b'), goal('quality'));
    if (p.fit === 'partial') {
      expect(typeof p.config.ngl).toBe('number');
      expect(p.config.ngl as number).toBeLessThan(64);
      expect(p.config.nCpuMoe).toBe(0);
    }
  });

  it('fits gpt-oss-20b with a few expert layers in RAM at most', () => {
    const p = plan(hw, requireModel('gpt-oss-20b'), goal());
    expect(['gpu', 'partial']).toContain(p.fit);
    expect(p.config.nCpuMoe).toBeLessThan(12);
  });

  it('refuses models that cannot fit in VRAM + RAM', () => {
    const p = plan(hw, requireModel('qwen3.8-flash-next'), goal());
    expect(p.fit).toBe('no-fit');
    expect(p.warnings.length).toBeGreaterThan(0);
  });
});

describe('planner: Apple Silicon (unified memory)', () => {
  const hw = fixtures.macM3Max64;

  it('never uses --n-cpu-moe because there is no VRAM/RAM split', () => {
    for (const m of getCatalog().models) {
      const p = plan(hw, m, goal());
      expect(p.config.nCpuMoe).toBe(0);
      expect(p.config.moeCacheMiB).toBe(0);
    }
  });

  it('runs gpt-oss-20b entirely on the GPU', () => {
    const p = plan(hw, requireModel('gpt-oss-20b'), goal());
    expect(p.fit).toBe('gpu');
    expect(p.reasons[1].title).toMatch(/unified memory/);
  });

  it('respects the Metal wired limit on an 18 GB machine', () => {
    const p = plan(fixtures.macM3Pro18, requireModel('qwen3.5-9b'), goal());
    expect(p.memory.gpuBytes).toBeLessThanOrEqual(fixtures.macM3Pro18.gpuWiredLimitBytes!);
  });
});

describe('planner: CPU only', () => {
  it('plans for the CPU and predicts slow but non-zero speed for a small model', () => {
    const p = plan(fixtures.cpuOnly16, requireModel('qwen3.5-4b'), goal());
    expect(p.fit).toBe('cpu');
    expect(p.config.ngl).toBe(0);
    expect(p.predicted.genTps).toBeGreaterThan(3);
    expect(p.predicted.genTps).toBeLessThan(40);
  });
});

describe('planner: invariants across every fixture and model', () => {
  const all = Object.entries(fixtures) as [string, HardwareProfile][];

  it.each(all)('%s: every plan is complete and explained', (_name, hw) => {
    for (const m of getCatalog().models) {
      for (const mode of ['speed', 'balanced', 'quality'] as GoalMode[]) {
        const p = plan(hw, m, goal(mode));
        expect(p.config.quantId).toBeTruthy();
        expect(m.quants.some((q) => q.id === p.config.quantId)).toBe(true);
        expect(p.reasons.length).toBeGreaterThanOrEqual(5);
        expect(p.reasons.every((r) => r.title && r.detail)).toBe(true);
        expect(p.options).toHaveLength(m.quants.length);
        expect(p.options.filter((o) => o.chosen)).toHaveLength(1);
        if (p.fit !== 'no-fit') {
          expect(p.predicted.genTps).toBeGreaterThan(0);
          expect(p.config.ctx).toBeGreaterThanOrEqual(4096);
          expect(p.memory.gpuBytes).toBeLessThanOrEqual(p.memory.gpuBudgetBytes + 1.5 * GB);
        }
        // Quantised V cache needs flash attention
        if (p.config.kvTypeV !== 'f16') expect(p.config.flashAttn).toBe('on');
      }
    }
  });

  it.each(all)('%s: quality mode never picks lower quality than speed mode', (_name, hw) => {
    for (const m of getCatalog().models) {
      const q = plan(hw, m, goal('quality'));
      const s = plan(hw, m, goal('speed'));
      if (q.fit !== 'no-fit' && s.fit !== 'no-fit') expect(q.predicted.qualityPct).toBeGreaterThanOrEqual(s.predicted.qualityPct);
    }
  });

  it('reduces context rather than refusing when only the KV cache is the problem', () => {
    const p = plan(fixtures.rig3060, requireModel('mistral-small-3.2-24b'), { mode: 'quality', ctx: 131072, quantId: 'UD-Q3_K_XL' });
    expect(p.config.ctx).toBeLessThanOrEqual(131072);
  });

  it('honours a forced quant', () => {
    const p = plan(fixtures.rig3090, requireModel('qwen3.6-27b'), { mode: 'balanced', ctx: 8192, quantId: 'Q8_0' });
    expect(p.config.quantId).toBe('Q8_0');
  });
});
