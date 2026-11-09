import pc from 'picocolors';
import { formatBytes, type HardwareProfile, type Plan } from '@localmax/core';

export function printHardware(hw: HardwareProfile): void {
  const row = (k: string, v: string) => console.log(`  ${pc.dim(k.padEnd(14))} ${v}`);
  console.log(pc.bold('\n  Your machine\n'));
  row('OS', hw.os.name);
  row('CPU', `${hw.cpu.model} · ${hw.cpu.physicalCores} cores${hw.cpu.performanceCores !== hw.cpu.physicalCores ? ` (${hw.cpu.performanceCores} performance)` : ''}${hw.cpu.avx512 ? ' · AVX-512' : hw.cpu.avx2 ? ' · AVX2' : ''}`);
  row('Memory', `${formatBytes(hw.memory.totalBytes)} ${hw.memory.type ?? ''} · ${formatBytes(hw.memory.availableBytes)} free · ~${hw.memory.bandwidthGBs} GB/s${hw.memory.bandwidthSource === 'estimate' ? ' (est.)' : ''}`);
  if (!hw.gpus.length) row('GPU', pc.yellow('none detected'));
  for (const g of hw.gpus) {
    const extra = [
      g.cores ? `${g.cores} cores` : null,
      `${g.bandwidthGBs} GB/s`,
      g.pcie ? `PCIe ${g.pcie.gen}.0 x${g.pcie.width}` : null,
      g.driver ? `driver ${g.driver}` : null,
    ].filter(Boolean);
    row('GPU', `${g.model} · ${formatBytes(g.vramBytes)}${hw.unifiedMemory ? ' usable by Metal' : ' VRAM'} · ${extra.join(' · ')}`);
  }
  row('Backend', pc.green(hw.backend.toUpperCase()) + (hw.unifiedMemory ? pc.dim(' · unified memory') : ''));
  row('Disk', `${formatBytes(hw.disk.freeBytes)} free of ${formatBytes(hw.disk.totalBytes)} · ${hw.disk.kind.toUpperCase()}`);
  for (const n of hw.notes) console.log(`  ${pc.yellow('!')} ${pc.dim(n)}`);
  console.log();
}

const FIT_LABEL: Record<Plan['fit'], string> = {
  gpu: pc.green('fits on GPU'),
  partial: pc.yellow('split GPU/RAM'),
  cpu: pc.yellow('CPU only'),
  'no-fit': pc.red("won't fit"),
};

export function printPlan(plan: Plan, command?: string): void {
  console.log(pc.bold(`\n  ${plan.modelName}`) + pc.dim(`  ·  ${plan.goal.mode} · ${plan.goal.ctx.toLocaleString()} ctx`));
  console.log(
    `\n  ${pc.bold(pc.green(`${plan.predicted.genTps} tok/s`))} ${pc.dim('predicted')}  ·  ${plan.predicted.qualityPct.toFixed(1)}% quality ${pc.dim(`(${plan.predicted.qualitySource})`)}  ·  score ${plan.predicted.score.toLocaleString()}  ·  ${FIT_LABEL[plan.fit]}\n`,
  );
  for (const r of plan.reasons) {
    console.log(`  ${r.kind === 'warn' ? pc.red('▲') : pc.green('●')} ${pc.bold(r.title)}`);
    console.log(`    ${pc.dim(wrap(r.detail, 88).join('\n    '))}`);
  }
  for (const w of plan.warnings) console.log(`  ${pc.yellow('!')} ${w}`);
  if (command) console.log(`\n  ${pc.dim('Command')}\n  ${pc.cyan(command)}`);
  console.log();
}

export function printPlanTable(plans: Plan[]): void {
  console.log();
  console.log(pc.dim(`  ${'Model'.padEnd(24)} ${'Quant'.padEnd(12)} ${'Size'.padStart(8)}  ${'Speed'.padStart(10)}  ${'Quality'.padStart(7)}  Fit`));
  for (const p of plans) {
    const size = formatBytes(p.memory.weightsBytes);
    const speed = p.fit === 'no-fit' ? pc.dim('—') : `${p.predicted.genTps} tok/s`;
    const fit = p.blockedBy === 'free-memory' ? pc.yellow('close apps first') : FIT_LABEL[p.fit];
    console.log(`  ${p.modelName.padEnd(24)} ${p.config.quantId.padEnd(12)} ${size.padStart(8)}  ${speed.padStart(10)}  ${(p.predicted.qualityPct.toFixed(1) + '%').padStart(7)}  ${fit}`);
  }
  const free = plans[0]?.memory.freeNowBytes;
  if (free != null) console.log(pc.dim(`\n  Planned for the ${formatBytes(free)} of memory free right now. Add --whole-machine to plan as if other apps were closed.`));
  console.log(pc.dim('  Speeds are predictions. `localmax run <model>` measures the real numbers.\n'));
}

export function progressLine(label: string, received: number, total: number, speed: number): void {
  if (!process.stdout.isTTY) return;
  const pct = total ? received / total : 0;
  const width = 24;
  const bar = '█'.repeat(Math.round(pct * width)).padEnd(width, '░');
  const s = `  ${label.slice(0, 32).padEnd(32)} ${pc.green(bar)} ${(pct * 100).toFixed(0).padStart(3)}%  ${formatBytes(received)} / ${formatBytes(total)}  ${formatBytes(speed)}/s`;
  process.stdout.write(`\r${s}\x1b[K`);
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}
