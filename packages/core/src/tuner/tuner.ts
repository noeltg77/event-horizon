import type { CatalogModel, HardwareProfile, Plan, RunConfig, TrialResult, Workload, WorkloadKey } from '../types';
import type { InstalledEngine } from '../engine/engine-manager';
import { freePort, type EngineProcess } from '../engine/llama-server';
import { createEngineProcess } from '../engine/factory';
import { closestMlx } from '../engine/mlx';
import { measureOpenAI, median, type PromptResult } from '../compare/measure';
import { longPrompt } from '../corpus';
import { qualityFactor } from '../quality';

const editPrompt = (code: string) => `Rename every variable in this code to snake_case and change nothing else. Reply with only the code.\n\n\`\`\`js\n${code}\n\`\`\``;

/**
 * Prompt pools per kind of work. Every round uses *different* prompts: n-gram lookahead
 * remembers earlier output, so repeating a prompt would let it replay its own answer and
 * report impossible speeds (we measured 244 tok/s that way on a 40 tok/s machine).
 */
export const PROMPT_POOLS: Record<WorkloadKey, string[]> = {
  chat: [
    'Explain in two short paragraphs how a refrigerator moves heat from inside to outside.',
    'My landlord has not fixed a leaking roof for three weeks. Write a short, polite but firm email asking for a repair date.',
    'Describe how a bill becomes law in the UK Parliament, in plain language for a teenager.',
    'Give me a five-day beginner running plan with one sentence of advice for each day.',
    'Why do leaves change colour in autumn? Answer in about 150 words.',
    'Write a friendly message to a neighbour asking them to keep their dog quiet in the early mornings.',
  ],
  code: [
    'Write a Python function that reads a CSV of transactions (date, category, amount) and returns the total per category. Include type hints.',
    'Write a TypeScript function that debounces another function, with a short usage example.',
    'Write a Go function that checks whether a string is a valid IPv4 address, with three test cases.',
  ],
  edit: [
    editPrompt('function totalPrice(cartItems, taxRate) {\n  let runningTotal = 0;\n  for (const cartItem of cartItems) {\n    const itemPrice = cartItem.unitPrice * cartItem.quantity;\n    runningTotal += itemPrice;\n  }\n  const taxAmount = runningTotal * taxRate;\n  return runningTotal + taxAmount;\n}'),
    editPrompt('function averageScore(studentList) {\n  let scoreSum = 0;\n  let studentCount = 0;\n  for (const studentRecord of studentList) {\n    scoreSum += studentRecord.finalScore;\n    studentCount += 1;\n  }\n  const averageValue = studentCount ? scoreSum / studentCount : 0;\n  return Math.round(averageValue * 10) / 10;\n}'),
    editPrompt('function formatAddress(userProfile) {\n  const streetLine = userProfile.houseNumber + " " + userProfile.streetName;\n  const cityLine = userProfile.townName + ", " + userProfile.postCode;\n  const fullAddress = [streetLine, cityLine, userProfile.countryName].join("\\n");\n  return fullAddress.trim();\n}'),
  ],
};

/** One tuner round: two chat prompts, one code, one edit, all different from every other round. */
export function tuneRound(round: number): { key: WorkloadKey; prompt: string }[] {
  return [
    { key: 'chat', prompt: PROMPT_POOLS.chat[(round * 2) % PROMPT_POOLS.chat.length] },
    { key: 'chat', prompt: PROMPT_POOLS.chat[(round * 2 + 1) % PROMPT_POOLS.chat.length] },
    { key: 'code', prompt: PROMPT_POOLS.code[round % PROMPT_POOLS.code.length] },
    { key: 'edit', prompt: PROMPT_POOLS.edit[round % PROMPT_POOLS.edit.length] },
  ];
}

/** Kept for compatibility: the first round's prompts. */
export const TUNE_PROMPTS = tuneRound(0);

/** The compare page's three workloads: prompt i for round r is POOL[r]. */
export const COMPARE_POOLS: string[][] = [PROMPT_POOLS.chat.slice(0, 3), PROMPT_POOLS.code, PROMPT_POOLS.edit];
export const STANDARD_PROMPTS = COMPARE_POOLS.map((p) => p[0]);

/** How much each kind of prompt counts towards the headline speed, per workload profile. */
export const WORKLOAD_WEIGHTS: Record<Workload, Record<WorkloadKey, number>> = {
  chat: { chat: 0.7, code: 0.2, edit: 0.1 },
  agent: { chat: 0.2, code: 0.4, edit: 0.4 },
  batch: { chat: 0.6, code: 0.3, edit: 0.1 },
};

/**
 * Average speed over a mix of work, weighted by share of tokens. Rates must be averaged by
 * time (a weighted harmonic mean): one very fast workload only saves its share of the time,
 * so it can't drag the average up the way an arithmetic mean would.
 */
export function weightedSpeed(w: Partial<Record<WorkloadKey, { genTps: number }>>, workload: Workload): number {
  const weights = WORKLOAD_WEIGHTS[workload];
  let secondsPerToken = 0;
  let total = 0;
  for (const k of Object.keys(weights) as WorkloadKey[]) {
    const v = w[k]?.genTps;
    if (v && v > 0) {
      secondsPerToken += weights[k] / v;
      total += weights[k];
    }
  }
  return total && secondsPerToken ? Math.round((total / secondsPerToken) * 10) / 10 : 0;
}

export interface TuneCandidate {
  label: string;
  config: RunConfig;
  /** Quality of the weights this candidate runs (MLX builds differ from the GGUF) */
  qualityPct?: number;
}

export interface CandidateOptions {
  max?: number;
  /** Add an MLX build of similar precision (Apple Silicon, MLX installed, files downloaded) */
  mlx?: { variantId: string; bits: number; qualityPct: number } | null;
}

/** The planner's pick plus the variants most likely to matter on this machine. */
export function tuneCandidates(plan: Plan, model: CatalogModel, hw: HardwareProfile, maxOrOpts: number | CandidateOptions = 5): TuneCandidate[] {
  const opts: CandidateOptions = typeof maxOrOpts === 'number' ? { max: maxOrOpts } : maxOrOpts;
  const base = plan.config;
  const out: TuneCandidate[] = [{ label: 'Planner pick', config: base }];
  if (opts.mlx) {
    out.push({
      label: `MLX ${opts.mlx.bits}-bit`,
      config: { ...base, backend: 'mlx', mlxVariant: opts.mlx.variantId, spec: { type: 'none' }, kvTypeK: 'f16', kvTypeV: 'f16' },
      qualityPct: opts.mlx.qualityPct,
    });
  }
  if (base.spec.type !== 'none') out.push({ label: 'Without speculative decoding', config: { ...base, spec: { type: 'none' } } });
  if (base.spec.type !== 'ngram-mod') out.push({ label: 'N-gram lookahead', config: { ...base, spec: { type: 'ngram-mod' } } });
  // A same-tokenizer draft model, when the catalog has one and the planner didn't already pick it
  if (model.draft && base.spec.type !== 'draft-simple' && plan.fit === 'gpu') {
    out.push({ label: 'Draft model', config: { ...base, spec: { type: 'draft-simple', draftModelId: model.draft.modelId, draftQuantId: model.draft.quantId, nMax: 8, nMin: 1 } } });
  }
  // 8-bit KV saves memory but can cost decode speed on some backends; try full precision when there's room
  const headroom = plan.memory.gpuBudgetBytes - plan.memory.gpuBytes;
  if (base.kvTypeK === 'q8_0' && plan.fit === 'gpu' && headroom > plan.memory.kvBytes * 1.2) {
    out.push({ label: 'Full-precision KV cache', config: { ...base, kvTypeK: 'f16', kvTypeV: 'f16', flashAttn: 'auto' } });
  }
  if (base.workload === 'batch') {
    out.push({ label: '4 parallel slots', config: { ...base, parallel: 4 } });
  }
  if (base.nCpuMoe > 0 && !hw.unifiedMemory) {
    out.push({ label: `Micro-batch ${base.ubatch === 2048 ? 512 : 2048}`, config: { ...base, ubatch: base.ubatch === 2048 ? 512 : 2048 } });
  }
  if (plan.fit !== 'gpu' && hw.cpu.physicalCores > 4) {
    const t = Math.max(2, base.threads - 2);
    out.push({ label: `${t} threads`, config: { ...base, threads: t } });
  }
  if (base.flashAttn === 'auto' && model.arch.type === 'dense' && plan.fit === 'gpu') {
    out.push({ label: 'Flash attention forced on', config: { ...base, flashAttn: 'on' } });
  }
  return out.slice(0, opts.max ?? 6);
}

/** Helper for callers: MLX candidate info for a plan, if MLX is an option. */
export function mlxCandidateFor(model: CatalogModel, plan: Plan, estimateQuality: (bits: number) => number): CandidateOptions['mlx'] {
  const quant = model.quants.find((q) => q.id === plan.config.quantId);
  const v = quant ? closestMlx(model, quant.bpw) : undefined;
  return v ? { variantId: v.id, bits: v.bits, qualityPct: estimateQuality(v.bits) } : null;
}

export interface TuneOptions {
  engine: InstalledEngine;
  model: CatalogModel;
  candidates: TuneCandidate[];
  workload: Workload;
  /** Quality of the planner's quant, so MLX candidates can be compared fairly */
  baseQualityPct: number;
  /** Stop trying new candidates once this much time has passed (the first always runs) */
  budgetMs?: number;
  tokensPerPrompt?: number;
  /** Context available per request, to size the long-prompt test */
  ctxPerSlot: number;
  loadTimeoutMs: number;
  onTrialStart?: (c: TuneCandidate, index: number) => void;
  onTrial?: (r: TrialResult) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export async function runTrials(opts: TuneOptions): Promise<TrialResult[]> {
  const started = Date.now();
  const results: TrialResult[] = [];
  let bestRound1 = 0;
  for (let i = 0; i < opts.candidates.length; i++) {
    const c = opts.candidates[i];
    if (opts.signal?.aborted) throw new Error('Cancelled');
    if (i > 0 && Date.now() - started > (opts.budgetMs ?? 6 * 60_000)) {
      opts.onLog?.(`Time budget reached, skipping "${c.label}"`);
      break;
    }
    opts.onTrialStart?.(c, i);
    const r = await trial(opts, c, bestRound1);
    if (r.ok && r.genTps > bestRound1) bestRound1 = r.genTps;
    results.push(r);
    opts.onTrial?.(r);
  }
  return results;
}

const BASE_REQUEST = { chat_template_kwargs: { enable_thinking: false }, cache_prompt: false };

async function trial(opts: TuneOptions, c: TuneCandidate, bestSoFar: number): Promise<TrialResult> {
  const port = await freePort();
  const t0 = Date.now();
  let server: EngineProcess | null = null;
  const fail = (e: unknown): TrialResult => ({
    label: c.label,
    config: c.config,
    ok: false,
    error: (e as Error).message,
    genTps: 0,
    promptTps: 0,
    draftAcceptRate: null,
    loadMs: Date.now() - t0,
  });
  try {
    server = await createEngineProcess(opts.model, c.config, port, { llama: opts.engine });
    server.start();
    await server.waitReady(opts.loadTimeoutMs, opts.signal);
    const loadMs = Date.now() - t0;
    const base = `${server.url}/v1`;
    const n = opts.tokensPerPrompt ?? 256;
    const ask = (prompt: string, tokens: number, extra: Record<string, unknown> = {}) =>
      measureOpenAI(base, server!.requestModel, prompt, tokens, { ...BASE_REQUEST, ...extra }, opts.signal);

    await ask('Say hello.', 8); // warm-up, not counted

    // Round 1: greedy decoding
    const samples: Record<WorkloadKey, number[]> = { chat: [], code: [], edit: [] };
    const all: PromptResult[] = [];
    for (const p of tuneRound(0)) {
      const r = await ask(p.prompt, n);
      samples[p.key].push(r.genTps);
      all.push(r);
    }
    const round1 = weightedSpeed(summarise(samples), opts.workload);

    // Round 2: different prompts at temperature 0.7, unless this config is clearly slower than the best so far
    const pruned = bestSoFar > 0 && round1 < bestSoFar * 0.85;
    const sampled: number[] = [];
    if (!pruned) {
      for (const p of tuneRound(1)) {
        const r = await ask(p.prompt, n, { temperature: 0.7, seed: 42 });
        samples[p.key].push(r.genTps);
        sampled.push(r.genTps);
        all.push(r);
      }
    }
    const workloads = summarise(samples);
    const genTps = weightedSpeed(workloads, opts.workload);

    // Agent profile: how fast a long prompt is taken in, which is what coding tools wait on
    let longPromptResult: TrialResult['longPrompt'];
    if (opts.workload === 'agent' && !pruned) {
      const tokens = Math.max(1024, Math.min(6000, Math.floor(opts.ctxPerSlot * 0.6)));
      const r = await ask(longPrompt(tokens), 48);
      longPromptResult = { tokens: r.promptTokens ?? tokens, promptTps: r.promptTps ?? 0, ttftMs: r.ttftMs };
    }

    // Batch profile: total throughput with every slot busy
    let parallelTps: number | undefined;
    if (opts.workload === 'batch' && !pruned) {
      const slots = Math.max(1, c.config.parallel);
      const start = performance.now();
      const rs = await Promise.all(Array.from({ length: slots }, (_, k) => ask(PROMPT_POOLS.chat[k % PROMPT_POOLS.chat.length], 128)));
      const secs = (performance.now() - start) / 1000;
      parallelTps = Math.round((rs.reduce((s, r) => s + r.tokens, 0) / secs) * 10) / 10;
    }

    const drafted = all.reduce((s, r) => s + (r.draftN ?? 0), 0);
    const accepted = all.reduce((s, r) => s + (r.draftAccepted ?? 0), 0);
    const promptTps = Math.round(median(all.map((r) => r.promptTps ?? 0)));

    const result: TrialResult = {
      label: c.label,
      config: c.config,
      ok: true,
      genTps,
      promptTps,
      draftAcceptRate: drafted ? Math.round((accepted / drafted) * 100) / 100 : null,
      loadMs,
      workloads,
      sampledTps: sampled.length ? Math.round(median(sampled) * 10) / 10 : undefined,
      longPrompt: longPromptResult,
      parallelTps,
      pruned,
    };
    result.score = trialScore(result, opts.workload, c.qualityPct ?? opts.baseQualityPct);
    return result;
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    opts.onLog?.(`"${c.label}" failed: ${(e as Error).message.split('\n')[0]}`);
    return fail(e);
  } finally {
    await server?.stop();
  }
}

/** Per-workload median speed, and the spread across its runs. */
function summarise(samples: Record<WorkloadKey, number[]>): Partial<Record<WorkloadKey, { genTps: number; spread: number }>> {
  const out: Partial<Record<WorkloadKey, { genTps: number; spread: number }>> = {};
  for (const k of Object.keys(samples) as WorkloadKey[]) {
    const xs = samples[k].filter((x) => x > 0);
    if (!xs.length) continue;
    const med = median(xs);
    out[k] = { genTps: Math.round(med * 10) / 10, spread: xs.length > 1 ? Math.round(((Math.max(...xs) - Math.min(...xs)) / Math.max(0.1, med)) * 1000) / 1000 : 0 };
  }
  return out;
}

/**
 * What the winner is picked on, for the chosen workload, adjusted for quality so a
 * lower-precision MLX build can't win just by being smaller:
 *  chat  — workload-weighted generation speed
 *  agent — effective speed of a turn that starts with a long prompt (prefill + 256 tokens)
 *  batch — total throughput across parallel requests
 */
export function trialScore(r: TrialResult, workload: Workload, qualityPct: number): number {
  let s = r.genTps;
  if (workload === 'agent' && r.longPrompt && r.genTps > 0) {
    const turn = r.longPrompt.ttftMs / 1000 + 256 / r.genTps;
    s = 256 / turn;
  } else if (workload === 'batch' && r.parallelTps) {
    s = r.parallelTps;
  }
  return Math.round(s * qualityFactor(qualityPct) * 100) / 100;
}

/** Pick the winner, plus the best config for each kind of prompt (they can differ). */
export function pickWinner(results: TrialResult[]): { winner: TrialResult | null; bestPerWorkload: Partial<Record<WorkloadKey, string>> } {
  const ok = results.filter((r) => r.ok);
  const winner = [...ok].sort((a, b) => (b.score ?? b.genTps) - (a.score ?? a.genTps))[0] ?? null;
  const bestPerWorkload: Partial<Record<WorkloadKey, string>> = {};
  for (const k of ['chat', 'code', 'edit'] as WorkloadKey[]) {
    const best = [...ok].filter((r) => r.workloads?.[k]).sort((a, b) => b.workloads![k]!.genTps - a.workloads![k]!.genTps)[0];
    if (best) bestPerWorkload[k] = best.label;
  }
  return { winner, bestPerWorkload };
}
