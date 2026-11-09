# Benchmarks

Every `localmax run` (or **Tune & run** in the app) writes a JSON record to
`~/.localmax/benchmarks/` with the hardware summary, the planner's prediction,
every configuration tried and the winner. Copy records here to keep them in the repo.

## Phase 1 proof test (still to do)

On the reference rig (RTX 3090 + 64 GB DDR4), for **gpt-oss-120b** and **Qwen3.6-27B**:

| Setup | How to run | Record |
|---|---|---|
| Ollama defaults | `ollama run <model>` and read `eval rate` with `--verbose` | `proof/<model>-ollama.json` |
| Hand-tuned llama.cpp | Best manual `llama-server` command you can find | `proof/<model>-handtuned.json` |
| localmax | `localmax run <model>` | copy from `~/.localmax/benchmarks/` |

Use the same prompts as the tuner (`STANDARD_PROMPTS` in `packages/core/src/tuner/tuner.ts`)
and the same context length (16K) for all three.

Planner predictions for that rig (from the test fixture, before measurement):

| Model | Plan | Predicted |
|---|---|---|
| gpt-oss-120b | MXFP4, `--n-cpu-moe 25`, 773 MiB expert cache, EAGLE3 head | ~19 tok/s |
| Qwen3.6-27B | UD-Q5_K_XL fully on GPU, Qwen3.5-0.8B draft | ~42 tok/s |
