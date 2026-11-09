import { randomUUID } from 'node:crypto';
import type { Plan, TrialResult } from '@localmax/core';

export type JobKind = 'engine' | 'download' | 'run' | 'compare' | 'quality';

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stage: string | null;
  detail: string | null;
  progress: { received: number; total: number; speed: number; label: string } | null;
  logs: string[];
  trials: TrialResult[];
  trialRunning: { label: string; index: number; total: number } | null;
  plan: Plan | null;
  /** Kind-specific live data (e.g. comparison results as they come in) */
  data: any;
  error: string | null;
  modelId: string | null;
  quantId: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** In-memory background jobs (downloads, installs, tune-and-run). The UI polls these. */
export class Jobs {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();

  start(kind: JobKind, title: string, meta: { modelId?: string; quantId?: string }, fn: (job: Job, signal: AbortSignal) => Promise<void>): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      kind,
      title,
      status: 'running',
      stage: null,
      detail: null,
      progress: null,
      logs: [],
      trials: [],
      trialRunning: null,
      plan: null,
      data: null,
      error: null,
      modelId: meta.modelId ?? null,
      quantId: meta.quantId ?? null,
      startedAt: Date.now(),
      endedAt: null,
    };
    const ac = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, ac);
    fn(job, ac.signal)
      .then(() => {
        if (job.status === 'running') job.status = 'done';
      })
      .catch((e: Error) => {
        job.status = ac.signal.aborted ? 'cancelled' : 'error';
        job.error = ac.signal.aborted ? null : e.message;
      })
      .finally(() => {
        job.endedAt = Date.now();
        job.trialRunning = null;
        this.controllers.delete(job.id);
        this.prune();
      });
    return job;
  }

  log(job: Job, line: string): void {
    job.logs.push(line);
    if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  }

  cancel(id: string): boolean {
    const ac = this.controllers.get(id);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  running(kind?: JobKind): Job[] {
    return this.list().filter((j) => j.status === 'running' && (!kind || j.kind === kind));
  }

  private prune(): void {
    const finished = this.list().filter((j) => j.status !== 'running');
    for (const j of finished.slice(20)) this.jobs.delete(j.id);
  }
}
