import type { HardwareProfile } from '../types';

const GB = 1024 ** 3;

/** Fake hardware profiles for tests and for previewing plans for other machines. */
function base(): Omit<HardwareProfile, 'gpus' | 'memory' | 'cpu' | 'backend' | 'unifiedMemory' | 'gpuWiredLimitBytes'> {
  return {
    schema: 1,
    detectedAt: '2026-01-01T00:00:00.000Z',
    os: { platform: 'win32', arch: 'x64', release: '10.0.26100', name: 'Windows 11' },
    disk: { path: 'C:\\Users\\test', freeBytes: 800 * GB, totalBytes: 2000 * GB, kind: 'nvme', readMBs: 3000, readSource: 'estimate' },
    notes: [],
  };
}

/** RTX 3090 24 GB + 64 GB DDR4 dual channel, PCIe 4 x16. The plan's reference rig. */
export const rig3090: HardwareProfile = {
  ...base(),
  cpu: { model: 'AMD Ryzen 9 5900X', vendor: 'AMD', physicalCores: 12, performanceCores: 12, logicalCores: 24, avx2: true, avx512: false, neon: false },
  memory: { totalBytes: 64 * GB, availableBytes: 56 * GB, type: 'DDR4', speedMTs: 3600, channels: 2, bandwidthGBs: 58, bandwidthSource: 'table' },
  gpus: [
    {
      vendor: 'nvidia',
      model: 'NVIDIA GeForce RTX 3090',
      vramBytes: 24 * GB,
      vramFreeBytes: 23.3 * GB,
      backends: ['cuda', 'vulkan'],
      bandwidthGBs: 936,
      bandwidthSource: 'table',
      driver: '580.97',
      pcie: { gen: 4, width: 16 },
    },
  ],
  unifiedMemory: false,
  gpuWiredLimitBytes: null,
  backend: 'cuda',
};

/** RTX 3060 12 GB + 32 GB DDR4. A common budget gaming PC. */
export const rig3060: HardwareProfile = {
  ...base(),
  cpu: { model: 'Intel Core i5-12400F', vendor: 'Intel', physicalCores: 6, performanceCores: 6, logicalCores: 12, avx2: true, avx512: false, neon: false },
  memory: { totalBytes: 32 * GB, availableBytes: 26 * GB, type: 'DDR4', speedMTs: 3200, channels: 2, bandwidthGBs: 51, bandwidthSource: 'table' },
  gpus: [
    {
      vendor: 'nvidia',
      model: 'NVIDIA GeForce RTX 3060',
      vramBytes: 12 * GB,
      vramFreeBytes: 11.4 * GB,
      backends: ['cuda', 'vulkan'],
      bandwidthGBs: 360,
      bandwidthSource: 'table',
      driver: '566.36',
      pcie: { gen: 4, width: 16 },
    },
  ],
  unifiedMemory: false,
  gpuWiredLimitBytes: null,
  backend: 'cuda',
};

/** MacBook Pro M3 Max 64 GB. */
export const macM3Max64: HardwareProfile = {
  ...base(),
  os: { platform: 'darwin', arch: 'arm64', release: '25.0.0', name: 'macOS 26' },
  cpu: { model: 'Apple M3 Max', vendor: 'Apple', physicalCores: 16, performanceCores: 12, logicalCores: 16, avx2: false, avx512: false, neon: true },
  memory: { totalBytes: 64 * GB, availableBytes: 44 * GB, type: 'Unified LPDDR', speedMTs: null, channels: null, bandwidthGBs: 400, bandwidthSource: 'table' },
  gpus: [
    {
      vendor: 'apple',
      model: 'Apple M3 Max GPU',
      vramBytes: 48 * GB,
      vramFreeBytes: null,
      backends: ['metal'],
      bandwidthGBs: 400,
      bandwidthSource: 'table',
      cores: 40,
    },
  ],
  unifiedMemory: true,
  gpuWiredLimitBytes: 48 * GB,
  backend: 'metal',
};

/** MacBook Pro M3 Pro 18 GB. */
export const macM3Pro18: HardwareProfile = {
  ...macM3Max64,
  cpu: { ...macM3Max64.cpu, model: 'Apple M3 Pro', physicalCores: 11, performanceCores: 5, logicalCores: 11 },
  memory: { ...macM3Max64.memory, totalBytes: 18 * GB, availableBytes: 8 * GB, bandwidthGBs: 150 },
  gpus: [{ ...macM3Max64.gpus[0], model: 'Apple M3 Pro GPU', vramBytes: 12 * GB, bandwidthGBs: 150, cores: 18 }],
  gpuWiredLimitBytes: 12 * GB,
};

/** No GPU at all: 16 GB laptop. */
export const cpuOnly16: HardwareProfile = {
  ...base(),
  cpu: { model: 'Intel Core i7-1165G7', vendor: 'Intel', physicalCores: 4, performanceCores: 4, logicalCores: 8, avx2: true, avx512: true, neon: false },
  memory: { totalBytes: 16 * GB, availableBytes: 10 * GB, type: 'LPDDR4X', speedMTs: 4266, channels: 2, bandwidthGBs: 68, bandwidthSource: 'table' },
  gpus: [],
  unifiedMemory: false,
  gpuWiredLimitBytes: null,
  backend: 'cpu',
};

export const fixtures = { rig3090, rig3060, macM3Max64, macM3Pro18, cpuOnly16 };
