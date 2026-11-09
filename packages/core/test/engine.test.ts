import { describe, expect, it } from 'vitest';
import { assetNameFor, buildServerArgs, fixtures, plan, requireModel, selectEngine, tuneCandidates, type HardwareProfile } from '../src';

describe('engine selection', () => {
  it('picks Metal on Apple Silicon', () => {
    const s = selectEngine(fixtures.macM3Max64);
    expect(s).toMatchObject({ backend: 'metal', suffix: 'macos-arm64' });
    expect(assetNameFor('b12202', s.suffix)).toBe('llama-b12202-bin-macos-arm64.tar.gz');
  });

  it('picks CUDA 13 + runtime DLLs on Windows with a 580+ driver', () => {
    const s = selectEngine(fixtures.rig3090);
    expect(s).toMatchObject({ backend: 'cuda', suffix: 'win-cuda-13.5-x64', runtimeAsset: 'cudart-llama-bin-win-cuda-13.5-x64.zip' });
    expect(assetNameFor('b12202', s.suffix)).toBe('llama-b12202-bin-win-cuda-13.5-x64.zip');
  });

  it('falls back to CUDA 12.4 on older Windows drivers', () => {
    expect(selectEngine(fixtures.rig3060).suffix).toBe('win-cuda-12.4-x64');
  });

  it('picks Vulkan for AMD on Windows and CPU when there is no GPU', () => {
    const amd: HardwareProfile = {
      ...fixtures.rig3060,
      gpus: [{ ...fixtures.rig3060.gpus[0], vendor: 'amd', model: 'AMD Radeon RX 7900 XTX', driver: undefined }],
    };
    expect(selectEngine(amd).suffix).toBe('win-vulkan-x64');
    expect(selectEngine(fixtures.cpuOnly16).suffix).toBe('win-cpu-x64');
  });

  it('picks Linux builds', () => {
    const linux: HardwareProfile = { ...fixtures.rig3090, os: { ...fixtures.rig3090.os, platform: 'linux' } };
    expect(selectEngine(linux).suffix).toBe('ubuntu-cuda-13.5-x64');
    expect(assetNameFor('b12202', 'ubuntu-cuda-13.5-x64')).toMatch(/\.tar\.gz$/);
  });
});

describe('tuner candidates', () => {
  const model = requireModel('qwen3.5-9b');
  const base = plan(fixtures.rig3090, model, { mode: 'balanced', ctx: 16384 });
  const withKv = (headroom: number) => ({
    ...base,
    fit: 'gpu' as const,
    config: { ...base.config, kvTypeK: 'q8_0' as const, kvTypeV: 'q8_0' as const },
    memory: { ...base.memory, gpuBudgetBytes: 10e9 + headroom, gpuBytes: 10e9, kvBytes: 1e9 },
  });

  it('tries a full-precision KV cache when the planner chose 8-bit and there is room', () => {
    const c = tuneCandidates(withKv(3e9), model, fixtures.rig3090, 6);
    expect(c.some((x) => x.config.kvTypeK === 'f16' && x.config.kvTypeV === 'f16' && x.config.flashAttn === 'auto')).toBe(true);
  });

  it('does not try it when memory is tight', () => {
    const c = tuneCandidates(withKv(0.5e9), model, fixtures.rig3090, 6);
    expect(c.some((x) => x.config.kvTypeK === 'f16')).toBe(false);
  });
});

describe('llama-server arguments', () => {
  const net = { host: '127.0.0.1', port: 9000, alias: 'm' };

  it('maps an MoE offload plan to the verified flags', () => {
    const p = plan(fixtures.rig3090, requireModel('gpt-oss-120b'), { mode: 'balanced', ctx: 16384 });
    const args = buildServerArgs(p.config, { modelPath: '/m.gguf', specPath: '/eagle.gguf' }, net);
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(flag('-m')).toBe('/m.gguf');
    expect(flag('-ngl')).toBe('all');
    expect(flag('--n-cpu-moe')).toBe(String(p.config.nCpuMoe));
    expect(flag('-c')).toBe('16384');
    expect(flag('--spec-type')).toBe('draft-eagle3');
    expect(flag('--spec-draft-model')).toBe('/eagle.gguf');
    expect(flag('--host')).toBe('127.0.0.1');
    expect(args).toContain('--metrics');
    expect(args).toContain('--no-webui');
  });

  it('never emits flags removed upstream', () => {
    const p = plan(fixtures.rig3090, requireModel('qwen3.6-27b'), { mode: 'balanced', ctx: 8192 });
    const args = buildServerArgs(p.config, { modelPath: '/m.gguf', specPath: '/d.gguf' }, net);
    for (const removed of ['--draft-max', '--draft-min', '--draft', '-fa=true']) expect(args).not.toContain(removed);
    expect(args).toContain('--spec-draft-n-max');
    expect(args[args.indexOf('-fa') + 1]).toMatch(/^(on|off|auto)$/);
  });

  it('skips draft flags when the draft file is missing', () => {
    const p = plan(fixtures.rig3090, requireModel('qwen3.6-27b'), { mode: 'balanced', ctx: 8192 });
    const args = buildServerArgs(p.config, { modelPath: '/m.gguf' }, net);
    expect(args).not.toContain('--spec-draft-model');
  });

  it('uses draftless n-gram lookahead without a draft model', () => {
    const p = plan(fixtures.rig3090, requireModel('qwen3.5-122b-a10b'), { mode: 'balanced', ctx: 8192 });
    const args = buildServerArgs({ ...p.config, spec: { type: 'ngram-mod' } }, { modelPath: '/m.gguf' }, net);
    expect(args[args.indexOf('--spec-type') + 1]).toBe('ngram-mod');
    expect(args).not.toContain('--spec-draft-model');
  });
});
