import { useCallback, useEffect, useRef, useState } from 'react';
import type { BenchmarkRecord, CatalogModel, HardwareProfile, Plan, PlanGoal, SessionStatus, TrialResult } from '@localmax/core';

export type { BenchmarkRecord, CatalogModel, HardwareProfile, Plan, PlanGoal, SessionStatus, TrialResult };

export interface Job {
  id: string;
  kind: 'engine' | 'download' | 'run' | 'compare' | 'quality';
  title: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stage: string | null;
  detail: string | null;
  progress: { received: number; total: number; speed: number; label: string } | null;
  logs: string[];
  trials: TrialResult[];
  trialRunning: { label: string; index: number; total: number } | null;
  plan: Plan | null;
  data: any;
  error: string | null;
  modelId: string | null;
  quantId: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface InstalledEngine {
  tag: string;
  backend: string;
  suffix: string;
  dir: string;
  serverPath: string;
  installedAt: string;
}

export interface AppState {
  version: string;
  apiBase: string;
  engine: InstalledEngine | null;
  pinnedEngineTag: string;
  session: SessionStatus;
  jobs: Job[];
  downloaded: { modelId: string; quantId: string; sizeBytes: number; path: string }[];
  diskFreeBytes: number | null;
}

export type CatalogModelLite = Omit<CatalogModel, 'quants'> & {
  quants: (Omit<CatalogModel['quants'][number], 'files'> & { fileCount: number })[];
};

export interface CatalogRow {
  model: CatalogModelLite;
  plan: Plan;
  downloadedQuants: string[];
  partialBytes: number;
}

export interface CatalogResponse {
  hardware: HardwareProfile;
  preview: string | null;
  goal: PlanGoal;
  rows: CatalogRow[];
}

export interface MonitorSample {
  t: number;
  ram: { usedBytes: number; totalBytes: number };
  engine: { pid: number; rssBytes: number | null; cpuPct: number | null } | null;
  gpu: { usedBytes: number; totalBytes: number; util: number | null } | null;
  llama: {
    genTps: number | null;
    promptTps: number | null;
    tokensPredicted: number;
    promptTokens: number;
    busy: boolean;
    ctxUsed: number | null;
    ctxSize: number | null;
    draftAccept: number | null;
  } | null;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error?.message ?? (data as any)?.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Poll an endpoint. Returns the latest data and a manual refresh. */
export function usePoll<T>(path: string | null, intervalMs: number): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const d = await api<T>(p);
      if (pathRef.current === p) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!path) return;
    load();
    if (!intervalMs) return;
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [path, intervalMs, load]);

  return { data, error, refresh: load };
}

// ---------- formatting ----------

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(i >= 3 ? digits : 0)} ${u[i]}`;
}

export function tps(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  return n >= 100 ? Math.round(n).toString() : n.toFixed(1);
}

export function pct(n: number): string {
  return `${n >= 99.95 ? '100' : n.toFixed(1)}%`;
}

export function eta(received: number, total: number, speed: number): string {
  if (!speed || !total) return '';
  const s = (total - received) / speed;
  if (s < 60) return `${Math.max(1, Math.round(s))}s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
}

export function archLabel(m: CatalogModelLite): string {
  const a = m.arch;
  return a.type === 'moe' ? `MoE ${fmtB(a.totalParamsB)} · ${fmtB(a.activeParamsB)} active` : `Dense ${fmtB(a.totalParamsB)}`;
}

function fmtB(b: number): string {
  return b >= 10 ? `${Math.round(b)}B` : `${b.toFixed(1).replace(/\.0$/, '')}B`;
}
