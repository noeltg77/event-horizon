import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import {
  EngineSession,
  getCatalog,
  getHardware,
  getInstalledEngine,
  installEngine,
  listBenchmarks,
  plan as makePlan,
  pullQuant,
  requireModel,
  getQuant,
  selectEngine,
  commandLine,
  buildServerArgs,
  modelEntryPath,
  PINNED_ENGINE_TAG,
  paths,
  loadSettings,
  detectContenders,
  runComparison,
  formatBytes,
  measureQuality,
  canMeasureQuality,
  loadMeasuredQuality,
  loadCalibration,
  installMlx,
  type ContenderId,
  type Workload,
  type GoalMode,
} from '@localmax/core';
import pkg from '../package.json';
import { startServer } from './server';
import { printHardware, printPlan, printPlanTable, progressLine } from './print';

const DEFAULT_PORT = 4747;
const here = dirname(fileURLToPath(import.meta.url));
const uiDir = existsSync(join(here, 'ui', 'index.html')) ? join(here, 'ui') : null;

const program = new Command();
program
  .name('localmax')
  .description('Run open LLMs locally, tuned to your exact hardware.')
  .version(pkg.version, '-v, --version');

const goalOption = () => new Option('-g, --goal <mode>', 'speed, balanced or quality').choices(['speed', 'balanced', 'quality']).default('balanced');
const workloadOption = () =>
  new Option('-w, --workload <type>', 'chat (one conversation), agent (coding tools: long prompts, prompt caching) or batch (many requests)').choices(['chat', 'agent', 'batch']).default('chat');
const memoryOption = () =>
  new Option('--whole-machine', 'plan for all of this machine’s memory instead of what is free right now (close other apps first)');
const ctxOption = () => new Option('-c, --ctx <tokens>', 'target context length').default('16384');

// ---------- default: open the app ----------
program
  .command('ui', { isDefault: true })
  .description('Start the local server and open the app in your browser (default)')
  .option('-p, --port <port>', 'port for the app and API', String(DEFAULT_PORT))
  .option('--no-open', "don't open a browser")
  .action(async (o) => {
    const session = new EngineSession({ keepAliveMinutes: (await loadSettings()).keepAliveMinutes });
    const port = Number(o.port);
    await listen(port, session);
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  ${pc.bold(pc.green('localmax'))} ${pc.dim(`v${pkg.version}`)}\n`);
    console.log(`  App          ${pc.cyan(url)}`);
    console.log(`  OpenAI API   ${pc.cyan(`${url}/v1`)}`);
    console.log(pc.dim(`  Data         ${paths.root}\n`));
    console.log(pc.dim('  Press Ctrl+C to stop.\n'));
    if (o.open) openBrowser(url);
    shutdownOnSignal(session);
  });

// ---------- doctor ----------
program
  .command('doctor')
  .description('Profile your hardware and save it to ~/.localmax/hardware.json')
  .option('--json', 'print the raw profile as JSON')
  .action(async (o) => {
    const hw = await getHardware({ refresh: true });
    if (o.json) return console.log(JSON.stringify(hw, null, 2));
    printHardware(hw);
    const engine = await getInstalledEngine();
    const sel = selectEngine(hw);
    console.log(`  ${pc.dim('Engine'.padEnd(14))} ${engine ? `llama.cpp ${engine.tag} (${engine.suffix})` : pc.yellow(`not installed · would install ${sel.suffix} (${sel.why})`)}`);
    console.log(`  ${pc.dim('Profile saved'.padEnd(14))} ${paths.hardwareProfile}\n`);
  });

// ---------- engine ----------
const engineCmd = program.command('engine').description('Manage the llama.cpp engine');
engineCmd
  .command('install')
  .description(`Download the llama.cpp build for this machine (default ${PINNED_ENGINE_TAG})`)
  .option('--latest', 'install the newest llama.cpp build instead of the tested one')
  .option('--tag <tag>', 'install a specific build, e.g. b12202')
  .option('--mlx', 'install the MLX engine instead (Apple Silicon)')
  .action(async (o) => {
    if (o.mlx) {
      const m = await installMlx({ onLog: (l) => console.log(`  ${pc.dim('·')} ${l}`) });
      return console.log(`\n  ${pc.green('✓')} mlx-lm ${m.mlxLmVersion} ready\n`);
    }
    const hw = await getHardware();
    const eng = await installEngine(hw, {
      tag: o.tag ?? (o.latest ? 'latest' : PINNED_ENGINE_TAG),
      onLog: (l) => console.log(`  ${pc.dim('·')} ${l}`),
      onProgress: (p) => progressLine(p.stage, p.received, p.total, p.speed),
    });
    process.stdout.write('\n');
    console.log(`\n  ${pc.green('✓')} llama.cpp ${eng.tag} ready at ${eng.dir}\n`);
  });
engineCmd
  .command('status')
  .description('Show the installed engine')
  .action(async () => {
    const e = await getInstalledEngine();
    console.log(e ? `\n  llama.cpp ${e.tag} · ${e.suffix}\n  ${pc.dim(e.dir)}\n` : `\n  ${pc.yellow('No engine installed.')} Run ${pc.cyan('localmax engine install')}\n`);
  });

// ---------- models ----------
program
  .command('models')
  .description('What can I run? Every catalog model planned for this machine')
  .addOption(goalOption())
  .addOption(ctxOption())
  .addOption(memoryOption())
  .addOption(workloadOption())
  .action(async (o) => {
    const hw = await getHardware();
    const [measured, calibration] = await Promise.all([loadMeasuredQuality(), loadCalibration()]);
    const plans = getCatalog().models.map((m) =>
      makePlan(hw, m, { mode: o.goal as GoalMode, ctx: Number(o.ctx), memory: o.wholeMachine ? 'total' : 'free', workload: o.workload as Workload }, { measured, calibration }),
    );
    printPlanTable(plans);
  });

// ---------- plan ----------
program
  .command('plan <model>')
  .description('Explain how a model would be set up on this machine')
  .addOption(goalOption())
  .addOption(ctxOption())
  .option('-q, --quant <id>', 'force a quant')
  .addOption(memoryOption())
  .addOption(workloadOption())
  .option('--json', 'print the plan as JSON')
  .action(async (id, o) => {
    const hw = await getHardware();
    const model = requireModel(id);
    const [measured, calibration] = await Promise.all([loadMeasuredQuality(), loadCalibration()]);
    const p = makePlan(hw, model, { mode: o.goal, ctx: Number(o.ctx), quantId: o.quant, memory: o.wholeMachine ? 'total' : 'free', workload: o.workload }, { measured, calibration });
    if (o.json) return console.log(JSON.stringify(p, null, 2));
    const engine = await getInstalledEngine();
    const args = buildServerArgs(p.config, { modelPath: modelEntryPath(model, getQuant(model, p.config.quantId)) }, { host: '127.0.0.1', port: 8080, alias: model.id });
    printPlan(p, commandLine(engine?.serverPath ?? 'llama-server', args));
  });

// ---------- pull ----------
program
  .command('pull <model>')
  .description('Download a model (the planner picks the quant unless you pass --quant)')
  .option('-q, --quant <id>', 'quant to download')
  .addOption(goalOption())
  .action(async (id, o) => {
    const model = requireModel(id);
    const quantId = o.quant ?? makePlan(await getHardware(), model, { mode: o.goal, ctx: 16384 }).config.quantId;
    const quant = getQuant(model, quantId);
    await pullQuant(model, quant, {
      onLog: (l) => console.log(`  ${pc.dim('·')} ${l}`),
      onProgress: (p) => progressLine(p.file.split('/').pop() ?? '', p.received, p.total, p.speed),
    });
    process.stdout.write('\n');
    console.log(`\n  ${pc.green('✓')} ${model.name} ${quant.id} downloaded\n`);
  });

// ---------- run ----------
program
  .command('run <model>')
  .description('Plan, tune and serve a model with an OpenAI-compatible API')
  .addOption(goalOption())
  .addOption(ctxOption())
  .option('-q, --quant <id>', 'force a quant')
  .option('--no-tune', 'skip the benchmark sweep and use the planner settings directly')
  .addOption(memoryOption())
  .addOption(workloadOption())
  .option('--mlx', 'also benchmark an MLX build (Apple Silicon; installs MLX and downloads the build if needed)')
  .option('-p, --port <port>', 'port for the API and app', String(DEFAULT_PORT))
  .option('--open', 'also open the app in the browser')
  .action(async (id, o) => {
    const session = new EngineSession({ keepAliveMinutes: (await loadSettings()).keepAliveMinutes });
    const port = Number(o.port);
    await listen(port, session);
    shutdownOnSignal(session);
    let lastProgress = 0;
    const status = await session.run({
      modelId: id,
      goal: { mode: o.goal, ctx: Number(o.ctx), quantId: o.quant, memory: o.wholeMachine ? 'total' : 'free', workload: o.workload },
      tune: o.tune,
      tryMlx: !!o.mlx,
      onEvent: (e) => {
        if (e.type === 'stage') {
          if (lastProgress) process.stdout.write('\n');
          lastProgress = 0;
          console.log(`\n  ${pc.green('▸')} ${pc.bold(e.detail)}`);
        } else if (e.type === 'progress') {
          lastProgress = Date.now();
          progressLine(e.label, e.received, e.total, e.speed);
        } else if (e.type === 'log') console.log(`    ${pc.dim(e.line)}`);
        else if (e.type === 'plan') printPlan(e.plan);
        else if (e.type === 'trialStart') console.log(`    ${pc.dim(`[${e.index + 1}/${e.total}]`)} ${e.label} …`);
        else if (e.type === 'trial') {
          const r = e.result;
          const w = r.workloads ? Object.entries(r.workloads).map(([k, v]) => `${k} ${v!.genTps}`).join(' · ') : '';
          console.log(
            `      ${r.ok ? pc.green(`${r.genTps} tok/s`) + pc.dim(` · ${w}${r.sampledTps ? ` · sampled ${r.sampledTps}` : ''}${r.longPrompt ? ` · long prompt ${r.longPrompt.promptTps} tok/s, ${r.longPrompt.ttftMs} ms` : ''}${r.parallelTps ? ` · parallel ${r.parallelTps} tok/s` : ''}${r.draftAcceptRate != null ? ` · ${Math.round(r.draftAcceptRate * 100)}% drafts kept` : ''}${r.pruned ? ' · stopped early (clearly slower)' : ''}`) : pc.red('failed')}`,
          );
        }
      },
    });
    const h = status.headline!;
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  ${pc.bold(pc.green(`${h.genTps} tok/s`))} · ${h.qualityPct.toFixed(1)}% quality${h.qualitySource === 'estimate' ? pc.dim(' (est.)') : ''} · score ${pc.bold(h.score.toLocaleString())}\n`);
    console.log(`  OpenAI API   ${pc.cyan(`${url}/v1`)}   model: ${pc.cyan(status.modelId!)}`);
    console.log(`  App          ${pc.cyan(url)}`);
    console.log(pc.dim('\n  Press Ctrl+C to stop.\n'));
    if (o.open) openBrowser(url);
  });

// ---------- compare ----------
program
  .command('compare <model>')
  .description('Head-to-head: the same GGUF in localmax, stock llama.cpp, LM Studio and Ollama')
  .option('-q, --quant <id>', 'quant to compare (defaults to the one you have downloaded)')
  .option('-c, --ctx <tokens>', 'context length for every engine', '8192')
  .option('--with <list>', 'contenders, comma-separated: localmax,llamacpp,lmstudio,ollama', 'localmax,llamacpp,lmstudio,ollama')
  .option('-r, --rounds <n>', 'runs per prompt (median is reported)', '3')
  .option('--best', 'let localmax use its own tuned quant/backend instead of the same file, ranked on speed × quality')
  .action(async (id, o) => {
    const model = requireModel(id);
    const { listDownloaded } = await import('@localmax/core');
    const quantId = o.quant ?? (await listDownloaded()).find((d) => d.modelId === model.id)?.quantId;
    if (!quantId) throw new Error(`Download ${model.name} first (localmax pull ${model.id}).`);
    const wanted = String(o.with).split(',').map((s) => s.trim()) as ContenderId[];
    const status = await detectContenders(model.id, quantId);
    console.log(pc.bold(`\n  ${model.name} ${quantId} · ${Number(o.ctx).toLocaleString()} context · same file for every engine\n`));
    for (const s of status.filter((x) => wanted.includes(x.id))) {
      console.log(`  ${s.available ? pc.green('●') : pc.dim('○')} ${s.label.padEnd(20)} ${pc.dim(s.detail)}`);
      if (s.available && s.setup) console.log(`    ${pc.dim(s.setup)}`);
      if (!s.available && s.hint) console.log(`    ${pc.yellow(s.hint)}`);
    }
    const run = status.filter((s) => s.available && wanted.includes(s.id)).map((s) => s.id);
    console.log();
    const rec = await runComparison({
      modelId: model.id,
      quantId,
      ctx: Number(o.ctx),
      rounds: Number(o.rounds),
      mode: o.best ? 'best' : 'same-file',
      contenders: run,
      onEvent: (e) => {
        if (e.type === 'stage') console.log(`  ${pc.green('▸')} ${e.detail}`);
        else if (e.type === 'log') console.log(`    ${pc.dim(e.line)}`);
      },
    });
    const best = Math.max(...rec.results.map((r) => r.genTps));
    console.log(pc.dim(`\n  ${'Engine'.padEnd(22)} ${'Generate'.padStart(12)} ${'1st token'.padStart(10)} ${'Load'.padStart(8)} ${'Memory'.padStart(9)}`));
    for (const r of rec.results) {
      const bar = r.ok ? '█'.repeat(Math.max(1, Math.round((r.genTps / best) * 20))) : '';
      const line = r.ok
        ? `${(r.genTps + ' tok/s').padStart(12)} ${(r.ttftMs + ' ms').padStart(10)} ${((r.loadMs / 1000).toFixed(1) + ' s').padStart(8)} ${formatBytes(r.peakMemBytes).padStart(9)}  ${r.id === 'localmax' ? pc.yellow(bar) : pc.cyan(bar)}`
        : pc.red(` failed: ${r.error}`);
      console.log(`  ${r.label.padEnd(22)}${line}`);
    }
    console.log(pc.dim('\n  Saved to ~/.localmax/benchmarks. Same prompts, temperature 0, one engine in memory at a time.\n'));
  });

// ---------- quality ----------
program
  .command('quality <model>')
  .description('Measure how much quality a quant keeps (KL divergence against the Q8_0 reference)')
  .option('-q, --quant <id>', 'quant to measure (defaults to the one you have downloaded)')
  .action(async (id, o) => {
    const model = requireModel(id);
    const { listDownloaded } = await import('@localmax/core');
    const quantId = o.quant ?? (await listDownloaded()).find((d) => d.modelId === model.id && d.quantId !== 'Q8_0')?.quantId;
    if (!quantId) throw new Error(`Download a quant of ${model.name} first.`);
    const check = canMeasureQuality(model, await getHardware());
    if (!check.ok) throw new Error(check.reason);
    const engine = await getInstalledEngine();
    if (!engine) throw new Error('Install the engine first: localmax engine install');
    const r = await measureQuality({
      model,
      quant: getQuant(model, quantId),
      engine,
      onLog: (l) => console.log(`  ${pc.dim('·')} ${l}`),
      onProgress: (p) => progressLine(p.label, p.received, p.total, p.speed),
    });
    console.log(`\n  ${pc.bold(`${model.name} ${quantId}`)}: ${pc.green(`${r.qualityPct}% quality`)} ${pc.dim(`(mean KLD ${r.kld.toFixed(4)}, top token matches ${Number.isFinite(r.samePct) ? r.samePct.toFixed(1) : '—'}%)`)}\n`);
  });

// ---------- benchmarks ----------
program
  .command('benchmarks')
  .description('List past tuning runs (stored in ~/.localmax/benchmarks)')
  .action(async () => {
    const list = await listBenchmarks(30);
    if (!list.length) return console.log(`\n  No benchmarks yet. Run ${pc.cyan('localmax run <model>')}.\n`);
    console.log();
    for (const b of list) {
      const w = b.winner;
      console.log(`  ${pc.dim(b.createdAt.slice(0, 16).replace('T', ' '))}  ${b.model.id.padEnd(22)} ${b.model.quantId.padEnd(11)} ${w ? pc.green(`${w.genTps} tok/s`) : pc.red('failed')}  ${pc.dim(`predicted ${b.predicted.genTps}`)}`);
    }
    console.log();
  });

async function listen(port: number, session: EngineSession) {
  try {
    await startServer({ port, uiDir, version: pkg.version }, session);
  } catch (e: any) {
    if (e?.code === 'EADDRINUSE') {
      console.error(pc.red(`\n  Port ${port} is busy. Is localmax already running? Try --port ${port + 1}\n`));
      process.exit(1);
    }
    throw e;
  }
}

function shutdownOnSignal(session: EngineSession) {
  const stop = async () => {
    console.log(pc.dim('\n  Stopping…'));
    await session.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {}
}

program.parseAsync().catch((e) => {
  console.error(pc.red(`\n  ${e.message}\n`));
  process.exit(1);
});
