# localmax

Run open LLMs locally, tuned to your exact hardware for the most tokens per second without losing quality. And it shows you the numbers to prove it.

```bash
npx localmax          # opens the app at http://127.0.0.1:4747
```

> Working name. Not published to npm yet (see "Open decisions" below).

## What it does

1. **Profiles your machine.** GPU, VRAM, unified memory and Metal's wired limit, RAM bandwidth, CPU cores, PCIe link, disk.
2. **Plans every model for it.** It picks the quant, puts the weights on the GPU or in RAM (`--n-cpu-moe` expert offload for MoE models, layer offload for dense ones), sets the expert cache size, KV cache type, context, threads and batch sizes, and chooses a speculative decoding strategy (EAGLE3/MTP heads, a same-tokenizer draft model, or n-gram lookahead). Every decision comes with a plain-English reason in the UI.
3. **Tunes on first run.** It benchmarks a few candidate configs with a fixed prompt set, keeps the fastest and logs everything to `~/.localmax/benchmarks/`.
4. **Serves it.** You get an OpenAI-compatible API at `http://127.0.0.1:4747/v1`, plus chat and a live monitor in the browser.

## Commands

| Command | |
|---|---|
| `localmax` | Start the app and open the browser |
| `localmax doctor` | Hardware profile (`--json` for raw) |
| `localmax models` | What can I run? Predicted speed for every catalog model |
| `localmax plan <model>` | Explain the setup, with the exact llama-server command |
| `localmax pull <model>` | Download (resumable, SHA256-verified) |
| `localmax run <model>` | Plan → download → tune → serve |
| `localmax engine install [--latest]` | Install llama.cpp (pinned to the tested build by default) |
| `localmax compare <model> [--best]` | Head-to-head vs stock llama.cpp, LM Studio and Ollama (same GGUF, or each engine's best setup) |
| `localmax quality <model>` | Measure a quant's quality (KL divergence vs the Q8_0 reference) |
| `localmax engine install --mlx` | Install the MLX engine (Apple Silicon) |
| `localmax benchmarks` | Past tuning runs |

Goals: `--goal speed|balanced|quality`, context: `--ctx 32768`, force a quant: `--quant UD-Q4_K_XL`, workload: `--workload chat|agent|batch`, also benchmark MLX: `run --mlx`.

## How tuning and quality work

- **Workload profiles.** `chat` (one conversation), `agent` (coding tools: 2 slots sharing one KV cache, `--cache-reuse 256`, prompt caches saved to disk on idle unload and restored on reload) or `batch` (8 slots for throughput). Each profile has its own winner metric: chat on time-weighted generation speed, agent on a whole turn including a long-prompt prefill, batch on parallel throughput.
- **The tuner** measures every candidate with chat, code and edit prompts, two rounds (the second at temperature 0.7), 256 tokens each, never repeating a prompt (n-gram lookahead remembers earlier output and would otherwise replay it). Clearly slower configs stop after one round. Candidates include the planner pick, no/ n-gram/ draft-model speculation, full-precision KV, and on Macs an MLX build of similar precision. The winner is chosen on quality-adjusted score, and the best config for each kind of prompt is reported too.
- **Quality** is `100 × e^(−mean KL divergence)` against the full model. Where the Q8_0 reference fits in free memory, `llama-perplexity` measures it on a built-in original text; otherwise it's estimated from typical KLD per quant type (labelled "est.").
- **Calibration.** Each tuning run stores measured ÷ predicted base speed per backend, architecture and placement in `~/.localmax/calibration.json`, and future predictions are scaled by it.
- **MLX (Apple Silicon).** Installed into `~/.localmax/engines/mlx` with a pinned, checksum-verified `uv` and its own Python, never touching the system. The MLX build closest in precision to the chosen quant is benchmarked against llama.cpp.
- **GPU memory limit (Apple Silicon).** Machine → GPU memory limit raises `iogpu.wired_limit_mb` (macOS asks for your password; it resets on reboot) so bigger models fit on the GPU.

## Comparing against LM Studio and Ollama

The **Compare** page (or `localmax compare <model>`) runs the *same GGUF file* in each engine, one at a time:

- **localmax (tuned)**: the configuration the tuner picked for this machine
- **llama.cpp defaults**: `llama-server -m model -c <ctx>` and nothing else, the baseline LM Studio and Ollama build on
- **LM Studio**: linked into LM Studio with `lms import --symbolic-link` (no copy), loaded with `lms load --context-length`, unloaded afterwards; the server is stopped again if localmax started it
- **Ollama**: imported with `/api/create` (Ollama keeps its own copy), run through the native API so `num_ctx` matches, unloaded with `keep_alive: 0`

Every engine gets the same prompts (prose, new code, a code edit), temperature 0, thinking off where supported, a warm-up request, and 3 rounds per prompt. Speed is timed on the token stream by one stopwatch for all engines (cross-checked against each engine's own figure where it reports one). Results show the median and spread, and a difference inside the run-to-run noise is reported as "same speed", not a win. The test refuses to start if the model doesn't fit in free memory, because swapping would wreck the numbers.

Records are saved as `~/.localmax/benchmarks/compare_*.json`.

## Layout

```
packages/core   profiler · catalog · planner · engine manager · downloader · tuner · monitor
packages/cli    `localmax` binary: Hono server, /api for the UI, /v1 proxy to llama-server
packages/ui     Vite + React app, built into packages/cli/dist/ui
scripts/build-catalog.mjs   regenerates the catalog from live Hugging Face data
```

Everything localmax writes goes in `~/.localmax/` (override with `LOCALMAX_HOME`).

## Development

```bash
npm install
npm run dev        # API on :4747 (tsx watch) + Vite UI on :5173
npm test           # Vitest: planner tested against fake 3090 / 3060 / M3 / CPU-only profiles
npm run build      # UI + bundled CLI → packages/cli/dist
npm start          # run the built CLI
npm run catalog    # refresh sizes, checksums and architecture from Hugging Face
```

## Notes on the engine

- Stock llama.cpp binaries, pinned to **b12202**, downloaded from GitHub releases via the API asset endpoint and checked against GitHub's SHA256 digest.
- Every flag in `buildServerArgs` was checked against b12202's `common/arg.cpp`. Upstream has removed `--draft-max/--draft-min`, so we use `--spec-draft-n-max/--spec-draft-n-min`, and draft models need `--spec-type draft-simple`.
- Quality is **estimated** from the quant type in Phase 1 (labelled "est." in the UI). Phase 2 replaces it with measured KL divergence against reference logits.

## Open decisions (need Noel)

- Final product and npm package name (`localmax` is a placeholder)
- Licence
- Free forever or a paid tier later
- Test machines beyond the 3090 + 64 GB rig
