#!/usr/bin/env node
// Builds packages/core/catalog/models.json from live Hugging Face data.
// File sizes, SHA256 checksums and architecture numbers are pulled from the
// GGUF repo and the base model's config.json, so nothing here is guessed
// except the human-written blurbs and tags.
//
//   node scripts/build-catalog.mjs
//
// Set HF_TOKEN if you hit rate limits.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages/core/catalog/models.json');

/** Hand-curated launch list. Order = display order within a tier. */
const MODELS = [
  // Small: runs on almost anything, good for first run and as draft models
  {
    id: 'qwen3.5-0.8b', name: 'Qwen3.5 0.8B', vendor: 'Qwen', repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    tier: 'small', tags: ['chat', 'draft'],
    blurb: 'Tiny and quick. Great first test of your setup, and a draft model for bigger Qwen models.',
  },
  {
    id: 'qwen3-0.6b', name: 'Qwen3 0.6B', vendor: 'Qwen', repo: 'unsloth/Qwen3-0.6B-GGUF',
    tier: 'small', tags: ['draft'],
    blurb: 'Tiny Qwen3 model. Mainly here as a draft model that speeds up bigger Qwen3 models.',
  },
  {
    id: 'qwen3.5-4b', name: 'Qwen3.5 4B', vendor: 'Qwen', repo: 'unsloth/Qwen3.5-4B-GGUF',
    tier: 'small', tags: ['chat', 'reasoning'],
    blurb: 'Surprisingly capable for its size. Fast on laptops with 8 GB or more.',
    draft: { modelId: 'qwen3.5-0.8b', quantId: 'Q8_0' },
  },
  {
    id: 'qwen3-4b-2507', name: 'Qwen3 4B 2507', vendor: 'Qwen', repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    tier: 'small', tags: ['chat', 'compare'],
    blurb: 'Solid small model on a long-established architecture, so every app can run it. The best choice for comparing engines head to head.',
    draft: { modelId: 'qwen3-0.6b', quantId: 'Q8_0' },
  },
  {
    id: 'gemma-4-e4b', name: 'Gemma 4 E4B', vendor: 'Google', repo: 'unsloth/gemma-4-E4B-it-GGUF',
    tier: 'small', tags: ['chat', 'multilingual'],
    blurb: 'Google’s on-device model. Strong writing and multilingual chat in a small footprint.',
  },
  {
    id: 'qwen3.5-9b', name: 'Qwen3.5 9B', vendor: 'Qwen', repo: 'unsloth/Qwen3.5-9B-GGUF',
    tier: 'small', tags: ['chat', 'coding', 'reasoning'],
    blurb: 'The sweet spot for 16 GB machines. Solid coding and reasoning.',
    draft: { modelId: 'qwen3.5-0.8b', quantId: 'Q8_0' },
  },
  // Dense, fits a 24 GB card
  {
    id: 'qwen3.6-27b', name: 'Qwen3.6 27B', vendor: 'Qwen', repo: 'unsloth/Qwen3.6-27B-GGUF',
    tier: 'dense', tags: ['chat', 'coding', 'reasoning'],
    blurb: 'Best all-rounder for a 24 GB card. Dense, so every weight works on every token.',
    draft: { modelId: 'qwen3.5-0.8b', quantId: 'Q8_0' },
  },
  {
    id: 'mistral-small-3.2-24b', name: 'Mistral Small 3.2 24B', vendor: 'Mistral', repo: 'unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF',
    tier: 'dense', tags: ['chat', 'tools'],
    blurb: 'Reliable instruction follower with good tool calling. Plain attention, easy to fit.',
  },
  // MoE that fits in VRAM
  {
    id: 'qwen3.6-35b-a3b', name: 'Qwen3.6 35B-A3B', vendor: 'Qwen', repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
    tier: 'moe', tags: ['chat', 'coding', 'reasoning'],
    blurb: 'Mixture of experts with only 3B active per token, so it is very fast once it fits.',
  },
  {
    id: 'gpt-oss-20b', name: 'gpt-oss 20B', vendor: 'OpenAI', repo: 'ggml-org/gpt-oss-20b-GGUF',
    tier: 'moe', tags: ['chat', 'reasoning', 'tools'],
    blurb: 'OpenAI’s open-weight reasoner, shipped natively in MXFP4. Nothing to lose by quantising.',
    override: { totalParamsB: 20.9, activeParamsB: 3.6 },
  },
  {
    id: 'gemma-4-26b-a4b', name: 'Gemma 4 26B-A4B', vendor: 'Google', repo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
    tier: 'moe', tags: ['chat', 'multilingual'],
    blurb: 'Google’s mid-size MoE. 4B active, strong writing quality.',
  },
  // Big MoE, needs RAM offload
  {
    id: 'gpt-oss-120b', name: 'gpt-oss 120B', vendor: 'OpenAI', repo: 'ggml-org/gpt-oss-120b-GGUF',
    tier: 'big', tags: ['chat', 'reasoning', 'tools'],
    blurb: 'The big one from OpenAI. Expert offload to RAM is what makes this run on a single GPU.',
    override: { totalParamsB: 116.8, activeParamsB: 5.1 },
  },
  {
    id: 'glm-4.5-air', name: 'GLM-4.5-Air', vendor: 'Z.ai', repo: 'unsloth/GLM-4.5-Air-GGUF',
    tier: 'big', tags: ['chat', 'coding', 'agents'],
    blurb: '106B MoE with 12B active. Excellent agentic coder if you have the RAM.',
  },
  {
    id: 'qwen3-next-80b-a3b', name: 'Qwen3-Next 80B-A3B', vendor: 'Qwen', repo: 'unsloth/Qwen3-Next-80B-A3B-Instruct-GGUF',
    tier: 'big', tags: ['chat', 'long-context'],
    blurb: 'Hybrid linear attention, so long contexts cost very little memory.',
  },
  {
    id: 'qwen3.5-122b-a10b', name: 'Qwen3.5 122B-A10B', vendor: 'Qwen', repo: 'unsloth/Qwen3.5-122B-A10B-GGUF',
    tier: 'big', tags: ['chat', 'coding', 'reasoning'],
    blurb: 'Frontier-class open MoE. Needs a lot of RAM; the planner decides what lives where.',
  },
  {
    id: 'qwen3.8-flash-next', name: 'Qwen3.8 Flash-Next', vendor: 'Qwen', repo: 'unsloth/Qwen3.8-Flash-Next-GGUF',
    tier: 'big', tags: ['chat', 'coding', 'reasoning'],
    blurb: 'Huge sparse MoE built for speed. Verify llama.cpp support for your engine build before relying on it.',
    experimental: true,
    // Repo config numbers don't add up to the file sizes; active count from the model card
    override: { activeParamsB: 6 },
  },
];

/** Quant ids we surface, best quality first. UD- variants are preferred when both exist. */
const QUANT_PREFERENCE = [
  'MXFP4', 'MXFP4_MOE',
  'Q8_0', 'UD-Q6_K_XL', 'Q6_K', 'UD-Q5_K_XL', 'Q5_K_M', 'UD-Q4_K_XL', 'Q4_K_M', 'UD-Q4_K_M', 'IQ4_XS', 'UD-IQ4_XS',
  'UD-Q3_K_XL', 'Q3_K_M', 'UD-Q3_K_M', 'UD-IQ3_S', 'UD-IQ3_XXS', 'UD-Q2_K_XL', 'UD-IQ2_M', 'UD-IQ1_M',
];
const MAX_QUANTS = 11;

const headers = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    if (res.status === 404 || res.status === 401) return null;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`Failed to fetch ${url}`);
}

async function listGguf(repo) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const p = stack.pop();
    const tree = await getJson(`https://huggingface.co/api/models/${repo}/tree/main/${p}`);
    for (const f of tree ?? []) {
      if (f.type === 'directory') stack.push(f.path);
      else if (f.path.endsWith('.gguf')) out.push({ path: f.path, size: f.size, sha256: f.lfs?.oid ?? null });
    }
  }
  return out;
}

const QUANT_RE = /(UD-)?(MXFP4_MOE|MXFP4|IQ\d_[A-Z0-9]+(?:_[A-Z]+)?|Q\d_K_[A-Z]+|Q\d_K|Q\d_\d|BF16|F16)/i;

function groupQuants(files) {
  const groups = new Map();
  for (const f of files) {
    const name = f.path.split('/').pop();
    if (/mmproj|imatrix|^mtp-|^eagle3-/i.test(name)) continue;
    const m = name.match(QUANT_RE);
    if (!m) continue;
    const id = m[0].toUpperCase().replace(/^UD-/, 'UD-');
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(f);
  }
  for (const [id, fs] of groups) {
    fs.sort((a, b) => a.path.localeCompare(b.path));
    // Split files must all share one "-0000N-of-0000M" family
    const shards = fs.filter((f) => /-\d{5}-of-\d{5}\.gguf$/.test(f.path));
    if (shards.length && shards.length !== fs.length) groups.set(id, shards);
  }
  return groups;
}

function archFrom(cfg, totalParams) {
  const t = cfg?.text_config ?? cfg ?? {};
  const layers = t.num_hidden_layers;
  const experts = t.num_experts ?? t.num_local_experts ?? t.n_routed_experts ?? 0;
  const k = t.num_experts_per_tok ?? t.top_k_experts ?? 0;
  const layerTypes = Array.isArray(t.layer_types) ? t.layer_types : null;
  let fullAttn = layers, swa = 0, linear = 0;
  if (layerTypes) {
    fullAttn = layerTypes.filter((x) => /full/.test(x)).length;
    const slide = layerTypes.filter((x) => /slid/.test(x)).length;
    swa = slide;
    linear = layerTypes.length - fullAttn - slide;
  } else if (t.full_attention_interval) {
    fullAttn = Math.floor(layers / t.full_attention_interval);
    linear = layers - fullAttn;
  }
  const headDim = t.head_dim ?? Math.round(t.hidden_size / t.num_attention_heads);
  const moeLayers = experts ? layers - (t.first_k_dense_replace ?? 0) : 0;
  const expertInter = t.moe_intermediate_size ?? t.intermediate_size;
  const expertParams = experts ? moeLayers * experts * 3 * t.hidden_size * expertInter : 0;
  const expertFraction = experts ? Math.min(0.97, expertParams / totalParams) : 0;
  const activeParams = experts ? totalParams - expertParams * (1 - k / experts) : totalParams;
  return {
    type: experts ? 'moe' : 'dense',
    layers,
    hidden: t.hidden_size,
    vocab: t.vocab_size ?? cfg?.vocab_size,
    kvHeads: t.num_key_value_heads,
    headDim,
    fullAttnLayers: fullAttn,
    swaLayers: swa,
    linearAttnLayers: linear,
    slidingWindow: swa ? t.sliding_window ?? null : null,
    experts,
    expertsPerToken: k,
    moeLayers,
    expertFraction: Number(expertFraction.toFixed(4)),
    totalParamsB: Number((totalParams / 1e9).toFixed(2)),
    activeParamsB: Number((activeParams / 1e9).toFixed(2)),
    maxContext: t.max_position_embeddings ?? 32768,
  };
}

/** Speculative-decoding heads shipped alongside the weights (EAGLE3 drafts, MTP heads). */
function pickSpecHead(files) {
  const heads = files.filter((f) => /(^|\/)(eagle3|mtp)-/i.test(f.path) && !/shared/i.test(f.path));
  const best = heads.find((f) => /Q8_0/i.test(f.path)) ?? heads[0];
  if (!best) return null;
  return {
    type: /eagle3/i.test(best.path) ? 'draft-eagle3' : 'draft-mtp',
    file: { path: best.path, size: best.size, sha256: best.sha256 },
  };
}

/** Standard mlx-community builds (<BaseName>-4bit etc.) of the same base model, for Apple Silicon. */
async function findMlx(base) {
  if (!base) return [];
  const name = base.split('/').pop();
  const out = [];
  for (const bits of [4, 5, 6, 8]) {
    for (const candidate of [`mlx-community/${name}-${bits}bit`, `mlx-community/${name.toLowerCase()}-${bits}bit`]) {
      const meta = await getJson(`https://huggingface.co/api/models/${candidate}`);
      if (!meta) continue;
      const tree = (await getJson(`https://huggingface.co/api/models/${candidate}/tree/main`)) ?? [];
      const files = tree
        .filter((f) => f.type === 'file' && !/^(README|\.gitattributes)/i.test(f.path))
        .map((f) => ({ path: f.path, size: f.size, sha256: f.lfs?.oid ?? null }));
      if (!files.some((f) => f.path.endsWith('.safetensors'))) continue;
      out.push({ id: `${bits}bit`, bits, repo: candidate, sizeBytes: files.reduce((s, f) => s + f.size, 0), files });
      break;
    }
  }
  return out;
}

async function buildModel(spec) {
  const [meta, files] = await Promise.all([getJson(`https://huggingface.co/api/models/${spec.repo}`), listGguf(spec.repo)]);
  let base = meta?.cardData?.base_model;
  if (Array.isArray(base)) base = base[0];
  const cfg = base ? await getJson(`https://huggingface.co/${base}/raw/main/config.json`) : null;
  const groups = groupQuants(files);
  const sizeOf = (id) => (groups.get(id) ?? []).reduce((s, f) => s + f.size, 0);
  // Total parameters: BF16 is 2 bytes/param; else Q8_0 is ~1.0625 bytes/param
  let totalParams = sizeOf('BF16') / 2;
  if (!totalParams || totalParams < 3e8) totalParams = sizeOf('Q8_0') / 1.0625;
  if (!totalParams || totalParams < 3e8) totalParams = sizeOf('MXFP4') / 0.53; // gpt-oss: MXFP4 ~4.25 bpw on experts
  if (spec.override?.totalParamsB) totalParams = spec.override.totalParamsB * 1e9;
  const arch = archFrom(cfg, totalParams);
  if (spec.override?.activeParamsB && arch.experts) {
    // Solve active = nonExpert + expertTotal * k/E for the expert share
    const r = arch.expertsPerToken / arch.experts;
    const active = spec.override.activeParamsB * 1e9;
    const nonExpert = Math.max(0, (active - totalParams * r) / (1 - r));
    arch.expertFraction = Number(((totalParams - nonExpert) / totalParams).toFixed(4));
    arch.activeParamsB = spec.override.activeParamsB;
  }
  const specHead = pickSpecHead(files);
  const mlx = await findMlx(base);

  const quants = [];
  for (const id of QUANT_PREFERENCE) {
    if (!groups.has(id)) continue;
    // Skip the plain variant when the Unsloth Dynamic one exists at the same level
    const level = id.match(/^(I?Q\d)/)?.[1];
    if (!id.startsWith('UD-') && id !== 'Q8_0' && level && [...groups.keys()].some((g) => g.startsWith(`UD-${level}`))) continue;
    // UD-Qn_K_M is near-identical to UD-Qn_K_XL; keep only the XL
    if (/^UD-Q\d_K_M$/.test(id) && groups.has(id.replace(/_M$/, '_XL'))) continue;
    const fs = groups.get(id);
    const size = fs.reduce((s, f) => s + f.size, 0);
    if (size < 0.15 * totalParams) continue; // not a real full-model file
    quants.push({
      id,
      sizeBytes: size,
      bpw: Number(((size * 8) / totalParams).toFixed(2)),
      native: /MXFP4/.test(id) && spec.id.startsWith('gpt-oss'),
      files: fs.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    });
    if (quants.length >= MAX_QUANTS) break;
  }
  if (!quants.length) throw new Error(`No usable quants for ${spec.repo}`);
  return {
    id: spec.id,
    name: spec.name,
    vendor: spec.vendor,
    repo: spec.repo,
    baseRepo: base ?? null,
    tier: spec.tier,
    tags: spec.tags,
    blurb: spec.blurb,
    experimental: !!spec.experimental,
    draft: spec.draft ?? null,
    specHead,
    arch,
    quants,
    mlx,
  };
}

const models = [];
for (const spec of MODELS) {
  process.stdout.write(`  ${spec.repo} ... `);
  const m = await buildModel(spec);
  models.push(m);
  console.log(`${m.arch.type}, ${m.arch.totalParamsB}B total / ${m.arch.activeParamsB}B active, ${m.quants.length} quants, MLX: ${m.mlx.map((x) => x.id).join(' ') || 'none'}`);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), models }, null, 1) + '\n');
console.log(`\nWrote ${models.length} models to ${OUT}`);
