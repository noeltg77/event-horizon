import os from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import si from 'systeminformation';
import type { Backend, GpuInfo, HardwareProfile } from '../types';
import { paths, ensureDirs } from '../paths';
import { tryExec, GiB } from '../util';
import { appleBandwidth, diskReadMBs, gpuBandwidth, ramBandwidth } from './tables';

/**
 * Detect the machine. Every probe is optional: if a command is missing or a
 * field can't be read we fall back to a sensible estimate and say so in `notes`.
 */
export async function detectHardware(): Promise<HardwareProfile> {
  const notes: string[] = [];
  const platform = process.platform;
  const isApple = platform === 'darwin' && process.arch === 'arm64';

  const [cpu, flags, mem, memLayout, graphics, osInfo, fsSize, diskLayout] = await Promise.all([
    safe(() => si.cpu(), null),
    safe(() => si.cpuFlags(), ''),
    safe(() => si.mem(), null),
    safe(() => si.memLayout(), []),
    safe(() => si.graphics(), { controllers: [], displays: [] } as any),
    safe(() => si.osInfo(), null),
    safe(() => si.fsSize(), []),
    safe(() => si.diskLayout(), []),
  ]);

  // ---------- CPU ----------
  let cpuModel = cpu ? `${cpu.manufacturer} ${cpu.brand}`.trim() : os.cpus()[0]?.model ?? 'Unknown CPU';
  let perfCores = (cpu as any)?.performanceCores || cpu?.physicalCores || os.cpus().length;
  if (isApple) {
    const brand = (await tryExec('sysctl', ['-n', 'machdep.cpu.brand_string']))?.trim();
    if (brand) cpuModel = brand;
    const p0 = Number((await tryExec('sysctl', ['-n', 'hw.perflevel0.physicalcpu']))?.trim());
    if (p0 > 0) perfCores = p0;
  }
  const flagStr = String(flags).toLowerCase();

  // ---------- Memory ----------
  const totalBytes = mem?.total ?? os.totalmem();
  const availableBytes = mem?.available ?? os.freemem();
  const reclaimableBytes = Math.max(availableBytes, (mem as any)?.reclaimable ?? 0);
  const swapUsedBytes = mem?.swapused ?? 0;
  const populated = (memLayout as any[]).filter((m) => m.size > 0);
  const memType = populated[0]?.type && populated[0].type !== 'Empty' ? String(populated[0].type) : null;
  const memSpeed = populated[0]?.clockSpeed || null;
  const channels = populated.length ? Math.min(populated.length, populated.length >= 8 ? 8 : populated.length >= 4 ? 4 : 2) : null;

  // ---------- GPUs ----------
  const gpus: GpuInfo[] = [];
  let wiredLimit: number | null = null;

  if (isApple) {
    const chip = cpuModel.replace(/^Apple\s*/i, '');
    const bw = appleBandwidth(chip);
    if (!bw) notes.push(`Unknown Apple chip "${chip}", memory bandwidth estimated.`);
    const cores = await appleGpuCores();
    const wiredMb = Number((await tryExec('sysctl', ['-n', 'iogpu.wired_limit_mb']))?.trim());
    // macOS lets Metal wire about 2/3 of RAM on smaller machines and 3/4 on larger ones,
    // unless the user raised iogpu.wired_limit_mb themselves.
    wiredLimit = wiredMb > 0 ? wiredMb * 1024 * 1024 : Math.floor(totalBytes * (totalBytes <= 36 * GiB ? 2 / 3 : 3 / 4));
    gpus.push({
      vendor: 'apple',
      model: `${cpuModel} GPU`,
      vramBytes: wiredLimit,
      vramFreeBytes: null,
      backends: ['metal'],
      bandwidthGBs: bw ?? 100,
      bandwidthSource: bw ? 'table' : 'estimate',
      cores: cores ?? undefined,
    });
  } else {
    const nv = await nvidiaSmi();
    gpus.push(...nv);
    for (const c of (graphics?.controllers ?? []) as any[]) {
      const vendorStr = `${c.vendor ?? ''} ${c.model ?? ''}`;
      const vendor = /nvidia/i.test(vendorStr) ? 'nvidia' : /amd|ati|radeon/i.test(vendorStr) ? 'amd' : /intel/i.test(vendorStr) ? 'intel' : 'unknown';
      if (vendor === 'nvidia' && nv.length) continue; // nvidia-smi is more accurate
      const vram = (c.vram ?? 0) * 1024 * 1024;
      // Skip integrated GPUs with tiny dedicated memory; they're slower than the CPU path
      if (vram < 2 * GiB) continue;
      const bw = gpuBandwidth(c.model ?? '');
      gpus.push({
        vendor,
        model: c.model ?? 'Unknown GPU',
        vramBytes: vram,
        vramFreeBytes: null,
        backends: vendor === 'amd' && platform === 'linux' ? ['rocm', 'vulkan'] : vendor === 'nvidia' ? ['cuda', 'vulkan'] : ['vulkan'],
        bandwidthGBs: bw ?? Math.round((vram / GiB) * 40),
        bandwidthSource: bw ? 'table' : 'estimate',
        pcie: null,
      });
    }
    if (!gpus.length) notes.push('No discrete GPU found. Models will run on the CPU.');
  }

  // ---------- RAM bandwidth ----------
  let ramBw: number;
  let ramSrc: 'table' | 'estimate' | 'measured';
  if (isApple) {
    ramBw = gpus[0].bandwidthGBs;
    ramSrc = gpus[0].bandwidthSource;
  } else {
    const r = ramBandwidth(memSpeed, channels, memType);
    ramBw = r.gbs;
    ramSrc = r.measured ? 'table' : 'estimate';
    if (!r.measured) notes.push('RAM speed or channel count unreadable, RAM bandwidth estimated.');
  }

  // ---------- Disk ----------
  const home = os.homedir();
  const fsList = fsSize as any[];
  const homeFs =
    fsList
      .filter((f) => home.toLowerCase().startsWith(String(f.mount).toLowerCase()))
      .sort((a, b) => String(b.mount).length - String(a.mount).length)[0] ?? fsList[0];
  const disk0 = (diskLayout as any[])[0];
  const kindStr = `${disk0?.type ?? ''} ${disk0?.interfaceType ?? ''} ${disk0?.name ?? ''}`;
  const diskKind = /nvme|pcie|apple ssd/i.test(kindStr) || isApple ? 'nvme' : /ssd/i.test(kindStr) ? 'ssd' : /hd|rotational/i.test(kindStr) ? 'hdd' : 'unknown';

  // ---------- Backend ----------
  const backend: Backend = isApple
    ? 'metal'
    : gpus.some((g) => g.vendor === 'nvidia')
      ? 'cuda'
      : gpus.some((g) => g.vendor === 'amd' || g.vendor === 'intel')
        ? 'vulkan'
        : 'cpu';

  return {
    schema: 1,
    detectedAt: new Date().toISOString(),
    os: {
      platform,
      arch: process.arch,
      release: os.release(),
      name: osInfo ? `${osInfo.distro} ${osInfo.release}`.trim() : `${platform} ${os.release()}`,
    },
    cpu: {
      model: cpuModel,
      vendor: cpu?.manufacturer ?? 'unknown',
      physicalCores: cpu?.physicalCores || os.cpus().length,
      performanceCores: perfCores,
      logicalCores: cpu?.cores || os.cpus().length,
      avx2: /avx2/.test(flagStr),
      avx512: /avx512/.test(flagStr),
      neon: process.arch === 'arm64',
    },
    memory: {
      totalBytes,
      availableBytes,
      reclaimableBytes,
      swapUsedBytes,
      type: isApple ? 'Unified LPDDR' : memType,
      speedMTs: memSpeed,
      channels,
      bandwidthGBs: ramBw,
      bandwidthSource: ramSrc,
    },
    gpus,
    unifiedMemory: isApple,
    gpuWiredLimitBytes: wiredLimit,
    disk: {
      path: home,
      freeBytes: homeFs?.available ?? 0,
      totalBytes: homeFs?.size ?? 0,
      kind: diskKind,
      readMBs: diskReadMBs(diskKind),
      readSource: 'estimate',
    },
    backend,
    notes,
  };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function appleGpuCores(): Promise<number | null> {
  const out = await tryExec('system_profiler', ['SPDisplaysDataType', '-json'], 8000);
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    const cores = j?.SPDisplaysDataType?.[0]?.sppci_cores;
    return cores ? Number(cores) : null;
  } catch {
    return null;
  }
}

/** Parse nvidia-smi. Gives us exact VRAM, free VRAM and PCIe link, which systeminformation can't. */
export async function nvidiaSmi(): Promise<GpuInfo[]> {
  const out = await tryExec('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.free,pcie.link.gen.max,pcie.link.width.max,driver_version',
    '--format=csv,noheader,nounits',
  ]);
  if (!out) return [];
  return parseNvidiaSmi(out);
}

export function parseNvidiaSmi(out: string): GpuInfo[] {
  return out
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, total, free, gen, width, driver] = line.split(',').map((s) => s.trim());
      const bw = gpuBandwidth(name);
      return {
        vendor: 'nvidia' as const,
        model: name,
        vramBytes: Number(total) * 1024 * 1024,
        vramFreeBytes: Number.isFinite(Number(free)) ? Number(free) * 1024 * 1024 : null,
        backends: ['cuda', 'vulkan'] as Backend[],
        bandwidthGBs: bw ?? Math.round((Number(total) / 1024) * 40),
        bandwidthSource: bw ? ('table' as const) : ('estimate' as const),
        driver,
        pcie: Number(gen) ? { gen: Number(gen), width: Number(width) } : null,
      };
    });
}

/** Cached profile so the UI doesn't re-probe on every request. */
export async function getHardware(opts: { refresh?: boolean } = {}): Promise<HardwareProfile> {
  if (!opts.refresh) {
    try {
      const cached = JSON.parse(await readFile(paths.hardwareProfile, 'utf8')) as HardwareProfile;
      // Available memory changes constantly, so always refresh that one number
      const age = Date.now() - new Date(cached.detectedAt).getTime();
      if (cached.schema === 1 && age < 24 * 3600 * 1000) {
        const m = await safe(() => si.mem(), null);
        cached.memory.availableBytes = m?.available ?? os.freemem();
        cached.memory.reclaimableBytes = Math.max(cached.memory.availableBytes, (m as any)?.reclaimable ?? 0);
        cached.memory.swapUsedBytes = m?.swapused ?? 0;
        return cached;
      }
    } catch {}
  }
  const profile = await detectHardware();
  await ensureDirs();
  await writeFile(paths.hardwareProfile, JSON.stringify(profile, null, 2));
  return profile;
}

/** PCIe bandwidth in GB/s per direction. */
export function pcieBandwidth(pcie: { gen: number; width: number } | null | undefined): number {
  if (!pcie) return 16;
  const perLane: Record<number, number> = { 1: 0.25, 2: 0.5, 3: 0.985, 4: 1.97, 5: 3.94, 6: 7.56 };
  return (perLane[pcie.gen] ?? 1.97) * pcie.width;
}
