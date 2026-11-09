import os from 'node:os';
import si from 'systeminformation';
import { tryExec } from './util';

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

/** Parse llama-server's Prometheus /metrics output. */
export function parseMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^llamacpp:([a-z_]+)(?:\{[^}]*\})?\s+([-\d.eE+]+|nan|inf)/);
    if (m && !(m[1] in out)) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** Samples system and engine state. Keeps the previous sample to turn counters into live rates. */
export class Monitor {
  private prev: Record<string, number> | null = null;
  private lastGen: number | null = null;
  private lastPrompt: number | null = null;
  private prevDecoded: { n: number; t: number } | null = null;

  async sample(upstream: string | null, pid: number | undefined): Promise<MonitorSample> {
    const [mem, rss, cpu, gpu, llama] = await Promise.all([
      si.mem().catch(() => null),
      pid ? processRss(pid) : Promise.resolve(null),
      pid ? processCpu(pid) : Promise.resolve(null),
      nvidiaUsage(),
      upstream ? this.llama(upstream) : Promise.resolve(null),
    ]);
    return {
      t: Date.now(),
      ram: {
        usedBytes: mem ? mem.total - mem.available : os.totalmem() - os.freemem(),
        totalBytes: mem?.total ?? os.totalmem(),
      },
      engine: pid ? { pid, rssBytes: rss, cpuPct: cpu } : null,
      gpu,
      llama,
    };
  }

  private async llama(upstream: string): Promise<MonitorSample['llama']> {
    try {
      const [mRes, sRes] = await Promise.all([
        fetch(`${upstream}/metrics`, { signal: AbortSignal.timeout(1500) }),
        fetch(`${upstream}/slots`, { signal: AbortSignal.timeout(1500) }).catch(() => null),
      ]);
      const m = parseMetrics(await mRes.text());
      const slots = sRes && sRes.ok ? ((await sRes.json()) as any[]) : [];
      const prev = this.prev;
      this.prev = m;
      // Live rate from counter deltas; hold the last value while idle
      if (prev) {
        const dTok = (m.tokens_predicted_total ?? 0) - (prev.tokens_predicted_total ?? 0);
        const dSec = (m.tokens_predicted_seconds_total ?? 0) - (prev.tokens_predicted_seconds_total ?? 0);
        if (dTok > 0 && dSec > 0) this.lastGen = dTok / dSec;
        const dP = (m.prompt_tokens_total ?? 0) - (prev.prompt_tokens_total ?? 0);
        const dPs = (m.prompt_seconds_total ?? 0) - (prev.prompt_seconds_total ?? 0);
        if (dP > 0 && dPs > 0) this.lastPrompt = dP / dPs;
      }
      const slot = slots[0];
      // Prometheus counters only move when a request finishes, so read live progress from the slot
      const nt = Array.isArray(slot?.next_token) ? slot.next_token[0] : slot?.next_token;
      const decoded: number | undefined = nt?.n_decoded;
      const now = Date.now();
      if (slot?.is_processing && typeof decoded === 'number') {
        const p = this.prevDecoded;
        if (p && decoded > p.n && now > p.t) this.lastGen = ((decoded - p.n) * 1000) / (now - p.t);
        this.prevDecoded = { n: decoded, t: now };
      } else {
        this.prevDecoded = null;
      }
      const drafts = m.spec_decode_num_draft_tokens_total ?? 0;
      return {
        genTps: this.lastGen,
        promptTps: this.lastPrompt,
        tokensPredicted: m.tokens_predicted_total ?? 0,
        promptTokens: m.prompt_tokens_total ?? 0,
        busy: !!slot?.is_processing || (m.requests_processing ?? 0) > 0,
        ctxUsed: slot ? (slot.n_past ?? slot.n_prompt_tokens ?? null) : null,
        ctxSize: slot?.n_ctx ?? null,
        draftAccept: drafts > 0 ? (m.spec_decode_num_accepted_tokens_total ?? 0) / drafts : null,
      };
    } catch {
      return null;
    }
  }

  reset(): void {
    this.prev = null;
    this.lastGen = null;
    this.lastPrompt = null;
    this.prevDecoded = null;
  }
}

/** Recent CPU use of a process in % of one core (ps on macOS/Linux, PowerShell on Windows is too slow so we skip it). */
async function processCpu(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return null;
  const out = await tryExec('ps', ['-o', '%cpu=', '-p', String(pid)]);
  const v = Number(out?.trim());
  return Number.isFinite(v) ? v : null;
}

export async function processRss(pid: number): Promise<number | null> {
  if (process.platform === 'win32') {
    const out = await tryExec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = out?.match(/"([\d,.\s]+) K"/);
    return m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null;
  }
  const out = await tryExec('ps', ['-o', 'rss=', '-p', String(pid)]);
  const kb = Number(out?.trim());
  return kb > 0 ? kb * 1024 : null;
}

async function nvidiaUsage(): Promise<MonitorSample['gpu']> {
  if (process.platform === 'darwin') return null;
  const out = await tryExec('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], 2000);
  if (!out) return null;
  const [used, total, util] = out.trim().split('\n')[0].split(',').map((s) => Number(s.trim()));
  return { usedBytes: used * 1024 * 1024, totalBytes: total * 1024 * 1024, util: Number.isFinite(util) ? util : null };
}
