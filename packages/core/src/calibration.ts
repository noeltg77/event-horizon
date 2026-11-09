import { readFile, writeFile } from 'node:fs/promises';
import { paths, ensureDirs } from './paths';
import { calibrationKey, type Calibration } from './planner/planner';

// The planner's efficiency constants are calibrated by hand from public numbers. Every tuning
// run tells us how far off they were on *this* machine, so we keep a running correction per
// backend, architecture (dense/MoE) and placement (GPU/split/CPU) and apply it to predictions.

export async function loadCalibration(): Promise<Calibration> {
  try {
    return JSON.parse(await readFile(paths.calibration, 'utf8')) as Calibration;
  } catch {
    return {};
  }
}

/**
 * Record one tuning result. `predictedUncalibrated` must be the planner's raw prediction
 * (before any existing correction), so corrections don't compound.
 */
export async function recordCalibration(backend: string, archType: string, fit: string, measured: number, predictedUncalibrated: number): Promise<Calibration> {
  if (!(measured > 0) || !(predictedUncalibrated > 0)) return loadCalibration();
  const cal = await loadCalibration();
  const key = calibrationKey(backend, archType, fit);
  const ratio = measured / predictedUncalibrated;
  const prev = cal[key];
  // Moving average: recent runs count most, but one odd run can't swing it wildly
  const factor = prev ? prev.factor * 0.7 + ratio * 0.3 : ratio;
  cal[key] = { factor: Math.round(factor * 1000) / 1000, runs: (prev?.runs ?? 0) + 1 };
  await ensureDirs();
  await writeFile(paths.calibration, JSON.stringify(cal, null, 2));
  return cal;
}
