import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EngineSession, LlamaServer, fixtures, freePort, plan, requireModel, type HardwareProfile, type InstalledEngine } from '../src';

const GB = 1e9;

/** The 18 GB M3 Pro from the bug report: other apps hold most of the memory and swap is nearly full. */
const busyMac: HardwareProfile = {
  ...fixtures.macM3Pro18,
  memory: { ...fixtures.macM3Pro18.memory, availableBytes: 2.7 * GB, reclaimableBytes: 4.4 * GB, swapUsedBytes: 21 * GB },
};

describe('planning for memory that is actually free', () => {
  const goal = { mode: 'balanced' as const, ctx: 131072, quantId: 'UD-IQ2_M' };

  it('refuses the 35B-A3B setup that swapped, and says it is free memory, not the machine', () => {
    const p = plan(busyMac, requireModel('qwen3.6-35b-a3b'), goal);
    expect(p.fit).toBe('no-fit');
    expect(p.blockedBy).toBe('free-memory');
    expect(p.warnings.join(' ')).toMatch(/free right now/);
  });

  it('allows it when planning for the whole machine, with a swap warning', () => {
    const p = plan(busyMac, requireModel('qwen3.6-35b-a3b'), { ...goal, memory: 'total' });
    expect(p.fit).not.toBe('no-fit');
    expect(p.warnings.join(' ')).toMatch(/swap/);
  });

  it('still runs small models in what is free', () => {
    const p = plan(busyMac, requireModel('qwen3.5-0.8b'), { mode: 'balanced', ctx: 16384 });
    expect(p.fit).toBe('gpu');
    expect(p.warnings.join(' ')).not.toMatch(/swap/);
  });

  it('counts memory held by our own loaded model as available', () => {
    const m = requireModel('qwen3.5-9b');
    const without = plan(busyMac, m, { mode: 'balanced', ctx: 16384 });
    const withOwn = plan(busyMac, m, { mode: 'balanced', ctx: 16384 }, { ownEngineBytes: 6 * GB });
    expect(withOwn.memory.freeNowBytes).toBeGreaterThan(without.memory.freeNowBytes + 5 * GB);
  });

  it('marks genuinely oversized models as too big for the machine', () => {
    const p = plan(fixtures.rig3060, requireModel('qwen3.8-flash-next'), { mode: 'balanced', ctx: 16384 });
    expect(p.blockedBy).toBe('machine');
  });

  it('applies free memory to system RAM on discrete GPUs too', () => {
    const busyPc: HardwareProfile = { ...fixtures.rig3090, memory: { ...fixtures.rig3090.memory, availableBytes: 8 * GB, reclaimableBytes: 8 * GB } };
    const p = plan(busyPc, requireModel('gpt-oss-120b'), { mode: 'balanced', ctx: 16384 });
    expect(p.blockedBy).toBe('free-memory');
  });
});

// A stand-in for llama-server: answers /health so we can test unload/reload without a real model
const FAKE_SERVER = `#!/usr/bin/env node
const http = require('http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

describe.skipIf(process.platform === 'win32')('idle unload and reload', () => {
  async function fakeEngine(): Promise<InstalledEngine> {
    const dir = await mkdtemp(join(tmpdir(), 'lmx-engine-'));
    const serverPath = join(dir, 'llama-server');
    await writeFile(serverPath, FAKE_SERVER);
    await chmod(serverPath, 0o755);
    return { tag: 'test', backend: 'cpu', suffix: 'test', dir, serverPath, installedAt: '', assets: [] };
  }

  it('unloads after the idle timeout, never mid-request, and reloads on demand', async () => {
    const engine = await fakeEngine();
    const model = requireModel('qwen3.5-0.8b');
    const config = plan(fixtures.macM3Max64, model, { mode: 'balanced', ctx: 4096 }).config;
    const server = new LlamaServer(engine, config, { modelPath: '/fake.gguf' }, await freePort(), model.id);
    server.start();
    await server.waitReady(10_000);

    const session = new EngineSession({ keepAliveMinutes: 10 });
    // Attach the running server as if `run` had started it
    (session as any).server = server;
    (session as any).model = model;
    (session as any).llamaEngine = engine;
    expect(session.status().state).toBe('ready');

    // Not idle long enough: stays loaded
    await (session as any).checkIdle();
    expect(session.status().state).toBe('ready');

    // Idle for longer than the timeout, but a request is in flight: stays loaded
    (session as any).lastUsedAt = Date.now() - 11 * 60_000;
    session.begin();
    (session as any).lastUsedAt = Date.now() - 11 * 60_000;
    await (session as any).checkIdle();
    expect(session.status().state).toBe('ready');
    session.end();

    // Idle and nothing in flight: unloads, process exits, memory freed
    (session as any).lastUsedAt = Date.now() - 11 * 60_000;
    await (session as any).checkIdle();
    expect(session.status().state).toBe('parked');
    expect(session.upstream).toBeNull();
    expect(server.state).toBe('stopped');

    // Next request reloads it with the same config
    const url = await session.ensureUpstream();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.status().state).toBe('ready');
    expect(session.status().config).toEqual(config);
    expect((await fetch(`${url}/health`)).ok).toBe(true);

    // keepAlive 0 = never unload
    session.keepAliveMinutes = 0;
    (session as any).lastUsedAt = Date.now() - 24 * 3600_000;
    await (session as any).checkIdle();
    expect(session.status().state).toBe('ready');

    await session.stop();
    expect(session.status().state).toBe('idle');
  }, 30_000);
});
