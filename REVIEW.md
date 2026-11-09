# localmax: architecture review and next steps

Review date: 8 Nov 2026. Based on the code in this folder and the M3 Pro compare results (Qwen3 4B 2507: localmax 34.1 tok/s, plain llama.cpp 33.0, LM Studio 31.9).

## TL;DR

The build is solid. The planner explains itself, the compare page is honest and the engine plumbing is clean. The small gain isn't a bug, it's what the current design can do on this test:

1. **The test removes localmax's biggest lever.** Compare pins every engine to the same GGUF (`compare.ts`, `quantId: quant.id`), so the planner's quant choice is switched off.
2. **A small dense model that fits in memory is the one case where tuning can't help.** Every llama.cpp-based engine hits the same memory-bandwidth ceiling (150 GB/s on an M3 Pro). The only thing that can beat that ceiling is speculative decoding, and Qwen3 4B 2507 has no draft model in the catalog.
3. **localmax is only wrapping stock llama.cpp so far.** The differentiators in PLAN.md (custom mixed quants, usage-aware 3/4-bit, Shadow Experts) aren't built yet, so there's nothing extra to win on a model that already fits.
4. **On Macs, the competition has moved to MLX.** Ollama switched its Apple Silicon engine to MLX in March 2026, and LM Studio has an MLX engine too. Public benchmarks put MLX roughly 15 to 35% ahead of llama.cpp Metal on decode for modern models. A llama.cpp-only localmax will lose on Macs against Ollama's MLX path, whatever we tune.

## 1. Quick fixes (tuner and testing)

These make the numbers trustworthy before we chase bigger wins.

| # | Where | Problem | Fix |
|---|---|---|---|
| 1.1 | `tuner.ts` `STANDARD_PROMPTS` | Prompt 3 is a copy-back edit, which is perfect for n-gram lookahead. It inflates acceptance (95% on the M3) and can crown n-gram as the winner when it's slower in normal chat. | Score each prompt type separately. Store a winner per workload (chat, code, edit) or weight towards chat. Add 2 or 3 more varied prompts. |
| 1.2 | `tuner.ts` `trial()` | 96 tokens per prompt, one run per candidate, temperature 0. Too short and noisy to separate configs a few % apart, and spec decoding acceptance drops at real sampling temperatures. | 256+ tokens per prompt, 2 to 3 rounds, report median and spread (reuse the compare page's noise logic). Run one round at temperature 0.7. |
| 1.3 | `session.ts` winner pick | Winner is `genTps` only. Prompt speed and time to first token are ignored, which matters most for agents and long contexts. | Pick by a workload score: chat = gen speed, agent/RAG = prompt speed + TTFT weighted higher. |
| 1.4 | `quality.ts` | Quality is still a lookup table, so the headline "99.5%" is a guess. | For small models (anything where BF16 or Q8 fits in memory), measure KL divergence locally now with `llama-perplexity` against the Q8/BF16 file. Keep the estimate only for models too big for that. |
| 1.5 | `planner.ts` constants | `GPU_EFFICIENCY`, `MOE_EFFICIENCY`, overheads are hand-calibrated and never updated. | After every tuning run, store measured ÷ predicted per machine and backend, and scale future predictions by it. The "what can I run" list gets more accurate the more you use it. |
| 1.6 | `catalog/models.json` | Most small dense models have `draft: null`. | Add same-tokenizer drafts where they exist (e.g. Qwen3 0.6B for Qwen3 4B/8B, Qwen3.5 0.8B for Qwen3.5 4B/9B). The tuner already drops them if they don't help. |
| 1.7 | Compare page | Only tests a fixed quant. | Add a second mode: "Same model, each engine's best setup", where localmax picks its own quant and is scored on speed × measured quality. That's the real-world comparison users care about. |

## 2. Where the big wins actually are

### 2.1 Mac: add an MLX backend (biggest single win)
- Add `mlx` as a second backend next to llama.cpp. The planner and tuner already think in terms of candidate configs, so "llama.cpp vs MLX" is just another dimension for the tuner to measure.
- Keeps the npm-only install: download a `uv` binary on first run (same pattern as the llama.cpp engine manager), then `uv tool install mlx-lm` into `~/.localmax/engines/mlx/` and run `mlx_lm.server` (OpenAI-compatible) as the child process.
- Catalog needs MLX repos per model (mlx-community publishes most), with sizes and checksums from `build-catalog.mjs`.
- Then compare against Ollama on its MLX path, not just LM Studio's old llama.cpp engine.

### 2.2 Mac: Metal wired-limit unlock
- The profiler already reads `iogpu.wired_limit_mb` and defaults to 2/3 of RAM on machines up to 36 GB, so roughly 12 GB of your 18 GB.
- Add a guided one-click "Let the GPU use more memory" step (needs `sudo sysctl iogpu.wired_limit_mb=…`, resets on reboot, explain that clearly). On an 18 GB Mac that's the difference between gpt-oss-20b fitting fully on the GPU or not.

### 2.3 Show off on MoE models, not small dense ones
- MoE is where planning matters: only ~3 to 4B parameters are active per token, so gpt-oss-20b or Qwen3.6-35B-A3B (low quant) can run as fast as or faster than a dense 4B while being much smarter.
- On the M3 Pro: try gpt-oss-20b after the wired-limit unlock. On the 3090: gpt-oss-120b and Qwen3.5-122B with expert offload vs Ollama and LM Studio defaults. That's where 1.5x+ gains are realistic, because the defaults offload badly.

## 3. Architecture improvements

### 3.1 Workload profiles
`-np 1` is hardcoded in `buildServerArgs`. That's right for single-user chat but wrong for:
- **Agents** (Claude Code, OpenCode etc. send parallel and long requests): 2 to 4 slots, prompt caching on, `--cache-reuse`, bigger context.
- **Batch jobs**: many slots for total throughput (several times the single-stream tok/s).

Make the workload an input to the planner (chat / agent / batch) with its own tuner prompts and winner metric.

### 3.2 Prompt caching for agents
- Coding agents resend a huge system prompt and file context every turn. Prefill, not generation, is what users wait on.
- Keep KV cache reuse on (`cache_prompt` is turned off in the tuner, which is right for benchmarking but make sure it's on in serving), and look at saving slots to disk for common system prompts so a cold start doesn't reprocess 20k tokens.
- Add a "long prompt" benchmark (8k to 32k tokens) to the tuner for the agent profile.

### 3.3 Backend abstraction
`LlamaServer` is llama.cpp-specific. Introduce an `EngineBackend` interface (install, buildArgs, start, waitReady, timings, stop) with `llamacpp` and `mlx` implementations. The fork from Phase 4 becomes a third implementation, so it never disturbs the stable path.

### 3.4 Keep the fork plan, but gate it on data
Custom per-layer quants (Phase 3) and usage-aware 3/4-bit experts only pay off for models that **don't** fit. Start Phase 3 once 2.3 shows where offloaded models are bottlenecked on your 3090.

## 4. Suggested order

1. Quick fixes 1.1 to 1.3 (trustworthy tuner), then 1.6 drafts and 1.5 calibration
2. 1.4 measured quality for small models
3. 2.2 wired-limit unlock + 2.3 MoE benchmarks on both machines
4. 3.3 backend abstraction, then 2.1 MLX backend
5. 3.1 workload profiles + 3.2 agent prompt caching (also sets up the "connect your tools" features)
6. 1.7 "best setup" compare mode, then Phase 3 custom quants
