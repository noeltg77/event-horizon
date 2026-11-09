import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EngineSession,
  LlamaServer,
  buildServerArgs,
  closestMlx,
  fixtures,
  freePort,
  kldToQuality,
  parseKld,
  pickWinner,
  plan,
  qualityOf,
  requireModel,
  trialScore,
  tuneCandidates,
  validWiredMb,
  weightedSpeed,
  type InstalledEngine,
  type TrialResult,
} from '../src';

const model = requireModel('qwen3-4b-2507');

describe('1.1–1.3 tuner: workloads and winner choice', () => {
  it('weights chat most for the chat profile, so a fast copy-back edit cannot win on its own', () => {
    const ngram = { chat: { genTps: 30, spread: 0 }, code: { genTps: 31, spread: 0 }, edit: { genTps: 90, spread: 0 } };
    const plain = { chat: { genTps: 34, spread: 0 }, code: { genTps: 33, spread: 0 }, edit: { genTps: 34, spread: 0 } };
    expect(weightedSpeed(plain, 'chat')).toBeGreaterThan(weightedSpeed(ngram, 'chat'));
    // ...but for agents, which edit a lot, lookahead can win
    expect(weightedSpeed(ngram, 'agent')).toBeGreaterThan(weightedSpeed(plain, 'agent'));
  });

  it('scores agents on a whole turn including the long prompt, and batch on total throughput', () => {
    const base: TrialResult = { label: 'a', config: plan(fixtures.rig3090, model, { mode: 'balanced', ctx: 8192 }).config, ok: true, genTps: 40, promptTps: 500, draftAcceptRate: null, loadMs: 0 };
    const slowPrefill = { ...base, longPrompt: { tokens: 6000, promptTps: 600, ttftMs: 10_000 } };
    const fastPrefill = { ...base, genTps: 36, longPrompt: { tokens: 6000, promptTps: 3000, ttftMs: 2000 } };
    expect(trialScore(fastPrefill, 'agent', 99)).toBeGreaterThan(trialScore(slowPrefill, 'agent', 99));
    expect(trialScore({ ...base, parallelTps: 150 }, 'batch', 99)).toBeGreaterThan(trialScore(base, 'batch', 99));
  });

  it('penalises lower-quality weights in the score', () => {
    const t: TrialResult = { label: 'a', config: plan(fixtures.rig3090, model, { mode: 'balanced', ctx: 8192 }).config, ok: true, genTps: 40, promptTps: 0, draftAcceptRate: null, loadMs: 0 };
    expect(trialScore(t, 'chat', 99.5)).toBeGreaterThan(trialScore(t, 'chat', 95));
  });

  it('reports the best config per workload alongside the overall winner', () => {
    const cfg = plan(fixtures.rig3090, model, { mode: 'balanced', ctx: 8192 }).config;
    const a: TrialResult = { label: 'Planner pick', config: cfg, ok: true, genTps: 34, promptTps: 0, draftAcceptRate: null, loadMs: 0, score: 34, workloads: { chat: { genTps: 34, spread: 0 }, edit: { genTps: 34, spread: 0 } } };
    const b: TrialResult = { label: 'N-gram lookahead', config: cfg, ok: true, genTps: 32, promptTps: 0, draftAcceptRate: null, loadMs: 0, score: 32, workloads: { chat: { genTps: 31, spread: 0 }, edit: { genTps: 80, spread: 0 } } };
    const { winner, bestPerWorkload } = pickWinner([a, b]);
    expect(winner?.label).toBe('Planner pick');
    expect(bestPerWorkload.edit).toBe('N-gram lookahead');
  });

  it('adds an MLX candidate on Apple Silicon when one is available', () => {
    const p = plan(fixtures.macM3Max64, model, { mode: 'balanced', ctx: 8192 });
    const c = tuneCandidates(p, model, fixtures.macM3Max64, { max: 5, mlx: { variantId: '5bit', bits: 5, qualityPct: 98.9 } });
    const mlx = c.find((x) => x.config.backend === 'mlx');
    expect(mlx?.config.mlxVariant).toBe('5bit');
    expect(mlx?.qualityPct).toBe(98.9);
  });
});

describe('1.4 measured quality', () => {
  it('reads llama-perplexity output', () => {
    const out = '...\nMean    KLD:   0.012345 ±   0.000400\nMaximum KLD:   2.1\nSame top p: 95.123 ± 0.321 %\n';
    expect(parseKld(out)).toEqual({ kld: 0.012345, samePct: 95.123 });
    expect(parseKld('nothing here')).toBeNull();
  });

  it('uses e^-KLD as the quality scale', () => {
    expect(kldToQuality(0)).toBe(100);
    expect(kldToQuality(0.008)).toBeCloseTo(99.2, 1);
    expect(kldToQuality(0.3)).toBeLessThan(75);
  });

  it('prefers a measurement over the estimate', () => {
    const q = model.quants.find((x) => x.id === 'UD-Q5_K_XL')!;
    const est = qualityOf(model, q);
    const meas = qualityOf(model, q, { [`${model.id}/${q.id}`]: { qualityPct: 99.1, kld: 0.009, samePct: 96, measuredAt: '', reference: 'Q8_0' } });
    expect(est.source).toBe('estimate');
    expect(meas).toMatchObject({ pct: 99.1, source: 'measured' });
    const p = plan(fixtures.macM3Max64, model, { mode: 'balanced', ctx: 8192, quantId: q.id }, { measured: { [`${model.id}/${q.id}`]: { qualityPct: 99.1, kld: 0.009, samePct: 96, measuredAt: '', reference: 'Q8_0' } } });
    expect(p.predicted.qualitySource).toBe('measured');
  });
});

describe('1.5 calibration', () => {
  it('scales predictions by how this machine actually performed', () => {
    const goal = { mode: 'balanced' as const, ctx: 8192 };
    const raw = plan(fixtures.macM3Max64, model, goal);
    const key = `metal|dense|${raw.fit}`;
    const cal = plan(fixtures.macM3Max64, model, goal, { calibration: { [key]: { factor: 0.8, runs: 3 } } });
    expect(cal.predicted.genTps).toBeLessThan(raw.predicted.genTps * 0.85);
    expect(cal.calibration).toEqual({ factor: 0.8, runs: 3 });
  });
});

describe('1.6 draft models', () => {
  it('pairs small Qwen models with a same-tokenizer draft', () => {
    expect(requireModel('qwen3-4b-2507').draft?.modelId).toBe('qwen3-0.6b');
    expect(requireModel('qwen3.5-4b').draft?.modelId).toBe('qwen3.5-0.8b');
  });

  it('lets the tuner try the draft for small models instead of assuming it helps', () => {
    // Measured on an M3 Pro: a 0.6B draft made a 4B target 3x slower, so it must be tested, not assumed
    const p = plan(fixtures.macM3Max64, model, { mode: 'balanced', ctx: 8192 });
    expect(p.config.spec.type).toBe('none');
    expect(p.predicted.specBoost).toBe(1);
    const labels = tuneCandidates(p, model, fixtures.macM3Max64, 6).map((c) => c.label);
    expect(labels).toContain('Draft model');
    expect(labels).toContain('N-gram lookahead');
  });

  it('still defaults to a draft for big dense models, and records the assumed boost', () => {
    const big = plan(fixtures.rig3090, requireModel('qwen3.6-27b'), { mode: 'balanced', ctx: 8192 });
    expect(big.config.spec.type).toBe('draft-simple');
    expect(big.predicted.specBoost).toBeGreaterThan(1);
    const labels = tuneCandidates(big, requireModel('qwen3.6-27b'), fixtures.rig3090, 6).map((c) => c.label);
    expect(labels).toContain('Without speculative decoding');
    expect(labels).toContain('N-gram lookahead');
  });
});

describe('2.1 MLX', () => {
  it('picks the MLX build closest in precision to the GGUF quant', () => {
    expect(closestMlx(model, 4.6)?.bits).toBe(4);
    expect(closestMlx(model, 8.5)?.bits).toBe(8);
  });
});

describe('2.2 wired limit', () => {
  it('only accepts safe values', () => {
    expect(validWiredMb(0, 18432)).toBe(true);
    expect(validWiredMb(14336, 18432)).toBe(true);
    expect(validWiredMb(18000, 18432)).toBe(false);
    expect(validWiredMb(12.5, 18432)).toBe(false);
  });
});

describe('3.1 workload profiles', () => {
  it('agents get two slots sharing a doubled KV cache, prompt-cache reuse and slot saving', () => {
    const chat = plan(fixtures.rig3090, model, { mode: 'balanced', ctx: 16384 });
    const agent = plan(fixtures.rig3090, model, { mode: 'balanced', ctx: 16384, workload: 'agent' });
    expect(chat.config.parallel).toBe(1);
    expect(agent.config.parallel).toBe(2);
    expect(agent.config.ctx).toBe(32768);
    expect(agent.memory.kvBytes).toBeGreaterThan(chat.memory.kvBytes * 1.8);
    const args = buildServerArgs(agent.config, { modelPath: '/m.gguf', slotSavePath: '/slots' }, { host: '127.0.0.1', port: 1, alias: 'm' });
    expect(args[args.indexOf('-np') + 1]).toBe('2');
    expect(args).toContain('--kv-unified');
    expect(args[args.indexOf('--cache-reuse') + 1]).toBe('256');
    expect(args[args.indexOf('--slot-save-path') + 1]).toBe('/slots/');
  });

  it('batch runs eight slots', () => {
    expect(plan(fixtures.rig3090, model, { mode: 'balanced', ctx: 8192, workload: 'batch' }).config.parallel).toBe(8);
  });
});

// Stand-in llama-server that records slot save/restore requests
const FAKE = (log: string) => `#!/usr/bin/env node
const http = require('http'); const fs = require('fs');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c);
  req.on('end', () => {
    if (req.url.startsWith('/slots/')) fs.appendFileSync(${JSON.stringify(log)}, req.url + ' ' + body + '\\n');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

describe.skipIf(process.platform === 'win32')('3.2 agent prompt cache survives idle unload', () => {
  it('saves every slot when unloading and restores them on reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lmx-slots-'));
    const log = join(dir, 'slots.log');
    const serverPath = join(dir, 'llama-server');
    await writeFile(serverPath, FAKE(log));
    await chmod(serverPath, 0o755);
    const engine: InstalledEngine = { tag: 'test', backend: 'cpu', suffix: 'test', dir, serverPath, installedAt: '', assets: [] };
    const config = plan(fixtures.macM3Max64, model, { mode: 'balanced', ctx: 4096, workload: 'agent' }).config;
    const server = new LlamaServer(engine, config, { modelPath: '/fake.gguf' }, await freePort(), model.id);
    server.start();
    await server.waitReady(10_000);
    const session = new EngineSession({ keepAliveMinutes: 10 });
    Object.assign(session as any, { server, model, llamaEngine: engine });

    await session.park();
    expect(session.status().state).toBe('parked');
    await session.ensureUpstream();
    expect(session.status().state).toBe('ready');
    const calls = await readFile(log, 'utf8');
    expect(calls).toMatch(/\/slots\/0\?action=save .*qwen3-4b-2507-slot0\.bin/);
    expect(calls).toMatch(/\/slots\/1\?action=save/);
    await session.stop();
  }, 30_000);
});

describe('benchmarks never repeat a prompt', () => {
  it('uses different prompts in each tuner round and each compare round', async () => {
    const { tuneRound, COMPARE_POOLS } = await import('../src');
    const r0 = tuneRound(0).map((p) => p.prompt);
    const r1 = tuneRound(1).map((p) => p.prompt);
    expect(new Set([...r0, ...r1]).size).toBe(r0.length + r1.length);
    for (const pool of COMPARE_POOLS) expect(new Set(pool.slice(0, 3)).size).toBe(3);
  });
});
