// Memory bandwidth lookup tables. Token generation is memory-bound, so bandwidth
// is the single most important number for predicting tok/s.

/** Apple Silicon unified memory bandwidth in GB/s (top bin of each chip). */
const APPLE: [RegExp, number][] = [
  [/M1 Ultra/i, 800],
  [/M1 Max/i, 400],
  [/M1 Pro/i, 200],
  [/M1\b/i, 68],
  [/M2 Ultra/i, 800],
  [/M2 Max/i, 400],
  [/M2 Pro/i, 200],
  [/M2\b/i, 100],
  [/M3 Ultra/i, 819],
  [/M3 Max/i, 400],
  [/M3 Pro/i, 150],
  [/M3\b/i, 100],
  [/M4 Max/i, 546],
  [/M4 Pro/i, 273],
  [/M4\b/i, 120],
  [/M5 Max/i, 614],
  [/M5 Pro/i, 307],
  [/M5\b/i, 153],
];

/** Discrete GPU memory bandwidth in GB/s. Most specific patterns first. */
const GPU: [RegExp, number][] = [
  // NVIDIA RTX 50
  [/5090/, 1792],
  [/5080/, 960],
  [/5070 ?Ti/i, 896],
  [/5070/, 672],
  [/5060 ?Ti/i, 448],
  [/5060/, 448],
  // NVIDIA RTX 40
  [/4090/, 1008],
  [/4080 ?Super/i, 736],
  [/4080/, 717],
  [/4070 ?Ti ?Super/i, 672],
  [/4070 ?Ti/i, 504],
  [/4070/, 504],
  [/4060 ?Ti/i, 288],
  [/4060/, 272],
  // NVIDIA RTX 30
  [/3090 ?Ti/i, 1008],
  [/3090/, 936],
  [/3080 ?Ti/i, 912],
  [/3080/, 760],
  [/3070 ?Ti/i, 608],
  [/3070/, 448],
  [/3060 ?Ti/i, 448],
  [/3060/, 360],
  // NVIDIA RTX 20
  [/2080 ?Ti/i, 616],
  [/2080/, 448],
  [/2070/, 448],
  [/2060/, 336],
  // NVIDIA workstation / datacentre
  [/RTX PRO 6000/i, 1792],
  [/RTX 6000 Ada/i, 960],
  [/A6000/i, 768],
  [/RTX A5000/i, 768],
  [/RTX A4000/i, 448],
  [/H200/i, 4800],
  [/H100/i, 3350],
  [/A100.*80/i, 2039],
  [/A100/i, 1555],
  [/L40S?/i, 864],
  [/A10\b/i, 600],
  [/T4\b/i, 320],
  // AMD
  [/9070 ?XT/i, 640],
  [/9070/, 640],
  [/7900 ?XTX/i, 960],
  [/7900 ?XT/i, 800],
  [/7900 ?GRE/i, 576],
  [/7800 ?XT/i, 624],
  [/7700 ?XT/i, 432],
  [/7600/, 288],
  [/6950 ?XT/i, 576],
  [/6900 ?XT/i, 512],
  [/6800 ?XT/i, 512],
  [/6800/, 512],
  [/6700 ?XT/i, 384],
  [/MI300/i, 5300],
  [/Radeon VII/i, 1024],
  // Intel
  [/B580/i, 456],
  [/B570/i, 380],
  [/A770/i, 560],
  [/A750/i, 512],
];

export function appleBandwidth(chip: string): number | null {
  for (const [re, bw] of APPLE) if (re.test(chip)) return bw;
  return null;
}

export function gpuBandwidth(model: string): number | null {
  for (const [re, bw] of GPU) if (re.test(model)) return bw;
  return null;
}

/** System RAM bandwidth from speed and channel count: MT/s × 8 bytes × channels. */
export function ramBandwidth(speedMTs: number | null, channels: number | null, type: string | null): { gbs: number; measured: boolean } {
  if (speedMTs && channels) return { gbs: Math.round((speedMTs * 8 * channels) / 1000), measured: true };
  const ddr5 = /DDR5/i.test(type ?? '');
  const ch = channels ?? 2;
  const speed = speedMTs ?? (ddr5 ? 5200 : 3200);
  return { gbs: Math.round((speed * 8 * ch) / 1000), measured: false };
}

/** Rough sequential read speed by disk kind, used for load-time estimates. */
export function diskReadMBs(kind: 'nvme' | 'ssd' | 'hdd' | 'unknown'): number {
  return { nvme: 3000, ssd: 500, hdd: 150, unknown: 400 }[kind];
}
