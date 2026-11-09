import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  EngineSession,
  Monitor,
  fixtures,
  getCatalog,
  getHardware,
  getInstalledEngine,
  installEngine,
  listBenchmarks,
  listDownloaded,
  partialBytes,
  plan as makePlan,
  pullQuant,
  requireModel,
  getQuant,
  deleteQuant,
  freeDiskBytes,
  commandLine,
  buildServerArgs,
  modelEntryPath,
  PINNED_ENGINE_TAG,
  processRss,
  saveSettings,
  detectContenders,
  runComparison,
  listComparisons,
  loadMeasuredQuality,
  loadCalibration,
  canMeasureQuality,
  measureQuality,
  wiredLimitInfo,
  applyWiredLimit,
  getInstalledMlx,
  installMlx,
  mlxSupported,
  type ContenderId,
  type Workload,
  type GoalMode,
  type HardwareProfile,
  type PlanGoal,
} from '@localmax/core';
import { Jobs } from './jobs';

export interface ServerOptions {
  port: number;
  uiDir: string | null;
  version: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
};

const PREVIEWS: Record<string, { label: string; profile: HardwareProfile }> = {
  rig3090: { label: 'RTX 3090 + 64 GB', profile: fixtures.rig3090 },
  rig3060: { label: 'RTX 3060 + 32 GB', profile: fixtures.rig3060 },
  macM3Max64: { label: 'M3 Max 64 GB', profile: fixtures.macM3Max64 },
  cpuOnly16: { label: 'CPU only, 16 GB', profile: fixtures.cpuOnly16 },
};

function goalFrom(q: Record<string, string | undefined>): PlanGoal {
  const mode = (['speed', 'balanced', 'quality'].includes(q.mode ?? '') ? q.mode : 'balanced') as GoalMode;
  const ctx = Math.max(2048, Math.min(262144, Number(q.ctx) || 16384));
  const memory = q.memory === 'total' ? 'total' : 'free';
  const workload = (['chat', 'agent', 'batch'].includes(q.workload ?? '') ? q.workload : 'chat') as Workload;
  return { mode, ctx, quantId: q.quant || undefined, memory, workload };
}

export function createApp(opts: ServerOptions, session: EngineSession) {
  const app = new Hono();
  const jobs = new Jobs();
  const monitor = new Monitor();

  /** Memory our own loaded model holds; it is freed before another model loads, so plans count it as available. */
  const ownEngineBytes = async () => (session.pid ? (await processRss(session.pid)) ?? 0 : 0);
  /** Measured quality and this machine's calibration, applied to every plan */
  const planOpts = async (preview: boolean) => {
    const [measured, calibration] = await Promise.all([loadMeasuredQuality(), loadCalibration()]);
    return { measured, calibration: preview ? undefined : calibration, ownEngineBytes: preview ? 0 : await ownEngineBytes() };
  };

  // Only answer requests addressed to this machine (blocks DNS-rebinding attacks), and
  // require JSON on writes so a random web page can't trigger downloads with a simple form post.
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return c.text('Forbidden host', 403);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS' && c.req.path.startsWith('/api/')) {
      if (!(c.req.header('content-type') ?? '').includes('application/json')) return c.json({ error: 'Expected application/json' }, 415);
    }
    await next();
  });

  // ---------------- State ----------------
  app.get('/api/state', async (c) => {
    const [engine, downloaded, disk] = await Promise.all([getInstalledEngine(), listDownloaded(), freeDiskBytes()]);
    return c.json({
      version: opts.version,
      apiBase: `http://127.0.0.1:${opts.port}/v1`,
      engine,
      pinnedEngineTag: PINNED_ENGINE_TAG,
      session: session.status(),
      jobs: jobs.list(),
      downloaded,
      diskFreeBytes: disk,
    });
  });

  app.get('/api/hardware', async (c) => c.json(await getHardware({ refresh: c.req.query('refresh') === '1' })));
  app.get('/api/previews', (c) => c.json(Object.entries(PREVIEWS).map(([id, p]) => ({ id, label: p.label }))));

  // ---------------- Catalog + plans ----------------
  app.get('/api/catalog', async (c) => {
    const q = c.req.query();
    const goal = goalFrom(q);
    const preview = q.preview && PREVIEWS[q.preview];
    const hw = preview ? preview.profile : await getHardware();
    const downloaded = await listDownloaded();
    const po = await planOpts(!!preview);
    const rows = await Promise.all(
      getCatalog().models.map(async (m) => {
        const plan = makePlan(hw, m, { mode: goal.mode, ctx: goal.ctx, memory: preview ? 'total' : goal.memory, workload: goal.workload }, po);
        const quant = getQuant(m, plan.config.quantId);
        return {
          model: { ...m, quants: m.quants.map(({ files: _f, ...rest }) => ({ ...rest, fileCount: _f.length })), mlx: (m.mlx ?? []).map(({ files: _f, ...rest }) => rest) },
          plan,
          downloadedQuants: downloaded.filter((d) => d.modelId === m.id).map((d) => d.quantId),
          partialBytes: await partialBytes(m, quant),
        };
      }),
    );
    return c.json({ hardware: hw, preview: preview ? preview.label : null, goal, rows });
  });

  app.get('/api/plan/:id', async (c) => {
    const q = c.req.query();
    const model = requireModel(c.req.param('id'));
    const preview = q.preview && PREVIEWS[q.preview];
    const hw = preview ? preview.profile : await getHardware();
    const g = goalFrom(q);
    const po = await planOpts(!!preview);
    const plan = makePlan(hw, model, preview ? { ...g, memory: 'total' } : g, po);
    const engine = await getInstalledEngine();
    const measurable = canMeasureQuality(model, hw, po.ownEngineBytes);
    const measuredHere = po.measured[`${model.id}/${plan.config.quantId}`] ?? null;
    const quant = getQuant(model, plan.config.quantId);
    const args = buildServerArgs(plan.config, { modelPath: modelEntryPath(model, quant), specPath: plan.config.spec.type !== 'none' && plan.config.spec.type !== 'ngram-mod' ? '<draft.gguf>' : undefined }, { host: '127.0.0.1', port: 8080, alias: model.id });
    return c.json({
      plan,
      command: commandLine(engine?.serverPath ?? 'llama-server', args),
      partialBytes: await partialBytes(model, quant),
      quality: {
        measured: measuredHere,
        canMeasure: measurable.ok,
        reason: measurable.reason,
        referenceBytes: measurable.reference?.sizeBytes ?? null,
        referenceOnDisk: measurable.reference ? (await listDownloaded()).some((d) => d.modelId === model.id && d.quantId === measurable.reference!.id) : false,
      },
      mlx: { supported: mlxSupported(), installed: !!(await getInstalledMlx()), variants: (model.mlx ?? []).map((v) => ({ id: v.id, bits: v.bits, sizeBytes: v.sizeBytes })) },
    });
  });

  // ---------------- Engine ----------------
  app.post('/api/engine/install', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const existing = jobs.running('engine')[0];
    if (existing) return c.json(existing);
    const job = jobs.start('engine', 'Installing llama.cpp engine', {}, async (j, signal) => {
      const hw = await getHardware();
      j.stage = 'download';
      await installEngine(hw, {
        tag: body.latest ? 'latest' : PINNED_ENGINE_TAG,
        signal,
        onLog: (l) => jobs.log(j, l),
        onProgress: (p) => (j.progress = { received: p.received, total: p.total, speed: p.speed, label: 'llama.cpp' }),
      });
    });
    return c.json(job);
  });

  // ---------------- Models ----------------
  app.post('/api/models/:id/pull', async (c) => {
    const { quantId } = await c.req.json();
    const model = requireModel(c.req.param('id'));
    const quant = getQuant(model, quantId);
    const dup = jobs.running('download').find((j) => j.modelId === model.id && j.quantId === quant.id);
    if (dup) return c.json(dup);
    const job = jobs.start('download', `${model.name} ${quant.id}`, { modelId: model.id, quantId: quant.id }, async (j, signal) => {
      j.stage = 'download';
      await pullQuant(model, quant, {
        signal,
        onLog: (l) => jobs.log(j, l),
        onProgress: (p) => (j.progress = { received: p.received, total: p.total, speed: p.speed, label: p.file }),
      });
    });
    return c.json(job);
  });

  app.delete('/api/models/:id/:quant', async (c) => {
    const model = requireModel(c.req.param('id'));
    const quant = getQuant(model, c.req.param('quant'));
    if (session.status().modelId === model.id && session.status().config?.quantId === quant.id) {
      return c.json({ error: 'Stop the model before deleting it.' }, 409);
    }
    await deleteQuant(model, quant);
    return c.json({ ok: true });
  });

  // ---------------- Run ----------------
  app.post('/api/run', async (c) => {
    const body = await c.req.json();
    const model = requireModel(body.modelId);
    for (const j of jobs.running('run')) jobs.cancel(j.id);
    monitor.reset();
    const goal = goalFrom({ mode: body.mode, ctx: String(body.ctx ?? ''), quant: body.quantId, memory: body.memory, workload: body.workload });
    const job = jobs.start('run', `${model.name}`, { modelId: model.id }, async (j, signal) => {
      await session.run({
        modelId: model.id,
        goal,
        tune: body.tune !== false,
        tryMlx: !!body.tryMlx,
        signal,
        onEvent: (e) => {
          if (e.type === 'stage') {
            j.stage = e.stage;
            j.detail = e.detail;
            if (e.stage !== 'download' && e.stage !== 'engine') j.progress = null;
          } else if (e.type === 'progress') j.progress = { received: e.received, total: e.total, speed: e.speed, label: e.label };
          else if (e.type === 'log') jobs.log(j, e.line);
          else if (e.type === 'trialStart') j.trialRunning = { label: e.label, index: e.index, total: e.total };
          else if (e.type === 'trial') {
            j.trials.push(e.result);
            j.trialRunning = null;
          } else if (e.type === 'plan') {
            j.plan = e.plan;
            j.quantId = e.plan.config.quantId;
          }
        },
      });
    });
    return c.json(job);
  });

  app.post('/api/stop', async (c) => {
    for (const j of jobs.running('run')) jobs.cancel(j.id);
    await session.stop();
    monitor.reset();
    return c.json({ ok: true });
  });

  app.post('/api/settings', async (c) => {
    const body = await c.req.json();
    const minutes = Number(body.keepAliveMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) return c.json({ error: 'keepAliveMinutes must be between 0 and 1440' }, 400);
    session.keepAliveMinutes = minutes;
    return c.json(await saveSettings({ keepAliveMinutes: minutes }));
  });

  // Unload now (keeps the setup so the next message reloads it) or load a parked model now
  app.post('/api/park', async (c) => {
    await session.park();
    monitor.reset();
    return c.json(session.status());
  });
  app.post('/api/wake', async (c) => {
    await session.ensureUpstream();
    return c.json(session.status());
  });

  // ---------------- Measured quality ----------------
  app.get('/api/quality', async (c) => c.json(await loadMeasuredQuality()));
  app.post('/api/quality/:id/:quant', async (c) => {
    const model = requireModel(c.req.param('id'));
    const quant = getQuant(model, c.req.param('quant'));
    if (jobs.running('quality').length) return c.json({ error: 'A quality check is already running' }, 409);
    const hw = await getHardware();
    const check = canMeasureQuality(model, hw, await ownEngineBytes());
    if (!check.ok) return c.json({ error: check.reason }, 400);
    const engine = await getInstalledEngine();
    if (!engine) return c.json({ error: 'Install the llama.cpp engine first.' }, 400);
    const job = jobs.start('quality', `${model.name} ${quant.id}`, { modelId: model.id, quantId: quant.id }, async (j, signal) => {
      // Free memory for the reference model
      if (session.status().state === 'ready') {
        jobs.log(j, 'Unloading the running model to make room');
        await session.park();
      }
      j.stage = 'quality';
      j.data = await measureQuality({
        model,
        quant,
        engine,
        signal,
        onLog: (l) => jobs.log(j, l),
        onProgress: (p) => (j.progress = { received: p.received, total: p.total, speed: p.speed, label: p.label }),
      });
    });
    return c.json(job);
  });

  // ---------------- Metal wired limit (Apple Silicon) ----------------
  app.get('/api/wired', async (c) => c.json(await wiredLimitInfo(await getHardware())));
  app.post('/api/wired', async (c) => {
    const { mb } = await c.req.json();
    const info = await wiredLimitInfo(await getHardware());
    if (!info.supported) return c.json({ error: 'Only on Apple Silicon Macs' }, 400);
    try {
      await applyWiredLimit(Number(mb), info.totalMb);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    // The GPU budget changed, so every plan changes
    await getHardware({ refresh: true });
    return c.json(await wiredLimitInfo(await getHardware()));
  });

  // ---------------- Engines ----------------
  app.get('/api/engines', async (c) => c.json({ llama: await getInstalledEngine(), mlx: { supported: mlxSupported(), installed: await getInstalledMlx() } }));
  app.post('/api/engines/mlx/install', async (c) => {
    if (!mlxSupported()) return c.json({ error: 'MLX only runs on Apple Silicon Macs' }, 400);
    const existing = jobs.running('engine')[0];
    if (existing) return c.json(existing);
    const job = jobs.start('engine', 'Installing the MLX engine', {}, async (j, signal) => {
      j.stage = 'download';
      await installMlx({ signal, onLog: (l) => jobs.log(j, l), onProgress: (p) => (j.progress = { received: p.received, total: p.total, speed: p.speed, label: p.stage }) });
    });
    return c.json(job);
  });

  // ---------------- Head-to-head comparison ----------------
  app.get('/api/compare/contenders', async (c) => {
    const { model, quant } = c.req.query();
    return c.json(await detectContenders(model, quant));
  });

  app.get('/api/compare/history', async (c) => c.json(await listComparisons()));

  app.post('/api/compare', async (c) => {
    const body = await c.req.json();
    const model = requireModel(body.modelId);
    const quant = getQuant(model, body.quantId);
    const valid: ContenderId[] = ['localmax', 'llamacpp', 'lmstudio', 'ollama'];
    const contenders = (body.contenders as string[]).filter((x): x is ContenderId => valid.includes(x as ContenderId));
    if (!contenders.length) return c.json({ error: 'Pick at least one contender' }, 400);
    if (jobs.running('compare').length || jobs.running('run').length) return c.json({ error: 'Another run or comparison is in progress' }, 409);
    const ctx = Math.max(2048, Math.min(131072, Number(body.ctx) || 8192));
    const job = jobs.start('compare', `${model.name} ${quant.id}`, { modelId: model.id, quantId: quant.id }, async (j, signal) => {
      j.data = { contenders, results: [], current: null };
      await runComparison({
        modelId: model.id,
        quantId: quant.id,
        mode: body.mode === 'best' ? 'best' : 'same-file',
        ctx,
        contenders,
        session,
        signal,
        onEvent: (e) => {
          if (e.type === 'stage') {
            j.stage = e.contender;
            j.detail = e.detail;
            j.data.current = e.contender;
          } else if (e.type === 'log') jobs.log(j, e.line);
          else if (e.type === 'result') j.data.results.push(e.result);
        },
      });
      j.data.current = null;
    });
    monitor.reset();
    return c.json(job);
  });

  app.post('/api/jobs/:id/cancel', (c) => c.json({ ok: jobs.cancel(c.req.param('id')) }));

  app.get('/api/monitor', async (c) => c.json(await monitor.sample(session.upstream, session.pid)));
  app.get('/api/logs', (c) => c.json({ lines: session.logs(Number(c.req.query('n')) || 200) }));
  app.get('/api/benchmarks', async (c) => c.json(await listBenchmarks()));

  // ---------------- OpenAI-compatible API ----------------
  // Proxy /v1/* to the running llama-server so tools only ever need one stable URL.
  app.all('/v1/*', async (c) => {
    // A model unloaded for being idle comes back automatically here
    let upstream: string | null;
    try {
      upstream = await session.ensureUpstream();
    } catch (e) {
      return c.json({ error: { message: `Could not reload the model: ${(e as Error).message.split('\n')[0]}`, type: 'unavailable' } }, 503);
    }
    if (!upstream) {
      if (c.req.path === '/v1/models') return c.json({ object: 'list', data: [] });
      return c.json({ error: { message: 'No model is running. Start one in the localmax UI or with `localmax run <model>`.', type: 'unavailable' } }, 503);
    }
    session.begin();
    let ended = false;
    const done = () => {
      if (!ended) {
        ended = true;
        session.end();
      }
    };
    const url = new URL(c.req.url);
    const headers = new Headers(c.req.raw.headers);
    headers.delete('host');
    // MLX serves its model as "default_model": swap the friendly name so clients don't need to know
    let reqBody: RequestInit['body'] = ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body;
    const rename = session.requestModel;
    if (rename && reqBody && (c.req.header('content-type') ?? '').includes('application/json')) {
      try {
        const json = await c.req.json();
        if (json && typeof json === 'object') json.model = rename;
        reqBody = JSON.stringify(json);
        headers.delete('content-length');
      } catch {}
    }
    const init: RequestInit & { duplex?: 'half' } = {
      method: c.req.method,
      headers,
      body: reqBody,
      duplex: 'half', // Node fetch needs this for streamed request bodies
      signal: c.req.raw.signal,
    };
    let res: Response;
    try {
      res = await fetch(`${upstream}${url.pathname}${url.search}`, init);
    } catch (e) {
      done();
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      return c.json({ error: { message: `Engine unavailable: ${(e as Error).message}`, type: 'unavailable' } }, 502);
    }
    const out = new Headers(res.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    if (!res.body) {
      done();
      return new Response(null, { status: res.status, headers: out });
    }
    // If the engine stops mid-stream (crash, stop button, shutdown) end the response cleanly instead of throwing
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const r = await reader.read();
          if (r.done) {
            done();
            ctrl.close();
          } else ctrl.enqueue(r.value);
        } catch {
          done();
          ctrl.close();
        }
      },
      cancel(reason) {
        done();
        reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, { status: res.status, headers: out });
  });

  // ---------------- Static UI ----------------
  app.get('*', async (c) => {
    if (!opts.uiDir) return c.html('<p style="font-family:sans-serif">UI not built. In development, open the Vite dev server (npm run dev) instead.</p>');
    const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^([/\\])+/, '');
    let file = join(opts.uiDir, rel);
    if (!file.startsWith(opts.uiDir)) return c.text('Not found', 404);
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      file = join(opts.uiDir, 'index.html'); // SPA fallback
    }
    const body = await readFile(file);
    const cache = file.includes(`${join('assets', '')}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return c.body(body, 200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache });
  });

  app.onError((err, c) => c.json({ error: err.message }, 500));

  return app;
}

export function startServer(opts: ServerOptions, session: EngineSession): Promise<void> {
  const app = createApp(opts, session);
  return new Promise((resolve, reject) => {
    const srv = serve({ fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' }, () => resolve());
    srv.on('error', reject);
  });
}
