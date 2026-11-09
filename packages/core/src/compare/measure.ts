import { tryExec } from '../util';

// One stopwatch for every engine: we time the token stream on the client side the same
// way for all of them, so differences come from the engines, not from how each reports.

export interface PromptResult {
  prompt: string;
  tokens: number;
  /** Time from sending the request to the first generated token */
  ttftMs: number;
  /** Tokens per second while generating (first token to last), measured by us */
  genTps: number;
  /** The engine's own figure, where it reports one */
  engineGenTps: number | null;
  promptTokens: number | null;
  /** Prompt processing speed: the engine's figure, or prompt tokens ÷ time to first token */
  promptTps: number | null;
  /** Speculative decoding: tokens drafted and accepted (llama.cpp reports these) */
  draftN: number | null;
  draftAccepted: number | null;
  totalMs: number;
  /** Generation speed of every round, when a prompt was run more than once */
  samples?: number[];
  /** (max - min) / median of the rounds: how much this engine varied run to run */
  spread?: number;
}

interface Timer {
  t0: number;
  first: number | null;
  last: number | null;
  chunks: number;
}

function tick(t: Timer) {
  const now = performance.now();
  if (t.first === null) t.first = now;
  t.last = now;
  t.chunks++;
}

function finish(
  prompt: string,
  t: Timer,
  tokens: number,
  engineGenTps: number | null,
  promptTokens: number | null,
  extra: { enginePromptTps?: number | null; draftN?: number | null; draftAccepted?: number | null } = {},
): PromptResult {
  const end = performance.now();
  const span = t.first !== null && t.last !== null ? (t.last - t.first) / 1000 : 0;
  const ttftMs = t.first !== null ? Math.round(t.first - t.t0) : 0;
  const promptTps = extra.enginePromptTps ? Math.round(extra.enginePromptTps) : promptTokens && ttftMs > 0 ? Math.round((promptTokens / ttftMs) * 1000) : null;
  return {
    prompt,
    tokens,
    ttftMs,
    genTps: tokens > 1 && span > 0 ? Math.round(((tokens - 1) / span) * 10) / 10 : 0,
    engineGenTps: engineGenTps ? Math.round(engineGenTps * 10) / 10 : null,
    promptTokens,
    promptTps,
    draftN: extra.draftN ?? null,
    draftAccepted: extra.draftAccepted ?? null,
    totalMs: Math.round(end - t.t0),
  };
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) yield p;
  }
  if (buf.trim()) yield buf;
}

/** OpenAI-compatible streaming chat (llama-server, LM Studio). Counts reasoning tokens too. */
export async function measureOpenAI(
  baseUrl: string,
  model: string,
  prompt: string,
  maxTokens: number,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<PromptResult> {
  const t: Timer = { t0: performance.now(), first: null, last: null, chunks: 0 };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      ...extra,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  let usage: any = null;
  let timings: any = null;
  for await (const line of lines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const d = j.choices?.[0]?.delta;
      if (d && (d.content || d.reasoning_content || d.reasoning)) tick(t);
      if (j.usage) usage = j.usage;
      if (j.timings) timings = j.timings;
    } catch {}
  }
  return finish(prompt, t, usage?.completion_tokens ?? t.chunks, timings?.predicted_per_second ?? null, usage?.prompt_tokens ?? timings?.prompt_n ?? null, {
    enginePromptTps: timings?.prompt_per_second ?? null,
    draftN: timings?.draft_n ?? null,
    draftAccepted: timings?.draft_n_accepted ?? null,
  });
}

/** Ollama's native API: the only way to set the context length (num_ctx) to match the others. */
export async function measureOllama(
  baseUrl: string,
  model: string,
  prompt: string,
  maxTokens: number,
  ctx: number,
  signal?: AbortSignal,
): Promise<PromptResult> {
  const t: Timer = { t0: performance.now(), first: null, last: null, chunks: 0 };
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      think: false,
      options: { temperature: 0, num_predict: maxTokens, num_ctx: ctx },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  let final: any = null;
  for await (const line of lines(res.body)) {
    try {
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      if (j.message?.content || j.message?.thinking) tick(t);
      if (j.done) final = j;
    } catch (e) {
      if ((e as Error).message && !(e instanceof SyntaxError)) throw e;
    }
  }
  const engine = final?.eval_count && final?.eval_duration ? (final.eval_count / final.eval_duration) * 1e9 : null;
  const pp = final?.prompt_eval_count && final?.prompt_eval_duration ? (final.prompt_eval_count / final.prompt_eval_duration) * 1e9 : null;
  return finish(prompt, t, final?.eval_count ?? t.chunks, engine, final?.prompt_eval_count ?? null, { enginePromptTps: pp });
}

/**
 * Peak memory of an engine while it runs. For a process we started we watch its PID;
 * for LM Studio and Ollama we sum every matching process and subtract what was there
 * before the model loaded, so only the model's own memory counts.
 */
export class MemorySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseline = 0;
  peak = 0;

  constructor(private readonly match: { pid?: () => number | undefined; pattern?: RegExp }) {}

  async sampleNow(): Promise<number> {
    if (this.match.pid) {
      const pid = this.match.pid();
      if (!pid) return 0;
      const out = await tryExec('ps', ['-o', 'rss=', '-p', String(pid)]);
      return (Number(out?.trim()) || 0) * 1024;
    }
    if (this.match.pattern) return sumRssMatching(this.match.pattern);
    return 0;
  }

  async takeBaseline(): Promise<void> {
    this.baseline = this.match.pid ? 0 : await this.sampleNow();
  }

  start(): void {
    this.timer = setInterval(async () => {
      const v = (await this.sampleNow()) - this.baseline;
      if (v > this.peak) this.peak = v;
    }, 400);
  }

  async stop(): Promise<number> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const v = (await this.sampleNow()) - this.baseline;
    if (v > this.peak) this.peak = v;
    return Math.max(0, this.peak);
  }
}

async function sumRssMatching(pattern: RegExp): Promise<number> {
  if (process.platform === 'win32') {
    const out = await tryExec('tasklist', ['/FO', 'CSV', '/NH'], 6000);
    let total = 0;
    for (const line of out?.split(/\r?\n/) ?? []) {
      const cols = line.split('","').map((c) => c.replace(/"/g, ''));
      if (cols[0] && pattern.test(cols[0])) total += Number((cols[4] ?? '').replace(/[^\d]/g, '')) * 1024;
    }
    return total;
  }
  const out = await tryExec('ps', ['-axo', 'rss=,command='], 6000);
  let total = 0;
  for (const line of out?.split('\n') ?? []) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && pattern.test(m[2])) total += Number(m[1]) * 1024;
  }
  return total;
}

export function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
